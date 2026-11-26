import { describe, expect, it, vi } from "vitest";
import type { World } from "@hyperforge/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  MatchmakingManager,
  normalizePersistedCompetitiveOutcome,
  normalizePersistedRecentDuel,
} from "../MatchmakingManager.js";
import type { RecentDuelEntry } from "../../types.js";
import { finalizeCompetitiveSnapshot } from "../../competitive-snapshot.js";
import { COMPETITIVE_SNAPSHOT_TIMING_FIXTURE } from "../../__tests__/competitiveSnapshotTimingFixture.js";

const makeCompetitiveContestant = (
  side: "agent1" | "agent2",
  agentId: string,
  name: string,
) => ({
  side,
  agentId,
  name,
  provider: "test",
  model: "test-model",
  combatLevel: 10,
  startingHp: 20,
  maxHp: 20,
  wins: 0,
  losses: 0,
  rank: side === "agent1" ? 1 : 2,
  headToHeadWins: 0,
  headToHeadLosses: 0,
  loadoutFingerprint: (side === "agent1" ? "11" : "22").repeat(32),
  equipment: [{ slot: "weapon", itemId: "bronze_sword", quantity: 1 }],
  inventory: [],
  selectedSpell: null,
  skillLevels: [
    { skill: "attack", level: 10 },
    { skill: "constitution", level: 20 },
  ],
  prayer: {
    pointUnits: 0,
    points: 0,
    maxPoints: 10,
    activePrayers: [],
  },
  initialCombatStyle: "melee" as const,
  availableCombatStyles: ["melee" as const],
  combatLoadouts: {
    melee: {
      role: "melee" as const,
      weaponId: "bronze_sword",
      arrowsId: null,
      shieldId: null,
      spellId: null,
      armorIds: {
        helmet: null,
        body: null,
        legs: null,
        boots: null,
        gloves: null,
        cape: null,
        amulet: null,
        ring: null,
      },
    },
  },
  preparation: {
    primaryStyle: "melee" as const,
    availableStyles: ["melee" as const],
    planningSource: "deterministic" as const,
    planningPolicyVersion: "test-policy-v1",
    agentPolicyFingerprint: "ab".repeat(32),
    modelProvider: "test",
    model: "test-model",
    tacticalStrategy: {
      approach: "balanced" as const,
      tacticalMacro: "pressure" as const,
      attackStyle: "aggressive" as const,
      prayer: null,
      preferredCombatRole: null,
      foodThreshold: 40,
      switchDefensiveAt: 30,
      reasoning: "Use the deterministic role-aware competitive fallback.",
    },
  },
});

const makeCompetitiveOutcomeRow = () => {
  const finalized = finalizeCompetitiveSnapshot({
    draft: {
      diagnostic: false,
      preparationId: "f27f5d4b-84df-4bdf-9d0c-2ee4c0a5776d",
      cycleId: "authoritative-cycle",
      duelId: "authoritative-duel",
      duelKey: "ab".repeat(32),
      contestants: [
        makeCompetitiveContestant("agent1", "agent-a", "Astra"),
        makeCompetitiveContestant("agent2", "agent-b", "Riven"),
      ],
    },
    persisted: true,
    frozenAt: 100,
    betWindowDurationMs: 1_000,
    timing: COMPETITIVE_SNAPSHOT_TIMING_FIXTURE,
  });
  return {
    preparationId: finalized.snapshot.preparationId,
    snapshotVersion: finalized.snapshot.snapshotVersion,
    cycleId: finalized.snapshot.cycleId,
    duelId: finalized.snapshot.duelId,
    duelKey: finalized.snapshot.duelKey,
    snapshotDigest: finalized.digest,
    snapshot: finalized.snapshot,
    frozenAt: finalized.snapshot.frozenAt,
    lockedAt: 1_100,
    duelStartedAt: 1_200,
    recoveredAt: null,
    lifecycleStatus: "terminal",
    terminalOutcome: "win",
    terminalWinnerId: "agent-a",
    terminalWinReason: "kill",
    terminalCancellationReason: null,
    terminalSeed: "1",
    terminalReplayHash: "cd".repeat(32),
    terminalAt: 1_300,
  };
};

