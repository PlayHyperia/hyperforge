import { describe, expect, it } from "vitest";

import { finalizeCompetitiveSnapshot } from "../competitive-snapshot.js";
import {
  aggregateCompetitiveStrategyOutcomes,
  buildCompetitiveStrategyOutcomeReport,
  normalizeCompetitiveStrategyOutcomeSamples,
} from "../competitive-strategy-outcome-metrics.js";
import { COMPETITIVE_SNAPSHOT_TIMING_FIXTURE } from "./competitiveSnapshotTimingFixture.js";

const makeContestant = (
  side: "agent1" | "agent2",
  agentId: string,
  name: string,
) => ({
  side,
  agentId,
  name,
  provider: "private-provider",
  model: "private-model",
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
  inventory: [{ itemId: "shrimp", quantity: 2, slot: 0 }],
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
    planningPolicyVersion: "strategy-policy-v1",
    agentPolicyFingerprint: "ab".repeat(32),
    modelProvider: "private-provider",
    model: "private-model",
    tacticalStrategy: {
      approach: "balanced" as const,
      tacticalMacro: "pressure" as const,
      attackStyle: "aggressive" as const,
      prayer: null,
      preferredCombatRole: null,
      foodThreshold: 40,
      switchDefensiveAt: 30,
      reasoning: "Private free-form reasoning must never enter analytics.",
    },
  },
});

