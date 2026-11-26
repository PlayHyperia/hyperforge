import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuelBettingBridge } from "../../../../src/systems/DuelScheduler/DuelBettingBridge.js";
import { Logger } from "../../../../src/systems/ServerNetwork/services/index.js";

function createMockWorld() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as Parameters<typeof DuelBettingBridge>[0];
}

type DuelBettingBridgeTestHarness = DuelBettingBridge & {
  handleDuelScheduled(payload: unknown): Promise<void>;
  handleStreamingAnnouncement(payload: unknown): Promise<void>;
  handleStreamingFightStart(payload: unknown): Promise<void>;
  handleStreamingResolution(payload: unknown): Promise<void>;
  handleStreamingAbort(payload: unknown): Promise<void>;
  handleDuelResult(payload: unknown): Promise<void>;
  reconcileLiveCycle(): Promise<void>;
  runScheduledReconciliation(): Promise<void>;
  createOrSyncMarket(payload: unknown): Promise<void>;
  resolveMarket(...args: unknown[]): Promise<void>;
  solanaOperator: {
    isEnabled(): boolean;
    initRound: (...args: unknown[]) => Promise<unknown>;
    lockMarket: (...args: unknown[]) => Promise<unknown>;
    reportAndResolve: (...args: unknown[]) => Promise<unknown>;
  } | null;
  reconcileTimer: ReturnType<typeof setTimeout> | null;
  reconcileInFlight: boolean;
};

function asTestHarness(
  bridge: DuelBettingBridge,
): DuelBettingBridgeTestHarness {
  return bridge as unknown as DuelBettingBridgeTestHarness;
}

function makeCycle(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    cycleId: "cycle-123",
    phase: "ANNOUNCEMENT",
    duelId: "duel-123",
    duelKeyHex:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    agent1: {
      characterId: "agent-a",
      name: "Agent A",
    },
    agent2: {
      characterId: "agent-b",
      name: "Agent B",
    },
    betOpenTime: 1_000,
    betCloseTime: 2_000,
    cycleStartTime: 500,
    phaseStartTime: 500,
    duelEndTime: null,
    winnerId: null,
    loserId: null,
    outcome: null,
    winReason: null,
    seed: null,
    replayHash: null,
    arenaId: null,
    countdownValue: null,
    arenaPositions: null,
    ...overrides,
  };
}