const makePersistedWin = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  cycleId: "legacy-win",
  duelId: "duel-legacy",
  finishedAt: 100,
  agent1Id: "agent-a",
  agent1Name: "Astra",
  agent1OpeningStyle: null,
  agent2Id: "agent-b",
  agent2Name: "Riven",
  agent2OpeningStyle: null,
  winnerId: "agent-a",
  winnerName: "Astra",
  loserId: "agent-b",
  loserName: "Riven",
  winReason: "kill",
  damageAgent1: 25,
  damageAgent2: 10,
  damageWinner: 25,
  damageLoser: 10,
  ...overrides,
});

const makeManager = (
  rows:
    | unknown[]
    | Promise<unknown[]>
    | {
        competitive: unknown[];
        damage: unknown[];
        legacy: unknown[] | Promise<unknown[]>;
      },
  maxRecentDuels = 3,
) => {
  const results =
    Array.isArray(rows) || rows instanceof Promise
      ? [[], rows]
      : [
          rows.competitive,
          ...(rows.competitive.length > 0 ? [rows.damage] : []),
          rows.legacy,
        ];
  let selection = 0;
  const db = {
    select: vi.fn(() => {
      const result = results[selection++] ?? [];
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn(() => result),
        then: (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve(result).then(resolve, reject),
      };
      return query;
    }),
  } as unknown as NodePgDatabase;

  return new MatchmakingManager({} as World, () => db, {
    minAgents: 2,
    maxRecentDuels,
    persistStatsToDatabase: false,
    maxAgentStats: 64,
    insufficientAgentsRetryInterval: 30_000,
    maxInsufficientAgentWarnings: 5,
  });
};

const makeSelectionManager = (agentIds: string[]) => {
  const entities = new Map(
    agentIds.map((agentId) => [
      agentId,
      { data: { name: agentId, health: 10, alive: true } },
    ]),
  );
  const manager = new MatchmakingManager(
    { entities } as unknown as World,
    () => null,
    {
      minAgents: 2,
      maxRecentDuels: 3,
      persistStatsToDatabase: false,
      maxAgentStats: 64,
      insufficientAgentsRetryInterval: 30_000,
      maxInsufficientAgentWarnings: 5,
    },
  );
  const pairChanges: Array<{
    agent1Id: string;
    agent2Id: string;
    selectedAt: number;
  } | null> = [];
  manager.setCallbacks({
    getCycleContestantIds: () => new Set(),
    getCurrentCycleAgentDamage: () => null,
    onNextDuelPairChanged: (pair) => pairChanges.push(pair),
  });
  for (const agentId of agentIds) {
    manager.availableAgents.add(agentId);
  }
  return { entities, manager, pairChanges };
};

describe("streaming duel participation authority", () => {
  it("cannot bypass an opt-out through ordinary registration", () => {
    const { manager } = makeSelectionManager(["agent-a"]);
    manager.availableAgents.clear();

    manager.markStreamingDuelOptOut("agent-a", true);
    manager.registerAgent("agent-a");
    expect(manager.availableAgents.has("agent-a")).toBe(false);

    manager.markStreamingDuelOptOut("agent-a", false);
    manager.registerAgent("agent-a");
    expect(manager.availableAgents.has("agent-a")).toBe(true);
  });

  it("suspends a reconnecting agent without discarding its selected pair", () => {
    const { manager, pairChanges } = makeSelectionManager([
      "agent-a",
      "agent-b",
    ]);
    manager.refreshNextDuelPair(1_000);
    const selectedPair = manager.nextDuelPair;
    expect(selectedPair).not.toBeNull();

    manager.suspendAgentForReconnect("agent-a");

    expect(manager.availableAgents.has("agent-a")).toBe(false);
    expect(manager.nextDuelPair).toBe(selectedPair);
    expect(pairChanges).toEqual([selectedPair]);

    manager.registerAgent("agent-a");
    expect(manager.availableAgents.has("agent-a")).toBe(true);
    expect(manager.nextDuelPair).toBe(selectedPair);
  });
});

