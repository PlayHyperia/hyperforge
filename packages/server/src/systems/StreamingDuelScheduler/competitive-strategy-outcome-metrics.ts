import { createHash } from "node:crypto";

import {
  parseStreamingDuelActionObservation,
  type StreamingDuelActionObservation,
  type StreamingDuelPublicCombatRole,
  type StreamingDuelStrategySummary,
} from "@hyperforge/shared";

import type { CompetitiveSnapshot } from "./competitive-snapshot.js";
import {
  emptyCompetitiveExecutionChoiceSummary,
  mergeCompetitiveExecutionChoiceSummaries,
  summarizeCompetitiveExecutionChoices,
  type CompetitiveExecutionChoiceSummary,
} from "./competitive-execution-choice-metrics.js";
import {
  normalizePersistedCompetitiveOutcome,
  type CompetitiveOutcomeNormalizationOptions,
} from "./competitive-outcome.js";
import { toPublicStrategySummary } from "./public-strategy-summary.js";
import type { StreamingDuelWinReason } from "./types.js";

export const COMPETITIVE_STRATEGY_OUTCOME_SCHEMA_VERSION = 1 as const;

export type CompetitiveStrategyOutcomeResult = "win" | "loss" | "draw";

export type CompetitiveStrategyOutcomeSample = Readonly<{
  schemaVersion: typeof COMPETITIVE_STRATEGY_OUTCOME_SCHEMA_VERSION;
  cycleId: string;
  duelId: string;
  finishedAt: number;
  agentId: string;
  opponentId: string;
  result: CompetitiveStrategyOutcomeResult;
  openingStyle: StreamingDuelPublicCombatRole;
  strategyHash: string;
  strategy: StreamingDuelStrategySummary;
  damageDealt: number;
  damageTaken: number;
  winReason: StreamingDuelWinReason;
  execution: CompetitiveExecutionChoiceSummary;
}>;

export type CompetitiveStrategyOutcomeAggregate = Readonly<{
  dimension: "agent" | "strategy" | "agent_strategy";
  key: string;
  agentId: string | null;
  strategyHash: string | null;
  openingStyle: StreamingDuelPublicCombatRole | null;
  strategy: StreamingDuelStrategySummary | null;
  /** Participant-duel appearances represented by this aggregate. */
  appearances: number;
  decisiveAppearances: number;
  wins: number;
  losses: number;
  draws: number;
  damageDealt: number;
  damageTaken: number;
  damageMargin: number;
  decisiveWinRate: number | null;
  drawRate: number;
  averageDamageDealt: number;
  averageDamageTaken: number;
  averageDamageMargin: number;
  execution: CompetitiveExecutionChoiceSummary;
}>;

export type CompetitiveStrategyOutcomeReport = Readonly<{
  schemaVersion: typeof COMPETITIVE_STRATEGY_OUTCOME_SCHEMA_VERSION;
  completedDuels: number;
  participantSamples: number;
  firstFinishedAt: number | null;
  lastFinishedAt: number | null;
  samples: readonly CompetitiveStrategyOutcomeSample[];
  aggregates: readonly CompetitiveStrategyOutcomeAggregate[];
}>;

type PersistedActionObservationRow = Record<string, unknown>;

type MutableAggregate = {
  dimension: CompetitiveStrategyOutcomeAggregate["dimension"];
  key: string;
  agentId: string | null;
  strategyHash: string | null;
  openingStyle: StreamingDuelPublicCombatRole | null;
  strategy: StreamingDuelStrategySummary | null;
  appearances: number;
  wins: number;
  losses: number;
  draws: number;
  damageDealt: number;
  damageTaken: number;
  execution: CompetitiveExecutionChoiceSummary;
};

const PUBLIC_COMBAT_ROLES = new Set<StreamingDuelPublicCombatRole>([
  "melee",
  "ranged",
  "mage",
]);

function safeAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Competitive strategy ${field} exceeds safe integer range`);
  }
  return result;
}

function strategyIdentity(
  openingStyle: StreamingDuelPublicCombatRole,
  strategy: StreamingDuelStrategySummary,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        openingStyle,
        schemaVersion: strategy.schemaVersion,
        approach: strategy.approach,
        tacticalMacro: strategy.tacticalMacro,
        attackStyle: strategy.attackStyle,
        prayer: strategy.prayer,
        preferredCombatRole: strategy.preferredCombatRole,
        foodThreshold: strategy.foodThreshold,
        switchDefensiveAt: strategy.switchDefensiveAt,
        source: strategy.source,
        policyVersion: strategy.policyVersion,
      }),
    )
    .digest("hex");
}

/**
 * Convert one exact persisted competitive terminal into two participant-relative
 * samples. Invalid authority is rejected; cancellations are intentionally
 * excluded because they do not measure strategy effectiveness.
 */
export function normalizeCompetitiveStrategyOutcomeSamples(
  row: unknown,
  damageAgent1: unknown,
  damageAgent2: unknown,
  executionAgent1?: CompetitiveExecutionChoiceSummary,
  executionAgent2?: CompetitiveExecutionChoiceSummary,
  options: CompetitiveOutcomeNormalizationOptions = {},
): readonly CompetitiveStrategyOutcomeSample[] | null {
  const outcome = normalizePersistedCompetitiveOutcome(
    row,
    damageAgent1,
    damageAgent2,
    options,
  );
  if (!outcome) return null;
  if (outcome.outcome === "cancelled") return Object.freeze([]);

  const snapshot = (row as { snapshot: CompetitiveSnapshot }).snapshot;
  const [agent1, agent2] = snapshot.contestants;
  const strategy1 = toPublicStrategySummary(agent1);
  const strategy2 = toPublicStrategySummary(agent2);
  const openingStyle1 = outcome.agent1OpeningStyle;
  const openingStyle2 = outcome.agent2OpeningStyle;
  if (
    !strategy1 ||
    !strategy2 ||
    !openingStyle1 ||
    !openingStyle2 ||
    !PUBLIC_COMBAT_ROLES.has(openingStyle1) ||
    !PUBLIC_COMBAT_ROLES.has(openingStyle2) ||
    !outcome.duelId ||
    !outcome.winReason
  ) {
    return null;
  }

  const resultFor = (agentId: string): CompetitiveStrategyOutcomeResult =>
    outcome.outcome === "draw"
      ? "draw"
      : outcome.winnerId === agentId
        ? "win"
        : "loss";
  const sample = (
    contestant: typeof agent1,
    opponent: typeof agent1,
    openingStyle: StreamingDuelPublicCombatRole,
    strategy: StreamingDuelStrategySummary,
    damageDealt: number,
    damageTaken: number,
    execution: CompetitiveExecutionChoiceSummary,
  ): CompetitiveStrategyOutcomeSample =>
    Object.freeze({
      schemaVersion: COMPETITIVE_STRATEGY_OUTCOME_SCHEMA_VERSION,
      cycleId: outcome.cycleId,
      duelId: outcome.duelId as string,
      finishedAt: outcome.finishedAt,
      agentId: contestant.agentId,
      opponentId: opponent.agentId,
      result: resultFor(contestant.agentId),
      openingStyle,
      strategyHash: strategyIdentity(openingStyle, strategy),
      strategy,
      damageDealt,
      damageTaken,
      winReason: outcome.winReason as StreamingDuelWinReason,
      execution,
    });

  return Object.freeze([
    sample(
      agent1,
      agent2,
      openingStyle1,
      strategy1,
      outcome.damageAgent1,
      outcome.damageAgent2,
      executionAgent1 ?? emptyCompetitiveExecutionChoiceSummary(),
    ),
    sample(
      agent2,
      agent1,
      openingStyle2,
      strategy2,
      outcome.damageAgent2,
      outcome.damageAgent1,
      executionAgent2 ?? emptyCompetitiveExecutionChoiceSummary(),
    ),
  ]);
}

function updateAggregate(
  aggregates: Map<string, MutableAggregate>,
  identity: Omit<
    MutableAggregate,
    | "appearances"
    | "wins"
    | "losses"
    | "draws"
    | "damageDealt"
    | "damageTaken"
    | "execution"
  >,
  sample: CompetitiveStrategyOutcomeSample,
): void {
  const aggregate = aggregates.get(identity.key) ?? {
    ...identity,
    appearances: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    damageDealt: 0,
    damageTaken: 0,
    execution: emptyCompetitiveExecutionChoiceSummary(),
  };
  aggregate.appearances = safeAdd(aggregate.appearances, 1, "appearance count");
  aggregate[
    sample.result === "win"
      ? "wins"
      : sample.result === "loss"
        ? "losses"
        : "draws"
  ] = safeAdd(
    aggregate[
      sample.result === "win"
        ? "wins"
        : sample.result === "loss"
          ? "losses"
          : "draws"
    ],
    1,
    `${sample.result} count`,
  );
  aggregate.damageDealt = safeAdd(
    aggregate.damageDealt,
    sample.damageDealt,
    "damage dealt",
  );
  aggregate.damageTaken = safeAdd(
    aggregate.damageTaken,
    sample.damageTaken,
    "damage taken",
  );
  aggregate.execution = mergeCompetitiveExecutionChoiceSummaries(
    aggregate.execution,
    sample.execution,
  );
  aggregates.set(identity.key, aggregate);
}

/**
 * Produce descriptive population metrics only. Product-owned minimum sample,
 * success, significance, and balance thresholds deliberately remain outside
 * this calculation.
 */
export function aggregateCompetitiveStrategyOutcomes(
  samples: readonly CompetitiveStrategyOutcomeSample[],
): readonly CompetitiveStrategyOutcomeAggregate[] {
  const aggregates = new Map<string, MutableAggregate>();
  for (const sample of samples) {
    const identities = [
      {
        dimension: "agent" as const,
        key: `agent:${sample.agentId}`,
        agentId: sample.agentId,
        strategyHash: null,
        openingStyle: null,
        strategy: null,
      },
      {
        dimension: "strategy" as const,
        key: `strategy:${sample.strategyHash}`,
        agentId: null,
        strategyHash: sample.strategyHash,
        openingStyle: sample.openingStyle,
        strategy: sample.strategy,
      },
      {
        dimension: "agent_strategy" as const,
        key: `agent_strategy:${sample.agentId}:${sample.strategyHash}`,
        agentId: sample.agentId,
        strategyHash: sample.strategyHash,
        openingStyle: sample.openingStyle,
        strategy: sample.strategy,
      },
    ];
    for (const identity of identities) {
      updateAggregate(aggregates, identity, sample);
    }
  }

  return Object.freeze(
    [...aggregates.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((aggregate) => {
        const decisiveAppearances = safeAdd(
          aggregate.wins,
          aggregate.losses,
          "decisive appearance count",
        );
        const damageMargin = aggregate.damageDealt - aggregate.damageTaken;
        if (!Number.isSafeInteger(damageMargin)) {
          throw new Error(
            "Competitive strategy damage margin exceeds safe integer range",
          );
        }
        return Object.freeze({
          ...aggregate,
          decisiveAppearances,
          damageMargin,
          decisiveWinRate:
            decisiveAppearances === 0
              ? null
              : aggregate.wins / decisiveAppearances,
          drawRate: aggregate.draws / aggregate.appearances,
          averageDamageDealt: aggregate.damageDealt / aggregate.appearances,
          averageDamageTaken: aggregate.damageTaken / aggregate.appearances,
          averageDamageMargin: damageMargin / aggregate.appearances,
        });
      }),
  );
}

function exactDatabaseInteger(value: unknown, expected: number): boolean {
  if (typeof value === "bigint") return value === BigInt(expected);
  if (typeof value === "number") return value === expected;
  return typeof value === "string" && value === String(expected);
}

/**
 * Build a fail-closed report from exact terminal and observation query rows.
 * Denormalized database identity is checked against each immutable JSON
 * observation before any amount contributes to the report.
 */
export function buildCompetitiveStrategyOutcomeReport(
  terminalRows: readonly unknown[],
  observationRows: readonly unknown[],
  options: CompetitiveOutcomeNormalizationOptions = {},
): CompetitiveStrategyOutcomeReport {
  const observationsByCycle = new Map<
    string,
    StreamingDuelActionObservation[]
  >();
  const observedIdentities = new Set<string>();
  for (const rawRow of observationRows) {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      throw new Error("Competitive strategy observation row is malformed");
    }
    const row = rawRow as PersistedActionObservationRow;
    const observation = parseStreamingDuelActionObservation(row.observation);
    if (
      !observation ||
      row.action !== observation.action ||
      row.cycleId !== observation.cycleId ||
      row.duelId !== observation.duelId ||
      row.actorId !== observation.actorId ||
      row.opponentId !== observation.opponentId ||
      !exactDatabaseInteger(row.sequence, observation.sequence) ||
      !exactDatabaseInteger(row.observedAt, observation.observedAt)
    ) {
      throw new Error("Competitive strategy action authority is inconsistent");
    }
    const identity = `${observation.cycleId}\u0000${observation.sequence}`;
    if (observedIdentities.has(identity)) {
      throw new Error("Competitive strategy action sequence is duplicated");
    }
    observedIdentities.add(identity);
    const cycle = observationsByCycle.get(observation.cycleId) ?? [];
    cycle.push(observation);
    observationsByCycle.set(observation.cycleId, cycle);
  }

  const samples: CompetitiveStrategyOutcomeSample[] = [];
  const terminalCycleIds = new Set<string>();
  let firstFinishedAt: number | null = null;
  let lastFinishedAt: number | null = null;
  for (const rawRow of terminalRows) {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      throw new Error("Competitive strategy terminal row is malformed");
    }
    const row = rawRow as Record<string, unknown>;
    const cycleId = typeof row.cycleId === "string" ? row.cycleId : null;
    const snapshot = row.snapshot as CompetitiveSnapshot | undefined;
    const contestants = snapshot?.contestants;
    if (
      !cycleId ||
      terminalCycleIds.has(cycleId) ||
      !Array.isArray(contestants) ||
      contestants.length !== 2
    ) {
      throw new Error("Competitive strategy terminal identity is invalid");
    }
    terminalCycleIds.add(cycleId);

    const cycleObservations = observationsByCycle.get(cycleId) ?? [];
    const damageByActor = new Map<string, number>();
    for (const observation of cycleObservations) {
      const expectedOpponent =
        observation.actorId === contestants[0]?.agentId
          ? contestants[1]?.agentId
          : observation.actorId === contestants[1]?.agentId
            ? contestants[0]?.agentId
            : null;
      if (expectedOpponent !== observation.opponentId) {
        throw new Error(
          "Competitive strategy action participant identity is invalid",
        );
      }
      if (observation.action !== "damage") continue;
      damageByActor.set(
        observation.actorId,
        safeAdd(
          damageByActor.get(observation.actorId) ?? 0,
          observation.amount,
          "damage dealt",
        ),
      );
    }

    const normalized = normalizeCompetitiveStrategyOutcomeSamples(
      row,
      damageByActor.get(contestants[0]?.agentId ?? "") ?? 0,
      damageByActor.get(contestants[1]?.agentId ?? "") ?? 0,
      summarizeCompetitiveExecutionChoices(
        cycleObservations,
        contestants[0]?.agentId ?? "",
      ),
      summarizeCompetitiveExecutionChoices(
        cycleObservations,
        contestants[1]?.agentId ?? "",
      ),
      options,
    );
    if (!normalized || normalized.length !== 2) {
      throw new Error(
        `Competitive strategy terminal is not analytics eligible: ${cycleId}`,
      );
    }
    const duelStartedAt =
      row.duelStartedAt === null ? null : Number(row.duelStartedAt);
    if (
      cycleObservations.some(
        (observation) =>
          observation.observedAt > normalized[0].finishedAt ||
          (duelStartedAt === null
            ? true
            : observation.observedAt < duelStartedAt),
      )
    ) {
      throw new Error("Competitive strategy action timestamp is invalid");
    }
    samples.push(...normalized);
    firstFinishedAt =
      firstFinishedAt === null
        ? normalized[0].finishedAt
        : Math.min(firstFinishedAt, normalized[0].finishedAt);
    lastFinishedAt =
      lastFinishedAt === null
        ? normalized[0].finishedAt
        : Math.max(lastFinishedAt, normalized[0].finishedAt);
  }

  for (const cycleId of observationsByCycle.keys()) {
    if (!terminalCycleIds.has(cycleId)) {
      throw new Error(
        "Competitive strategy action has no selected terminal authority",
      );
    }
  }

  const frozenSamples = Object.freeze([...samples]);
  return Object.freeze({
    schemaVersion: COMPETITIVE_STRATEGY_OUTCOME_SCHEMA_VERSION,
    completedDuels: terminalRows.length,
    participantSamples: frozenSamples.length,
    firstFinishedAt,
    lastFinishedAt,
    samples: frozenSamples,
    aggregates: aggregateCompetitiveStrategyOutcomes(frozenSamples),
  });
}
