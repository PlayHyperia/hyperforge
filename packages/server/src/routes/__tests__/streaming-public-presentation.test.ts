import { describe, expect, it } from "vitest";
import type {
  RecentDuelEntry,
  StreamingStateUpdate,
  StreamingTerminalNotice,
} from "../../systems/StreamingDuelScheduler/types.js";
import {
  derivePublicBettingAvailability,
  sanitizePublicRecentDuel,
  sanitizePublicOperationalMetrics,
  sanitizePublicStreamingState,
  sanitizePublicTerminalNotice,
  toPublicCancellationReason,
} from "../streaming-public-presentation.js";
import { STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION } from "@hyperforge/shared";

const makeNotice = (reason: string): StreamingTerminalNotice => ({
  cycleId: "cycle-1",
  duelId: null,
  outcome: "cancelled",
  reason,
  occurredAt: 100,
  expiresAt: 200,
  agent1Id: null,
  agent1Name: null,
  agent2Id: null,
  agent2Name: null,
});

const makeCancellation = (reason: string): RecentDuelEntry => ({
  cycleId: "cycle-1",
  duelId: null,
  finishedAt: 100,
  outcome: "cancelled",
  agent1Id: null,
  agent1Name: null,
  agent1OpeningStyle: null,
  agent2Id: null,
  agent2Name: null,
  agent2OpeningStyle: null,
  winnerId: null,
  winnerName: null,
  loserId: null,
  loserName: null,
  winReason: null,
  cancellationReason: reason,
  damageAgent1: 0,
  damageAgent2: 0,
  damageWinner: null,
  damageLoser: null,
});