const makeStatsHydrationManager = (results: unknown[]) => {
  let selection = 0;
  const db = {
    select: vi.fn(() => {
      const result = results[selection++] ?? [];
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(() => result),
      };
      return query;
    }),
  } as unknown as NodePgDatabase;
  const entities = new Map([
    [
      "agent-stats",
      {
        data: {
          name: "Stats Agent",
          health: 10,
          alive: true,
          agentProvider: "test",
          agentModel: "test-model",
        },
      },
    ],
  ]);
  const manager = new MatchmakingManager(
    { entities } as unknown as World,
    () => db,
    {
      minAgents: 2,
      maxRecentDuels: 3,
      persistStatsToDatabase: true,
      maxAgentStats: 64,
      insufficientAgentsRetryInterval: 30_000,
      maxInsufficientAgentWarnings: 5,
    },
  );
  return { db, manager };
};

const makeLiveDuel = (overrides: Partial<RecentDuelEntry> = {}) => ({
  cycleId: "live-cycle",
  duelId: "live-duel",
  finishedAt: 250,
  outcome: "draw" as const,
  agent1Id: "agent-live-a",
  agent1Name: "Live A",
  agent1OpeningStyle: null,
  agent2Id: "agent-live-b",
  agent2Name: "Live B",
  agent2OpeningStyle: null,
  winnerId: null,
  winnerName: null,
  loserId: null,
  loserName: null,
  winReason: "draw" as const,
  cancellationReason: null,
  damageAgent1: 14,
  damageAgent2: 14,
  damageWinner: null,
  damageLoser: null,
  ...overrides,
});

describe("MatchmakingManager preparation retry deferral", () => {
  it("keeps dead contestants registered but out of pair selection until respawn", () => {
    const { entities, manager } = makeSelectionManager([
      "agent-dead",
      "agent-healthy-a",
      "agent-healthy-b",
    ]);
    const dead = entities.get("agent-dead")!;
    dead.data.health = 0;
    dead.data.alive = false;

    manager.refreshNextDuelPair(1_000);

    expect(manager.availableAgents.has("agent-dead")).toBe(true);
    expect(
      new Set([manager.nextDuelPair?.agent1Id, manager.nextDuelPair?.agent2Id]),
    ).toEqual(new Set(["agent-healthy-a", "agent-healthy-b"]));

    dead.data.health = 10;
    dead.data.alive = true;
    manager.availableAgents.delete("agent-healthy-b");
    manager.refreshNextDuelPair(2_000);
    expect(
      new Set([manager.nextDuelPair?.agent1Id, manager.nextDuelPair?.agent2Id]),
    ).toEqual(new Set(["agent-dead", "agent-healthy-a"]));
  });

  it("keeps a failed agent out while healthy agents continue pairing", () => {
    const { manager } = makeSelectionManager([
      "agent-failed",
      "agent-healthy-a",
      "agent-healthy-b",
    ]);

    manager.deferAgentAfterPreparationFailure("agent-failed", 2_000);
    manager.refreshNextDuelPair(1_000);

    expect(
      new Set([manager.nextDuelPair?.agent1Id, manager.nextDuelPair?.agent2Id]),
    ).toEqual(new Set(["agent-healthy-a", "agent-healthy-b"]));
  });

  it("re-admits the failed agent exactly at the retry deadline", () => {
    const { manager } = makeSelectionManager(["agent-failed", "agent-peer"]);

    manager.deferAgentAfterPreparationFailure("agent-failed", 2_000);
    manager.refreshNextDuelPair(1_999);
    expect(manager.nextDuelPair).toBeNull();

    manager.refreshNextDuelPair(2_000);
    expect(
      new Set([manager.nextDuelPair?.agent1Id, manager.nextDuelPair?.agent2Id]),
    ).toEqual(new Set(["agent-failed", "agent-peer"]));
  });

  it("never shortens an existing deferral", () => {
    const { manager } = makeSelectionManager(["agent-failed", "agent-peer"]);

    manager.deferAgentAfterPreparationFailure("agent-failed", 3_000);
    manager.deferAgentAfterPreparationFailure("agent-failed", 2_000);
    manager.refreshNextDuelPair(2_500);
    expect(manager.nextDuelPair).toBeNull();

    manager.refreshNextDuelPair(3_000);
    expect(manager.nextDuelPair).not.toBeNull();
  });

  it("clears stale process-local deferral when an agent reconnects", () => {
    const { manager } = makeSelectionManager(["agent-restarted", "agent-peer"]);
    const retryAfter = Date.now() + 60_000;

    manager.deferAgentAfterPreparationFailure("agent-restarted", retryAfter);
    manager.unregisterAgent("agent-restarted");
    manager.registerAgent("agent-restarted");
    manager.refreshNextDuelPair(Date.now());

    expect(
      new Set([manager.nextDuelPair?.agent1Id, manager.nextDuelPair?.agent2Id]),
    ).toEqual(new Set(["agent-restarted", "agent-peer"]));
  });

  it("clears an already-selected failed pair before notifying replacement logic", () => {
    const { manager, pairChanges } = makeSelectionManager([
      "agent-failed",
      "agent-peer",
    ]);
    manager.refreshNextDuelPair(1_000);
    expect(manager.nextDuelPair).not.toBeNull();

    manager.deferAgentAfterPreparationFailure("agent-failed", 2_000);

    expect(manager.nextDuelPair).toBeNull();
    expect(pairChanges.at(-1)).toBeNull();
  });

  it("rejects malformed retry boundaries", () => {
    const { manager } = makeSelectionManager(["agent-failed", "agent-peer"]);

    expect(() => manager.deferAgentAfterPreparationFailure("", 2_000)).toThrow(
      "invalid preparation retry deferral",
    );
    expect(() =>
      manager.deferAgentAfterPreparationFailure("agent-failed", Number.NaN),
    ).toThrow("invalid preparation retry deferral");
    expect(() =>
      manager.deferAgentAfterPreparationFailure("agent-failed", -1),
    ).toThrow("invalid preparation retry deferral");
  });
});