describe("DuelBettingBridge streaming reconciliation", () => {
  let world: ReturnType<typeof createMockWorld>;
  let bridge: DuelBettingBridge;
  let bridgeHarness: DuelBettingBridgeTestHarness;
  let scheduler: {
    getCurrentCycle: () => ReturnType<typeof makeCycle> | null;
  } | null;

  beforeEach(() => {
    vi.useFakeTimers();
    world = createMockWorld();
    scheduler = null;
    bridge = new DuelBettingBridge(world as never, {
      getStreamingDuelScheduler: () => scheduler as never,
    });
    bridgeHarness = asTestHarness(bridge);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a market from streaming announcement data using the live duel key", async () => {
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    const market = bridge.getMarket("duel-123");
    expect(market).not.toBeNull();
    expect(market?.duelKeyHex).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(market?.roundSeedHex).toBe(market?.duelKeyHex);
    expect(market?.status).toBe("betting");
    expect(world.emit).toHaveBeenCalledWith(
      "betting:market:created",
      expect.objectContaining({
        duelId: "duel-123",
        source: "streaming",
        market: expect.objectContaining({
          duelKeyHex:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      }),
    );
  });

  it("treats the exact legacy schedule echo as a no-op for a streaming market", async () => {
    const canonicalDuelKey =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    await bridgeHarness.handleDuelScheduled({
      duelId: "duel-123",
      agent1Id: "agent-a",
      agent2Id: "agent-b",
      agent1Name: "Agent A",
      agent2Name: "Agent B",
      startTime: 2_000,
    });

    expect(bridge.getMarket("duel-123")).toEqual(
      expect.objectContaining({
        source: "streaming",
        duelKeyHex: canonicalDuelKey,
        agent1Id: "agent-a",
        agent2Id: "agent-b",
        bettingClosesAt: 2_000,
      }),
    );
    expect(world.emit).not.toHaveBeenCalledWith(
      "betting:market:synchronization-rejected",
      expect.anything(),
    );
  });

  it("ignores malformed announcement payloads instead of creating a market", async () => {
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      agent1: { id: "agent-a", name: "Agent A" },
    });

    expect(bridge.getMarket("duel-123")).toBeNull();
    expect(world.emit).not.toHaveBeenCalledWith(
      "betting:market:created",
      expect.anything(),
    );
  });

  it("serializes concurrent market creation so initRound runs only once per duel", async () => {
    const solanaOperator = {
      isEnabled: () => true,
      initRound: vi.fn().mockResolvedValue({
        closeSlot: 123,
        initOracleSignature: "oracle-sig",
        initMarketSignature: "market-sig",
      }),
      lockMarket: vi.fn().mockResolvedValue(null),
      reportAndResolve: vi.fn().mockResolvedValue(null),
    };
    bridgeHarness.solanaOperator = solanaOperator;

    const params = {
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent1Id: "agent-a",
      agent2Id: "agent-b",
      agent1Name: "Agent A",
      agent2Name: "Agent B",
      bettingClosesAt: 2_000,
      source: "streaming" as const,
    };

    await Promise.all([
      bridgeHarness.createOrSyncMarket(params),
      bridgeHarness.createOrSyncMarket(params),
    ]);

    expect(solanaOperator.initRound).toHaveBeenCalledTimes(1);
    expect(world.emit).toHaveBeenCalledTimes(1);
    expect(bridge.getMarket("duel-123")?.onChainInitialized).toBe(true);
  });

  it("logs unexpected scheduled lock failures", async () => {
    const errorSpy = vi.spyOn(Logger, "error").mockImplementation(() => {});
    vi.spyOn(bridgeHarness, "lockMarket").mockRejectedValue(new Error("boom"));

    await bridgeHarness.createOrSyncMarket({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent1Id: "agent-a",
      agent2Id: "agent-b",
      agent1Name: "Agent A",
      agent2Name: "Agent B",
      bettingClosesAt: Date.now() + 1_000,
      source: "streaming",
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(errorSpy).toHaveBeenCalledWith(
      "DuelBettingBridge",
      "Unexpected error in scheduled market lock",
      expect.any(Error),
      { duelId: "duel-123" },
    );
  });

  it("locks and resolves a market when the live duel advances phases", async () => {
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    await bridgeHarness.handleStreamingFightStart({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fightStartTime: 2_500,
    });

    expect(bridge.getMarket("duel-123")?.status).toBe("locked");
    expect(world.emit).toHaveBeenCalledWith(
      "betting:market:locked",
      expect.objectContaining({
        duelId: "duel-123",
      }),
    );

    scheduler = {
      getCurrentCycle: () =>
        makeCycle({
          phase: "RESOLUTION",
          outcome: "win",
          winnerId: "agent-a",
          loserId: "agent-b",
        }),
    };

    await bridgeHarness.handleStreamingResolution({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      outcome: "win",
      duelEndTime: 9_000,
      winnerId: "agent-a",
      loserId: "agent-b",
      winnerName: "Agent A",
      loserName: "Agent B",
      winReason: "kill",
      seed: "12345",
      replayHash: "deadbeef",
      duration: 6_500,
    });

    expect(bridge.getMarket("duel-123")).toBeNull();
    expect(bridge.getMarketHistory()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(world.emit).toHaveBeenCalledWith(
      "betting:market:resolved",
      expect.objectContaining({
        duelId: "duel-123",
        winnerId: "agent-a",
        winnerName: "Agent A",
      }),
    );
  });

  it("requires the exact authoritative terminal cycle before streaming settlement", async () => {
    const canonicalDuelKey =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const resolution = {
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      outcome: "win",
      winnerId: "agent-a",
      loserId: "agent-b",
      winnerName: "Agent A",
      loserName: "Agent B",
    };
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    await bridgeHarness.handleStreamingResolution(resolution);
    scheduler = {
      getCurrentCycle: () => makeCycle({ phase: "FIGHTING" }),
    };
    await bridgeHarness.handleStreamingResolution(resolution);
    scheduler = {
      getCurrentCycle: () =>
        makeCycle({
          phase: "RESOLUTION",
          outcome: "win",
          winnerId: "agent-b",
          loserId: "agent-a",
        }),
    };
    await bridgeHarness.handleStreamingResolution(resolution);

    expect(bridge.getMarket("duel-123")?.status).toBe("betting");
    expect(bridge.getMarketHistory()).toHaveLength(0);
    for (const reason of [
      "authoritative_cycle_missing",
      "authoritative_phase_mismatch",
      "authoritative_outcome_mismatch",
    ]) {
      expect(world.emit).toHaveBeenCalledWith(
        "betting:market:resolution-rejected",
        expect.objectContaining({ duelId: "duel-123", reason }),
      );
    }

    scheduler = {
      getCurrentCycle: () =>
        makeCycle({
          phase: "RESOLUTION",
          outcome: "win",
          winnerId: "agent-a",
          loserId: "agent-b",
        }),
    };
    await bridgeHarness.handleStreamingResolution(resolution);

    expect(bridge.getMarket("duel-123")).toBeNull();
    expect(bridge.getMarketHistory()).toHaveLength(1);
  });

  it("reconciles a missing market from the live streaming scheduler", async () => {
    const cycle = makeCycle();
    scheduler = {
      getCurrentCycle: () => cycle,
    };

    await bridgeHarness.reconcileLiveCycle();

    const created = bridge.getMarket("duel-123");
    expect(created).not.toBeNull();
    expect(created?.duelKeyHex).toBe(cycle.duelKeyHex);

    cycle.phase = "FIGHTING";
    cycle.phaseStartTime = 2_500;
    cycle.fightStartTime = 2_500;
    await bridgeHarness.reconcileLiveCycle();
    expect(bridge.getMarket("duel-123")?.status).toBe("locked");

    cycle.phase = "RESOLUTION";
    cycle.outcome = "win";
    cycle.winnerId = "agent-a";
    cycle.loserId = "agent-b";
    cycle.winnerName = "Agent A";
    cycle.loserName = "Agent B";
    cycle.duelEndTime = 9_000;
    cycle.seed = "12345";
    cycle.replayHash = "deadbeef";
    await bridgeHarness.reconcileLiveCycle();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(bridge.getMarket("duel-123")).toBeNull();
    expect(bridge.getMarketHistory()).toHaveLength(1);
  });

  it("rejects streaming settlement when the duel key or participant pair drifts", async () => {
    const canonicalDuelKey =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    await bridgeHarness.handleStreamingResolution({
      duelId: "duel-123",
      duelKeyHex:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      outcome: "win",
      winnerId: "agent-a",
      loserId: "agent-b",
    });
    await bridgeHarness.handleStreamingResolution({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      outcome: "win",
      winnerId: "agent-outsider",
      loserId: "agent-a",
    });
    await bridgeHarness.handleStreamingResolution({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      outcome: "win",
      winnerId: "agent-a",
      loserId: "agent-a",
    });

    expect(bridge.getMarket("duel-123")?.status).toBe("betting");
    expect(bridge.getMarketHistory()).toHaveLength(0);
    expect(world.emit).toHaveBeenCalledWith(
      "betting:market:resolution-rejected",
      expect.objectContaining({
        duelId: "duel-123",
        reason: "duel_key_mismatch",
      }),
    );
    expect(world.emit).toHaveBeenCalledWith(
      "betting:market:resolution-rejected",
      expect.objectContaining({
        duelId: "duel-123",
        reason: "participant_pair_mismatch",
      }),
    );
  });

  it("keeps randomized illegal lifecycle outcomes from settling a market", async () => {
    vi.spyOn(Logger, "error").mockImplementation(() => {});
    const canonicalDuelKey =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    let state = 0x5eed1234;
    const nextRandom = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const nonterminalPhases = [
      "IDLE",
      "ANNOUNCEMENT",
      "COUNTDOWN",
      "FIGHTING",
      "CORRUPT",
      null,
    ] as const;

    for (let index = 0; index < 512; index += 1) {
      const phase =
        nonterminalPhases[Math.floor(nextRandom() * nonterminalPhases.length)];
      scheduler = {
        getCurrentCycle: () =>
          makeCycle({
            phase,
            duelKeyHex: canonicalDuelKey,
            winnerId: "agent-outsider",
            loserId: "agent-a",
          }),
      };
      await bridgeHarness.reconcileLiveCycle();
      await bridgeHarness.handleStreamingResolution({
        duelId: "duel-123",
        duelKeyHex: canonicalDuelKey,
        outcome: "win",
        winnerId: "agent-a",
        loserId: "agent-b",
      });
      expect(bridge.getMarket("duel-123")).not.toBeNull();
      expect(bridge.getMarketHistory()).toHaveLength(0);
    }

    scheduler = {
      getCurrentCycle: () =>
        makeCycle({
          phase: "RESOLUTION",
          outcome: "win",
          duelKeyHex:
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          winnerId: "agent-a",
          loserId: "agent-b",
        }),
    };
    await bridgeHarness.reconcileLiveCycle();
    expect(bridge.getMarket("duel-123")).not.toBeNull();
    expect(bridge.getMarketHistory()).toHaveLength(0);

    scheduler = {
      getCurrentCycle: () =>
        makeCycle({
          phase: "RESOLUTION",
          outcome: "win",
          duelKeyHex: canonicalDuelKey,
          winnerId: "agent-a",
          loserId: "agent-b",
        }),
    };
    await bridgeHarness.reconcileLiveCycle();
    expect(bridge.getMarket("duel-123")).toBeNull();
    expect(bridge.getMarketHistory()).toHaveLength(1);
  });

  it("does not recreate a resolved market while the live cycle remains in resolution", async () => {
    const cycle = makeCycle();
    scheduler = {
      getCurrentCycle: () => cycle,
    };

    await bridgeHarness.reconcileLiveCycle();

    cycle.phase = "FIGHTING";
    cycle.phaseStartTime = 2_500;
    cycle.fightStartTime = 2_500;
    await bridgeHarness.reconcileLiveCycle();

    cycle.phase = "RESOLUTION";
    cycle.outcome = "win";
    cycle.winnerId = "agent-a";
    cycle.loserId = "agent-b";
    cycle.winnerName = "Agent A";
    cycle.loserName = "Agent B";
    cycle.duelEndTime = 9_000;
    cycle.seed = "12345";
    cycle.replayHash = "deadbeef";

    await bridgeHarness.reconcileLiveCycle();

    expect(bridge.getMarket("duel-123")).toBeNull();
    expect(bridge.getMarketHistory()).toHaveLength(1);

    await bridgeHarness.reconcileLiveCycle();

    expect(bridge.getMarket("duel-123")).toBeNull();
    expect(bridge.getMarketHistory()).toHaveLength(1);
  });

  it("marks aborted markets as terminal and does not recreate them during reconciliation", async () => {
    const errorSpy = vi.spyOn(Logger, "error").mockImplementation(() => {});
    const solanaOperator = {
      isEnabled: () => true,
      initRound: vi.fn().mockResolvedValue({
        closeSlot: 123,
        initOracleSignature: "oracle-sig",
        initMarketSignature: "market-sig",
      }),
      lockMarket: vi.fn().mockResolvedValue(null),
      reportAndResolve: vi.fn().mockResolvedValue(null),
    };
    bridgeHarness.solanaOperator = solanaOperator;

    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    scheduler = {
      getCurrentCycle: () => makeCycle(),
    };

    await bridgeHarness.handleStreamingAbort({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reason: "manual_abort",
      agent1Id: "agent-a",
      agent2Id: "agent-b",
    });

    expect(bridge.getMarket("duel-123")).toBeNull();
    expect(bridge.getMarketHistory()).toContainEqual(
      expect.objectContaining({
        duelId: "duel-123",
        status: "aborted",
        onChainInitialized: true,
      }),
    );
    expect(world.emit).toHaveBeenCalledWith(
      "betting:market:aborted",
      expect.objectContaining({
        duelId: "duel-123",
        reason: "manual_abort",
        onChainInitialized: true,
      }),
    );
    expect(world.emit).toHaveBeenCalledWith(
      "betting:market:orphaned",
      expect.objectContaining({
        duelId: "duel-123",
        roundSeedHex:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        manualInterventionRequired: true,
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "DuelBettingBridge",
      expect.stringContaining("manual intervention is required"),
      null,
      expect.objectContaining({
        duelId: "duel-123",
      }),
    );

    scheduler = {
      getCurrentCycle: () => makeCycle(),
    };
    await bridgeHarness.reconcileLiveCycle();

    expect(bridge.getMarket("duel-123")).toBeNull();
  });

  it("does not emit delayed resolution events after the bridge is destroyed", async () => {
    const solanaOperator = {
      isEnabled: () => true,
      initRound: vi.fn().mockResolvedValue({
        closeSlot: 123,
        initOracleSignature: "oracle-sig",
        initMarketSignature: "market-sig",
      }),
      lockMarket: vi.fn().mockResolvedValue(null),
      reportAndResolve: vi.fn().mockResolvedValue({
        reportSignature: "report-sig",
        resolveSignature: "resolve-sig",
      }),
    };
    bridgeHarness.solanaOperator = solanaOperator;

    scheduler = {
      getCurrentCycle: () =>
        makeCycle({
          phase: "RESOLUTION",
          outcome: "win",
          winnerId: "agent-a",
          loserId: "agent-b",
        }),
    };

    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    await bridgeHarness.handleStreamingResolution({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      outcome: "win",
      duelEndTime: 9_000,
      winnerId: "agent-a",
      loserId: "agent-b",
      winnerName: "Agent A",
      loserName: "Agent B",
      winReason: "kill",
      seed: "12345",
      replayHash: "deadbeef",
      duration: 6_500,
    });

    bridge.destroy();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(solanaOperator.reportAndResolve).not.toHaveBeenCalled();
    expect(world.emit).not.toHaveBeenCalledWith(
      "betting:market:resolved",
      expect.anything(),
    );
  });

  it("resets reconcileInFlight even when a reconcile pass throws", async () => {
    const cycle = makeCycle();
    scheduler = {
      getCurrentCycle: () => cycle,
    };

    const createOrSyncMarket = vi
      .spyOn(bridgeHarness, "createOrSyncMarket")
      .mockRejectedValueOnce(new Error("boom"));

    await expect(bridgeHarness.reconcileLiveCycle()).rejects.toThrow("boom");
    expect(bridgeHarness.reconcileInFlight).toBe(false);

    createOrSyncMarket.mockRestore();

    await bridgeHarness.reconcileLiveCycle();
    expect(bridge.getMarket("duel-123")).not.toBeNull();
  });

  it("swallows and logs direct reconcile failures from fight-start recovery", async () => {
    const reconcileLiveCycle = vi
      .spyOn(bridgeHarness, "reconcileLiveCycle")
      .mockRejectedValueOnce(new Error("boom"));

    await expect(
      bridgeHarness.handleStreamingFightStart({
        duelId: "duel-123",
      }),
    ).resolves.toBeUndefined();

    reconcileLiveCycle.mockRestore();
  });

  it("awaits duel-result resolution instead of fire-and-forgetting it", async () => {
    await bridgeHarness.createOrSyncMarket({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent1Id: "agent-a",
      agent2Id: "agent-b",
      agent1Name: "Agent A",
      agent2Name: "Agent B",
      bettingClosesAt: 2_000,
      source: "legacy",
    });

    const resolveMarket = vi
      .spyOn(bridgeHarness, "resolveMarket")
      .mockRejectedValueOnce(new Error("boom"));

    await expect(
      bridgeHarness.handleDuelResult({
        duelId: "duel-123",
        winnerId: "agent-a",
        loserId: "agent-b",
      }),
    ).rejects.toThrow("boom");

    resolveMarket.mockRestore();
  });

  it("resolves a legacy market by exact duel ID instead of participant ambiguity", async () => {
    for (const duelId of ["duel-123", "duel-456"]) {
      await bridgeHarness.createOrSyncMarket({
        duelId,
        agent1Id: "agent-a",
        agent2Id: "agent-b",
        agent1Name: "Agent A",
        agent2Name: "Agent B",
        bettingClosesAt: 2_000,
        source: "legacy",
      });
    }

    await bridgeHarness.handleDuelResult({
      duelId: "duel-456",
      winnerId: "agent-a",
      loserId: "agent-b",
    });

    expect(bridge.getMarket("duel-123")).not.toBeNull();
    expect(bridge.getMarket("duel-456")).toBeNull();
    expect(bridge.getMarketHistory()).toEqual([
      expect.objectContaining({ duelId: "duel-456", winnerId: "agent-a" }),
    ]);
  });

  it("does not let generic duel completion bypass streaming authority", async () => {
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    await bridgeHarness.handleDuelResult({
      duelId: "duel-123",
      winnerId: "agent-a",
      loserId: "agent-b",
    });

    expect(bridge.getMarket("duel-123")?.status).toBe("betting");
    expect(bridge.getMarketHistory()).toHaveLength(0);
  });

  it("rejects duplicate market events that attempt to rewrite immutable identity", async () => {
    const canonicalDuelKey =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      agent1: { id: "agent-b", name: "Agent B" },
      agent2: { id: "agent-a", name: "Agent A" },
      betOpenTime: 1_000,
      betCloseTime: 99_000,
    });

    expect(bridge.getMarket("duel-123")).toEqual(
      expect.objectContaining({
        duelKeyHex: canonicalDuelKey,
        agent1Id: "agent-a",
        agent2Id: "agent-b",
        bettingClosesAt: 2_000,
      }),
    );
    expect(world.emit).toHaveBeenCalledWith(
      "betting:market:synchronization-rejected",
      expect.objectContaining({
        duelId: "duel-123",
        reason: "immutable_market_identity_mismatch",
      }),
    );
  });

  it("rejects non-canonical aborts and never overwrites a winner terminal state", async () => {
    const canonicalDuelKey =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });
    scheduler = {
      getCurrentCycle: () =>
        makeCycle({
          phase: "RESOLUTION",
          outcome: "win",
          winnerId: "agent-a",
          loserId: "agent-b",
        }),
    };

    await bridgeHarness.handleStreamingAbort({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      reason: "watchdog_resolution_timeout",
      agent1Id: "agent-a",
      agent2Id: "agent-b",
    });

    expect(bridge.getMarket("duel-123")).not.toBeNull();
    expect(bridge.getMarketHistory()).toHaveLength(0);
    expect(world.emit).toHaveBeenCalledWith(
      "betting:market:abort-rejected",
      expect.objectContaining({
        duelId: "duel-123",
        reason: "authoritative_abort_mismatch",
      }),
    );

    await bridgeHarness.handleStreamingResolution({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      outcome: "win",
      winnerId: "agent-a",
      loserId: "agent-b",
    });
    await bridgeHarness.handleStreamingAbort({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      reason: "draw",
      agent1Id: "agent-a",
      agent2Id: "agent-b",
    });

    expect(bridge.getMarketHistory()).toEqual([
      expect.objectContaining({ status: "resolved", winnerId: "agent-a" }),
    ]);
  });

  it("requires the identity-complete draw abort frame before cancelling a market", async () => {
    const canonicalDuelKey =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });
    scheduler = {
      getCurrentCycle: () =>
        makeCycle({
          phase: "RESOLUTION",
          outcome: "draw",
          winnerId: null,
          loserId: null,
        }),
    };

    await bridgeHarness.handleStreamingResolution({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      outcome: "draw",
      winnerId: null,
      loserId: null,
    });
    expect(bridge.getMarket("duel-123")).not.toBeNull();

    await bridgeHarness.handleStreamingAbort({
      duelId: "duel-123",
      duelKeyHex: canonicalDuelKey,
      reason: "draw",
      agent1Id: "agent-a",
      agent2Id: "agent-b",
    });

    expect(bridge.getMarket("duel-123")).toBeNull();
    expect(bridge.getMarketHistory()).toEqual([
      expect.objectContaining({ status: "aborted" }),
    ]);
  });

  it("ignores malformed duel-result payloads instead of resolving a market", async () => {
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    await bridgeHarness.handleDuelResult({
      winnerId: "agent-a",
    });

    expect(bridge.getMarket("duel-123")?.status).toBe("betting");
    expect(bridge.getMarketHistory()).toHaveLength(0);
  });

  it("stops the scheduled reconciliation loop when streaming is inactive and there are no markets", async () => {
    scheduler = null;

    await bridgeHarness.runScheduledReconciliation();

    expect(bridgeHarness.reconcileTimer).toBeNull();
  });

  it("ignores malformed resolution payloads instead of mutating market state", async () => {
    await bridgeHarness.handleStreamingAnnouncement({
      duelId: "duel-123",
      duelKeyHex:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent1: { id: "agent-a", name: "Agent A" },
      agent2: { id: "agent-b", name: "Agent B" },
      betOpenTime: 1_000,
      betCloseTime: 2_000,
    });

    await bridgeHarness.handleStreamingResolution({
      duelId: "duel-123",
      winnerId: "agent-a",
    });

    expect(bridge.getMarket("duel-123")?.status).toBe("betting");
    expect(bridge.getMarketHistory()).toHaveLength(0);
  });
});