describe("public cancellation presentation", () => {
  it("fails betting availability closed across every prerequisite", () => {
    expect(
      derivePublicBettingAvailability({
        betUrl: null,
        bettingBridgeEnabled: true,
        runtimeReady: true,
      }),
    ).toEqual({ ready: false, unavailableReason: "link_unconfigured" });
    expect(
      derivePublicBettingAvailability({
        betUrl: "https://bet.example",
        bettingBridgeEnabled: false,
        runtimeReady: true,
      }),
    ).toEqual({ ready: false, unavailableReason: "betting_disabled" });
    expect(
      derivePublicBettingAvailability({
        betUrl: "https://bet.example",
        bettingBridgeEnabled: true,
        runtimeReady: false,
      }),
    ).toEqual({ ready: false, unavailableReason: "stream_services_unready" });
    expect(
      derivePublicBettingAvailability({
        betUrl: "https://bet.example",
        bettingBridgeEnabled: true,
        runtimeReady: true,
      }),
    ).toEqual({ ready: true, unavailableReason: null });
  });

  it("maps internal reasons to a bounded viewer-safe vocabulary", () => {
    expect(toPublicCancellationReason("no_combat_activity_timeout")).toBe(
      "insufficient_verified_combat",
    );
    expect(toPublicCancellationReason("agents_missing_before_countdown")).toBe(
      "contestant_unavailable",
    );
    expect(toPublicCancellationReason("scheduler_shutdown")).toBe(
      "broadcast_interrupted",
    );
    expect(toPublicCancellationReason("internal_database_fault_code_52")).toBe(
      "no_contest",
    );
  });

  it("redacts terminal notices without mutating the scheduler object", () => {
    const internal = makeNotice("agents_missing_before_countdown");
    const publicNotice = sanitizePublicTerminalNotice(internal);

    expect(publicNotice?.reason).toBe("contestant_unavailable");
    expect(internal.reason).toBe("agents_missing_before_countdown");
  });

  it("redacts cancellation history and leaves decisive history unchanged", () => {
    const internal = makeCancellation("scheduler_shutdown");
    const publicDuel = sanitizePublicRecentDuel(internal);
    const win = { ...internal, outcome: "win" as const };

    expect(publicDuel.cancellationReason).toBe("broadcast_interrupted");
    expect(internal.cancellationReason).toBe("scheduler_shutdown");
    expect(sanitizePublicRecentDuel(win)).toBe(win);
  });

  it("aggregates operational reasons into the public vocabulary", () => {
    const sanitized = sanitizePublicOperationalMetrics({
      emittedAt: 100,
      historyWindow: {
        size: 3,
        maxSize: 200,
        wins: 0,
        draws: 0,
        completed: 0,
        cancelled: 3,
        terminal: 3,
        completionRate: 0,
        cancellationReasons: {
          agents_missing: 1,
          agent_disconnect: 1,
          internal_database_fault_code_52: 1,
        },
      },
      engagement: {
        checks: 0,
        retries: 0,
        recoveries: 0,
        failures: 0,
        proximityCorrections: 0,
        currentRetryCount: 0,
      },
      actionObservations: {
        configured: true,
        healthy: true,
        pending: 0,
        persisted: 12,
        replayed: 0,
        rejected: 0,
        persistenceErrors: 0,
      },
      current: {
        cycleId: null,
        phase: "IDLE",
        firstHitLatencyMs: null,
        recoveryInProgress: false,
        schedulerState: "ACTIVE",
        availableAgents: 2,
        requiredAgents: 2,
        preparation: {
          enabled: true,
          gateInFlight: false,
          selectionInFlight: false,
          status: "ready",
          expiresAt: 1_000,
        },
      },
    });

    expect(sanitized.historyWindow.cancellationReasons).toEqual({
      contestant_unavailable: 2,
      no_contest: 1,
    });
  });

  it("removes the internal competitive snapshot and retains only a strict strategy summary", () => {
    const strategySummary = {
      schemaVersion: STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION,
      approach: "balanced",
      tacticalMacro: "orbit",
      attackStyle: "accurate",
      prayer: "hawk_eye",
      preferredCombatRole: "ranged",
      foodThreshold: 40,
      switchDefensiveAt: 30,
      source: "model",
      policyVersion: "duel-preparation-role-v3",
    } as const;
    const agent = {
      id: "agent-a",
      name: "Agent A",
      provider: "public-provider",
      model: "public-model",
      hp: 10,
      maxHp: 10,
      combatLevel: 3,
      wins: 1,
      losses: 0,
      damageDealtThisFight: 0,
      highestHit: 0,
      attacksLanded: 0,
      healsUsed: 0,
      equipment: {},
      inventory: [],
      itemIconPaths: {},
      loadoutFingerprint: "ab".repeat(32),
      availableCombatStyles: ["ranged" as const],
      combatLoadouts: {},
      loadoutFrozen: true,
      strategySummary,
      prayerPointUnits: 0,
      prayerPoints: 0,
      prayerMaxPoints: 1,
      rank: 1,
      headToHeadWins: 0,
      headToHeadLosses: 0,
      bank: [{ itemId: "private_bank_item", quantity: 99 }],
    };
    const state = {
      type: "STREAMING_STATE_UPDATE",
      cycle: {
        cycleId: "cycle-1",
        phase: "ANNOUNCEMENT",
        cycleStartTime: 100,
        phaseStartTime: 100,
        phaseEndTime: 200,
        phaseVersion: 1,
        timeRemaining: 100,
        competitiveSnapshot: {
          contestants: [
            {
              inventory: [{ itemId: "private_supply", quantity: 12 }],
              preparation: {
                agentPolicyFingerprint: "private",
                tacticalStrategy: { reasoning: "private free-form text" },
              },
            },
          ],
        },
        competitiveSnapshotVersion: 3,
        competitiveSnapshotDigest: "cd".repeat(32),
        agent1: agent,
        agent2: {
          ...agent,
          id: "agent-b",
          name: "Agent B",
          strategySummary: { ...strategySummary, reasoning: "not allowed" },
        },
        duelId: "duel-1",
        duelKeyHex: "ef".repeat(32),
        betOpenTime: 100,
        betCloseTime: 200,
        countdown: null,
        fightStartTime: null,
        firstHitAt: null,
        duelEndTime: null,
        arenaPositions: null,
        winnerId: null,
        winnerName: null,
        outcome: null,
        winReason: null,
        seed: null,
        replayHash: null,
        actionObservations: [],
      },
      leaderboard: [],
      cameraTarget: "agent-a",
      terminalNotice: makeNotice("scheduler_shutdown"),
      preparation: {
        schemaVersion: 2,
        status: "preparing",
        selectedAt: 100,
        expiresAt: 1_100,
        agent1: {
          id: "agent-a",
          ready: true,
          activity: "training",
          mode: "working",
          activityTrail: ["training"],
        },
        agent2: {
          id: "agent-b",
          ready: false,
          activity: null,
          mode: null,
          activityTrail: [],
        },
      },
    } as unknown as StreamingStateUpdate;

    const sanitized = sanitizePublicStreamingState(state);

    expect(sanitized).not.toBe(state);
    expect(sanitized.cycle).not.toBe(state.cycle);
    expect(sanitized.cycle.competitiveSnapshot).toBeNull();
    expect(sanitized.cycle.agent1?.strategySummary).toEqual(strategySummary);
    expect(sanitized.cycle.agent1?.strategySummary).not.toBe(strategySummary);
    expect(Object.isFrozen(sanitized.cycle.agent1?.strategySummary)).toBe(true);
    expect(sanitized.cycle.agent2?.strategySummary).toBeNull();
    expect(sanitized.preparation).toBeNull();
    expect(sanitized.terminalNotice?.reason).toBe("broadcast_interrupted");
    expect(JSON.stringify(sanitized)).not.toContain("private_bank_item");
    expect(JSON.stringify(sanitized)).not.toContain("private free-form text");
    expect(sanitized.cycle.agent1).not.toHaveProperty("bank");
    expect(state.cycle.competitiveSnapshot).not.toBeNull();

    const idle = sanitizePublicStreamingState({
      ...state,
      cycle: {
        ...state.cycle,
        phase: "IDLE",
      },
    } as unknown as StreamingStateUpdate);
    expect(idle.preparation).toEqual(state.preparation);
    expect(idle.preparation).not.toBe(state.preparation);
    expect(Object.isFrozen(idle.preparation)).toBe(true);
    expect(Object.isFrozen(idle.preparation?.agent1)).toBe(true);

    const unsafe = sanitizePublicStreamingState({
      ...state,
      cycle: { ...state.cycle, phase: "IDLE" },
      preparation: {
        ...state.preparation!,
        preparationId: "private-preparation-id",
      },
    } as unknown as StreamingStateUpdate);
    expect(unsafe.preparation).toBeNull();
    expect(JSON.stringify(unsafe)).not.toContain("private-preparation-id");

    const unsafeArena = sanitizePublicStreamingState({
      ...state,
      cycle: {
        ...state.cycle,
        arenaPositions: {
          agent1: [350, 0.42, 405.35],
          agent2: [350, 99, 405.35],
        },
      },
    } as unknown as StreamingStateUpdate);
    expect(unsafeArena.cycle.arenaPositions).toBeNull();
  });
});