describe("MatchmakingManager competitive stat hydration", () => {
  it("singleflights persisted records and exposes no registration placeholder", async () => {
    let resolveCombat!: (rows: unknown[]) => void;
    const combatRows = new Promise<unknown[]>((resolve) => {
      resolveCombat = resolve;
    });
    const { db, manager } = makeStatsHydrationManager([
      combatRows,
      [{ wins: 10, losses: 4, draws: 2, currentStreak: 5 }],
    ]);

    manager.registerAgent("agent-stats");
    const first = manager.waitForAgentStatsHydration(["agent-stats"]);
    const second = manager.waitForAgentStatsHydration(["agent-stats"]);
    let released = false;
    void first.then(() => {
      released = true;
    });
    await vi.waitFor(() => expect(db.select).toHaveBeenCalledTimes(2));

    expect(released).toBe(false);
    resolveCombat([{ totalDuelWins: 12, totalDuelLosses: 3 }]);
    await Promise.all([first, second]);
    expect(manager.agentStats.get("agent-stats")).toMatchObject({
      wins: 12,
      losses: 3,
      draws: 2,
      currentStreak: 5,
    });

    await manager.waitForAgentStatsHydration(["agent-stats"]);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a configured database error and retries successfully", async () => {
    let rejectCombat!: (error: Error) => void;
    const failedCombat = new Promise<unknown[]>((_, reject) => {
      rejectCombat = reject;
    });
    const { db, manager } = makeStatsHydrationManager([
      failedCombat,
      [],
      [{ totalDuelWins: 7, totalDuelLosses: 2 }],
      [{ wins: 7, losses: 2, draws: 1, currentStreak: 3 }],
    ]);

    manager.registerAgent("agent-stats");
    const first = manager.waitForAgentStatsHydration(["agent-stats"]);
    await vi.waitFor(() => expect(db.select).toHaveBeenCalledTimes(2));
    rejectCombat(new Error("temporary stats outage"));
    await expect(first).rejects.toThrow("temporary stats outage");
    await expect(
      manager.waitForAgentStatsHydration(["agent-stats"]),
    ).resolves.toBeUndefined();

    expect(db.select).toHaveBeenCalledTimes(4);
    expect(manager.agentStats.get("agent-stats")).toMatchObject({
      wins: 7,
      losses: 2,
      draws: 1,
      currentStreak: 3,
    });
  });
});