const makeOutcomeRow = (
  suffix: string,
  outcome: "win" | "draw" | "cancelled" = "win",
  diagnostic = false,
) => {
  const finalized = finalizeCompetitiveSnapshot({
    draft: {
      diagnostic,
      preparationId: "f27f5d4b-84df-4bdf-9d0c-2ee4c0a5776d",
      cycleId: `strategy-cycle-${suffix}`,
      duelId: `strategy-duel-${suffix}`,
      duelKey: (suffix === "one" ? "ab" : "cd").repeat(32),
      contestants: [
        makeContestant("agent1", "agent-a", "Astra"),
        makeContestant("agent2", "agent-b", "Riven"),
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
    terminalOutcome: outcome,
    terminalWinnerId: outcome === "win" ? "agent-a" : null,
    terminalWinReason:
      outcome === "win" ? "kill" : outcome === "draw" ? "draw" : null,
    terminalCancellationReason:
      outcome === "draw"
        ? "draw"
        : outcome === "cancelled"
          ? "authority_lost"
          : null,
    terminalSeed: outcome === "cancelled" ? null : "1",
    terminalReplayHash: outcome === "cancelled" ? null : "ef".repeat(32),
    terminalAt: 1_300,
  };
};

const makeDamageObservationRow = (
  cycleId: string,
  duelId: string,
  sequence: number,
  actorId: string,
  opponentId: string,
  amount: number,
) => {
  const observation = {
    schemaVersion: 1,
    sequence,
    tick: sequence,
    observedAt: 1_200 + sequence,
    cycleId,
    duelId,
    actorId,
    opponentId,
    phase: "FIGHTING",
    combatRole: "melee",
    tacticalMacro: "pressure",
    action: "damage",
    outcome: "committed",
    value: "hit",
    amount,
  };
  return {
    cycleId,
    duelId,
    sequence,
    observedAt: String(observation.observedAt),
    actorId,
    opponentId,
    action: "damage",
    observation,
  };
};

const makeActionObservationRow = (input: {
  sequence: number;
  actorId: string;
  opponentId: string;
  action: string;
  outcome: string;
  value: string;
  amount: number | null;
  combatRole?: string;
  tacticalMacro?: string;
}) => {
  const row = makeDamageObservationRow(
    "strategy-cycle-one",
    "strategy-duel-one",
    input.sequence,
    input.actorId,
    input.opponentId,
    1,
  );
  return {
    ...row,
    action: input.action,
    observation: {
      ...row.observation,
      combatRole: input.combatRole ?? "melee",
      tacticalMacro: input.tacticalMacro ?? "pressure",
      action: input.action,
      outcome: input.outcome,
      value: input.value,
      amount: input.amount,
    },
  };
};

describe("competitive strategy outcome metrics", () => {
  it("emits exact participant-relative samples without private preparation data", () => {
    const samples = normalizeCompetitiveStrategyOutcomeSamples(
      makeOutcomeRow("one"),
      12,
      4,
    );

    expect(samples).not.toBeNull();
    expect(samples).toHaveLength(2);
    expect(samples?.[0]).toMatchObject({
      cycleId: "strategy-cycle-one",
      duelId: "strategy-duel-one",
      agentId: "agent-a",
      opponentId: "agent-b",
      result: "win",
      openingStyle: "melee",
      damageDealt: 12,
      damageTaken: 4,
      winReason: "kill",
      strategy: {
        approach: "balanced",
        tacticalMacro: "pressure",
        source: "deterministic",
        policyVersion: "strategy-policy-v1",
      },
    });
    expect(samples?.[1]).toMatchObject({
      agentId: "agent-b",
      opponentId: "agent-a",
      result: "loss",
      damageDealt: 4,
      damageTaken: 12,
    });
    expect(samples?.[0]?.strategyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(samples?.[0]?.strategyHash).toBe(samples?.[1]?.strategyHash);
    expect(Object.isFrozen(samples)).toBe(true);
    expect(Object.isFrozen(samples?.[0])).toBe(true);

    const disclosed = JSON.stringify(samples);
    for (const privateField of [
      "reasoning",
      "provider",
      "model",
      "agentPolicyFingerprint",
      "loadoutFingerprint",
      "equipment",
      "inventory",
    ]) {
      expect(disclosed).not.toContain(privateField);
    }
  });

  it("excludes cancellations and rejects invalid immutable authority", () => {
    expect(
      normalizeCompetitiveStrategyOutcomeSamples(
        makeOutcomeRow("one", "cancelled"),
        0,
        0,
      ),
    ).toEqual([]);

    expect(
      normalizeCompetitiveStrategyOutcomeSamples(
        { ...makeOutcomeRow("one"), snapshotDigest: "00".repeat(32) },
        12,
        4,
      ),
    ).toBeNull();
    expect(
      normalizeCompetitiveStrategyOutcomeSamples(
        { ...makeOutcomeRow("one"), frozenAt: 101 },
        12,
        4,
      ),
    ).toBeNull();
    expect(
      normalizeCompetitiveStrategyOutcomeSamples(
        { ...makeOutcomeRow("one"), snapshotVersion: 999 },
        12,
        4,
      ),
    ).toBeNull();
    expect(
      normalizeCompetitiveStrategyOutcomeSamples(
        makeOutcomeRow("one"),
        Number.MAX_SAFE_INTEGER + 1,
        4,
      ),
    ).toBeNull();
  });

  it("keeps diagnostic snapshots out by default and requires an explicit local-audit opt-in", () => {
    const diagnostic = makeOutcomeRow("diagnostic", "win", true);

    expect(
      normalizeCompetitiveStrategyOutcomeSamples(diagnostic, 12, 4),
    ).toBeNull();
    expect(
      normalizeCompetitiveStrategyOutcomeSamples(
        diagnostic,
        12,
        4,
        undefined,
        undefined,
        { allowDiagnosticSnapshots: true },
      ),
    ).toHaveLength(2);
    expect(() =>
      buildCompetitiveStrategyOutcomeReport([diagnostic], []),
    ).toThrow("not analytics eligible");
    expect(
      buildCompetitiveStrategyOutcomeReport([diagnostic], [], {
        allowDiagnosticSnapshots: true,
      }).participantSamples,
    ).toBe(2);
  });

  it("aggregates exact descriptive agent and strategy populations", () => {
    const win = normalizeCompetitiveStrategyOutcomeSamples(
      makeOutcomeRow("one"),
      12,
      4,
    );
    const draw = normalizeCompetitiveStrategyOutcomeSamples(
      makeOutcomeRow("two", "draw"),
      6,
      6,
    );
    expect(win).not.toBeNull();
    expect(draw).not.toBeNull();

    const aggregates = aggregateCompetitiveStrategyOutcomes([
      ...(win ?? []),
      ...(draw ?? []),
    ]);
    const agent = aggregates.find((entry) => entry.key === "agent:agent-a");
    expect(agent).toEqual({
      dimension: "agent",
      key: "agent:agent-a",
      agentId: "agent-a",
      strategyHash: null,
      openingStyle: null,
      strategy: null,
      appearances: 2,
      decisiveAppearances: 1,
      wins: 1,
      losses: 0,
      draws: 1,
      damageDealt: 18,
      damageTaken: 10,
      damageMargin: 8,
      decisiveWinRate: 1,
      drawRate: 0.5,
      averageDamageDealt: 9,
      averageDamageTaken: 5,
      averageDamageMargin: 4,
      execution: expect.objectContaining({ observations: 0 }),
    });

    const strategy = aggregates.find((entry) => entry.dimension === "strategy");
    expect(strategy).toMatchObject({
      appearances: 4,
      decisiveAppearances: 2,
      wins: 1,
      losses: 1,
      draws: 2,
      damageDealt: 28,
      damageTaken: 28,
      damageMargin: 0,
      decisiveWinRate: 0.5,
      drawRate: 0.5,
      averageDamageDealt: 7,
      averageDamageTaken: 7,
      averageDamageMargin: 0,
    });
    expect(Object.isFrozen(aggregates)).toBe(true);
    expect(aggregates.every(Object.isFrozen)).toBe(true);
  });

  it("builds a strict report from matching immutable database rows", () => {
    const report = buildCompetitiveStrategyOutcomeReport(
      [makeOutcomeRow("one"), makeOutcomeRow("two", "draw")],
      [
        makeDamageObservationRow(
          "strategy-cycle-one",
          "strategy-duel-one",
          1,
          "agent-a",
          "agent-b",
          12,
        ),
        makeDamageObservationRow(
          "strategy-cycle-one",
          "strategy-duel-one",
          2,
          "agent-b",
          "agent-a",
          4,
        ),
        makeActionObservationRow({
          sequence: 3,
          actorId: "agent-a",
          opponentId: "agent-b",
          action: "role_switch",
          outcome: "committed",
          value: "ranged",
          amount: null,
        }),
        makeActionObservationRow({
          sequence: 4,
          actorId: "agent-a",
          opponentId: "agent-b",
          action: "movement",
          outcome: "accepted",
          value: "reposition",
          amount: null,
          combatRole: "ranged",
          tacticalMacro: "kite",
        }),
        makeActionObservationRow({
          sequence: 5,
          actorId: "agent-b",
          opponentId: "agent-a",
          action: "style",
          outcome: "accepted",
          value: "aggressive",
          amount: null,
        }),
        makeActionObservationRow({
          sequence: 6,
          actorId: "agent-b",
          opponentId: "agent-a",
          action: "prayer",
          outcome: "committed",
          value: "superhuman_strength",
          amount: null,
        }),
        makeActionObservationRow({
          sequence: 7,
          actorId: "agent-a",
          opponentId: "agent-b",
          action: "food",
          outcome: "committed",
          value: "consume",
          amount: 5,
        }),
        makeActionObservationRow({
          sequence: 8,
          actorId: "agent-b",
          opponentId: "agent-a",
          action: "engagement",
          outcome: "accepted",
          value: "initial",
          amount: null,
        }),
        makeDamageObservationRow(
          "strategy-cycle-two",
          "strategy-duel-two",
          1,
          "agent-a",
          "agent-b",
          6,
        ),
        makeDamageObservationRow(
          "strategy-cycle-two",
          "strategy-duel-two",
          2,
          "agent-b",
          "agent-a",
          6,
        ),
      ],
    );

    expect(report).toMatchObject({
      schemaVersion: 1,
      completedDuels: 2,
      participantSamples: 4,
      firstFinishedAt: 1_300,
      lastFinishedAt: 1_300,
    });
    expect(report.samples.map((sample) => sample.damageDealt)).toEqual([
      12, 4, 6, 6,
    ]);
    expect(report.samples[0].execution).toMatchObject({
      observations: 4,
      movement: { attempts: 1, accepted: 1 },
      food: { attempts: 1, committed: 1, totalHealing: 5 },
      roleSwitch: {
        attempts: 1,
        committed: 1,
        committedByTargetRole: { ranged: 1 },
      },
      damage: { hits: 1, total: 12 },
      observedCombatRoles: { melee: 3, ranged: 1 },
      observedTacticalMacros: { pressure: 3, kite: 1 },
    });
    expect(report.samples[1].execution).toMatchObject({
      observations: 4,
      engagement: { attempts: 1, accepted: 1, initialAccepted: 1 },
      prayer: {
        attempts: 1,
        committed: 1,
        committedByPrayer: { superhuman_strength: 1 },
      },
      style: {
        attempts: 1,
        accepted: 1,
        acceptedByStyle: { aggressive: 1 },
      },
      damage: { hits: 1, total: 4 },
    });
    const strategyAggregate = report.aggregates.find(
      (entry) => entry.dimension === "strategy",
    );
    expect(strategyAggregate?.execution).toMatchObject({
      observations: 10,
      movement: { attempts: 1, accepted: 1 },
      engagement: { attempts: 1, accepted: 1 },
      food: { attempts: 1, committed: 1, totalHealing: 5 },
      prayer: { attempts: 1, committed: 1 },
      style: { attempts: 1, accepted: 1 },
      roleSwitch: { attempts: 1, committed: 1 },
      damage: { hits: 4, total: 28 },
    });
    expect(Object.isFrozen(report)).toBe(true);

    const inconsistent = makeDamageObservationRow(
      "strategy-cycle-one",
      "strategy-duel-one",
      1,
      "agent-a",
      "agent-b",
      12,
    );
    inconsistent.actorId = "agent-b";
    expect(() =>
      buildCompetitiveStrategyOutcomeReport(
        [makeOutcomeRow("one")],
        [inconsistent],
      ),
    ).toThrow("action authority is inconsistent");

    const afterTerminal = makeDamageObservationRow(
      "strategy-cycle-one",
      "strategy-duel-one",
      1,
      "agent-a",
      "agent-b",
      12,
    );
    afterTerminal.observedAt = "1400";
    afterTerminal.observation.observedAt = 1_400;
    expect(() =>
      buildCompetitiveStrategyOutcomeReport(
        [makeOutcomeRow("one")],
        [afterTerminal],
      ),
    ).toThrow("action timestamp is invalid");
  });
});