describe("normalizePersistedRecentDuel", () => {
  it("accepts the legacy win-only row shape", () => {
    const normalized = normalizePersistedRecentDuel(makePersistedWin());

    expect(normalized).toMatchObject({
      cycleId: "legacy-win",
      outcome: "win",
      winnerId: "agent-a",
      loserId: "agent-b",
      winReason: "kill",
    });
  });

  it("accepts winner-only writes from a rolled-back binary after migration", () => {
    const normalized = normalizePersistedRecentDuel(
      makePersistedWin({
        outcome: "win",
        agent1Id: null,
        agent1Name: null,
        agent2Id: null,
        agent2Name: null,
        damageAgent1: 0,
        damageAgent2: 0,
      }),
    );

    expect(normalized).toMatchObject({
      outcome: "win",
      agent1Id: "agent-a",
      agent1Name: "Astra",
      agent2Id: "agent-b",
      agent2Name: "Riven",
      damageAgent1: 25,
      damageAgent2: 10,
    });
  });

  it("normalizes draws without manufacturing a winner", () => {
    const normalized = normalizePersistedRecentDuel(
      makePersistedWin({
        cycleId: "draw-cycle",
        outcome: "draw",
        winnerId: "should-not-survive",
        loserId: "should-not-survive",
        winReason: null,
      }),
    );

    expect(normalized).toMatchObject({
      outcome: "draw",
      winnerId: null,
      loserId: null,
      winReason: "draw",
      cancellationReason: null,
    });
  });

  it("preserves cancellation diagnostics but strips competitive fields", () => {
    const normalized = normalizePersistedRecentDuel(
      makePersistedWin({
        cycleId: "cancel-cycle",
        outcome: "cancelled",
        agent1Id: null,
        agent1Name: null,
        agent2Id: null,
        agent2Name: null,
        cancellationReason: "agents_missing",
      }),
    );

    expect(normalized).toMatchObject({
      outcome: "cancelled",
      agent1Id: null,
      agent2Id: null,
      winnerId: null,
      loserId: null,
      winReason: null,
      cancellationReason: "agents_missing",
    });
  });

  it("rejects unknown outcomes and incomplete wins", () => {
    expect(
      normalizePersistedRecentDuel(makePersistedWin({ outcome: "void" })),
    ).toBeNull();
    expect(
      normalizePersistedRecentDuel(makePersistedWin({ winnerId: null })),
    ).toBeNull();
  });

  it("preserves valid frozen styles and fails unknown styles closed to null", () => {
    expect(
      normalizePersistedRecentDuel(
        makePersistedWin({
          agent1OpeningStyle: "ranged",
          agent2OpeningStyle: "melee",
        }),
      ),
    ).toMatchObject({
      agent1OpeningStyle: "ranged",
      agent2OpeningStyle: "melee",
    });
    expect(
      normalizePersistedRecentDuel(
        makePersistedWin({
          agent1OpeningStyle: "invalid",
          agent2OpeningStyle: 42,
        }),
      ),
    ).toMatchObject({
      agent1OpeningStyle: null,
      agent2OpeningStyle: null,
    });
  });
});

describe("MatchmakingManager opponent history", () => {
  it("returns only completed head-to-head records from the requested perspective", () => {
    const manager = makeManager([]);
    manager.recordRecentDuel(
      makeLiveDuel({
        cycleId: "older-win",
        finishedAt: 100,
        outcome: "win",
        agent1Id: "agent-a",
        agent1OpeningStyle: "mage",
        agent2Id: "agent-b",
        agent2OpeningStyle: "ranged",
        winnerId: "agent-a",
        winnerName: "Astra",
        loserId: "agent-b",
        loserName: "Riven",
        winReason: "kill",
        damageAgent1: 25,
        damageAgent2: 10,
        damageWinner: 25,
        damageLoser: 10,
      }),
    );
    manager.recordRecentDuel(
      makeLiveDuel({
        cycleId: "newer-draw",
        finishedAt: 200,
        agent1Id: "agent-b",
        agent1OpeningStyle: "melee",
        agent2Id: "agent-a",
        agent2OpeningStyle: "mage",
        damageAgent1: 14,
        damageAgent2: 14,
      }),
    );
    manager.recordRecentDuel(
      makeLiveDuel({
        cycleId: "cancelled",
        finishedAt: 300,
        outcome: "cancelled",
        agent1Id: "agent-a",
        agent2Id: "agent-b",
        winReason: null,
        cancellationReason: "operator_cancelled",
      }),
    );

    expect(manager.getOpponentHistory("agent-a", "agent-b")).toEqual([
      {
        cycleId: "newer-draw",
        finishedAt: 200,
        result: "draw",
        ownOpeningStyle: "mage",
        opponentOpeningStyle: "melee",
        ownDamage: 14,
        opponentDamage: 14,
        winReason: "draw",
      },
      {
        cycleId: "older-win",
        finishedAt: 100,
        result: "win",
        ownOpeningStyle: "mage",
        opponentOpeningStyle: "ranged",
        ownDamage: 25,
        opponentDamage: 10,
        winReason: "kill",
      },
    ]);
    expect(manager.getOpponentHistory("agent-b", "agent-a", 1)).toEqual([
      expect.objectContaining({
        cycleId: "newer-draw",
        ownOpeningStyle: "melee",
        opponentOpeningStyle: "mage",
      }),
    ]);
    expect(manager.getOpponentHistory("agent-a", "unrelated")).toEqual([]);
  });
});

describe("MatchmakingManager recent-duel hydration", () => {
  it("normalizes terminal truth from the exact frozen snapshot and computed damage", () => {
    const row = makeCompetitiveOutcomeRow();

    expect(normalizePersistedCompetitiveOutcome(row, 7, 3)).toEqual({
      cycleId: "authoritative-cycle",
      duelId: "authoritative-duel",
      finishedAt: 1_300,
      outcome: "win",
      agent1Id: "agent-a",
      agent1Name: "Astra",
      agent1OpeningStyle: "melee",
      agent2Id: "agent-b",
      agent2Name: "Riven",
      agent2OpeningStyle: "melee",
      winnerId: "agent-a",
      winnerName: "Astra",
      loserId: "agent-b",
      loserName: "Riven",
      winReason: "kill",
      cancellationReason: null,
      damageAgent1: 7,
      damageAgent2: 3,
      damageWinner: 7,
      damageLoser: 3,
    });
    expect(
      normalizePersistedCompetitiveOutcome(
        { ...row, snapshotDigest: "00".repeat(32) },
        7,
        3,
      ),
    ).toBeNull();
    expect(
      normalizePersistedCompetitiveOutcome(
        {
          ...row,
          snapshot: { ...row.snapshot, diagnostic: true },
        },
        7,
        3,
      ),
    ).toBeNull();
  });

  it("reconstructs draw and cancellation terminals without inventing a winner", () => {
    const win = makeCompetitiveOutcomeRow();
    expect(
      normalizePersistedCompetitiveOutcome(
        {
          ...win,
          terminalOutcome: "draw",
          terminalWinnerId: null,
          terminalWinReason: "draw",
          terminalCancellationReason: "draw",
        },
        4,
        4,
      ),
    ).toMatchObject({
      outcome: "draw",
      winnerId: null,
      loserId: null,
      winReason: "draw",
      damageAgent1: 4,
      damageAgent2: 4,
      damageWinner: null,
      damageLoser: null,
    });
    expect(
      normalizePersistedCompetitiveOutcome(
        {
          ...win,
          terminalOutcome: "cancelled",
          terminalWinnerId: null,
          terminalWinReason: null,
          terminalCancellationReason: "operator_cancelled",
          terminalSeed: null,
          terminalReplayHash: null,
        },
        2,
        1,
      ),
    ).toMatchObject({
      outcome: "cancelled",
      winnerId: null,
      loserId: null,
      winReason: null,
      cancellationReason: "operator_cancelled",
      damageAgent1: 2,
      damageAgent2: 1,
    });
  });

  it("hydrates authoritative terminal rows ahead of conflicting legacy history", async () => {
    const row = makeCompetitiveOutcomeRow();
    const manager = makeManager({
      competitive: [row],
      damage: [
        {
          cycleId: row.cycleId,
          observation: {
            schemaVersion: 1,
            sequence: 1,
            cycleId: row.cycleId,
            duelId: row.duelId,
            actorId: "agent-a",
            opponentId: "agent-b",
            tick: 5,
            observedAt: 1_250,
            phase: "FIGHTING",
            combatRole: "melee",
            tacticalMacro: "pressure",
            action: "damage",
            value: "hit",
            amount: 7,
            outcome: "committed",
          },
        },
      ],
      legacy: [
        makePersistedWin({
          cycleId: row.cycleId,
          winnerId: "agent-b",
          winnerName: "Riven",
          loserId: "agent-a",
          loserName: "Astra",
          damageAgent1: 0,
          damageAgent2: 99,
        }),
      ],
    });

    await expect(manager.hydrateRecentDuelsFromDatabase()).resolves.toBe(1);
    expect(manager.getRecentDuels()).toEqual([
      expect.objectContaining({
        cycleId: row.cycleId,
        winnerId: "agent-a",
        loserId: "agent-b",
        damageAgent1: 7,
        damageAgent2: 0,
      }),
    ]);
  });

  it("never masks a corrupt competitive terminal with the legacy cache", async () => {
    const row = makeCompetitiveOutcomeRow();
    const manager = makeManager({
      competitive: [{ ...row, snapshotDigest: "00".repeat(32) }],
      damage: [],
      legacy: [makePersistedWin({ cycleId: row.cycleId })],
    });

    await expect(manager.hydrateRecentDuelsFromDatabase()).resolves.toBe(0);
    expect(manager.getRecentDuels()).toEqual([]);
  });

  it("merges persisted rows newest-first without replacing live cycles", async () => {
    const manager = makeManager([
      makePersistedWin({
        id: 4,
        cycleId: "bad-cycle",
        outcome: "unknown",
        finishedAt: 400,
      }),
      makePersistedWin({
        id: 3,
        cycleId: "cancel-cycle",
        outcome: "cancelled",
        finishedAt: 300,
        cancellationReason: "agents_missing",
      }),
      makePersistedWin({
        id: 2,
        cycleId: "live-cycle",
        outcome: "win",
        finishedAt: 200,
      }),
      makePersistedWin(),
    ]);
    manager.recordRecentDuel(makeLiveDuel());

    await expect(manager.hydrateRecentDuelsFromDatabase()).resolves.toBe(3);

    expect(manager.getRecentDuels()).toEqual([
      expect.objectContaining({
        cycleId: "cancel-cycle",
        outcome: "cancelled",
      }),
      expect.objectContaining({
        cycleId: "live-cycle",
        outcome: "draw",
        finishedAt: 250,
      }),
      expect.objectContaining({ cycleId: "legacy-win", outcome: "win" }),
    ]);
  });

  it("does not repopulate history when reset wins an in-flight race", async () => {
    let resolveRows!: (rows: unknown[]) => void;
    const rows = new Promise<unknown[]>((resolve) => {
      resolveRows = resolve;
    });
    const manager = makeManager(rows);

    const hydration = manager.hydrateRecentDuelsFromDatabase();
    await vi.waitFor(() => {
      expect(resolveRows).toBeTypeOf("function");
    });
    manager.reset();
    resolveRows([makePersistedWin()]);

    await expect(hydration).resolves.toBe(0);
    expect(manager.getRecentDuels()).toEqual([]);
  });
});
