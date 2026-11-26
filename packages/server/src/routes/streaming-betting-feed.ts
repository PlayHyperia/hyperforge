import type {
  StreamingDuelCycle,
  StreamingPhase,
} from "../systems/StreamingDuelScheduler/types.js";
import {
  STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION,
  parseStreamingDuelStrategySummary,
  type StreamingDuelStrategySummary,
} from "@hyperforge/shared";

export const BETTING_FEED_SCHEMA_VERSION = 3;
export const BETTING_SOURCE_EPOCH_STORAGE_KEY =
  "streaming:betting-source-epoch";

export type BettingFeedAgent = {
  id: string;
  name: string;
  provider: string;
  model: string;
  hp: number;
  maxHp: number;
  combatLevel: number;
  wins: number;
  losses: number;
  damageDealtThisFight: number;
  rank: number;
  headToHeadWins: number;
  headToHeadLosses: number;
  /** Exact frozen disclosure safe for bettor-facing publication. */
  strategySummary: StreamingDuelStrategySummary | null;
};

/** Bounded observations only; never additional readiness or betting authority. */
export type BettingFeedRendererDerivation = {
  schemaVersion: 1;
  evaluatedAtMs: number | null;
  canonicalCycleId: string | null;
  canonicalPhase: string | null;
  externalSnapshotPresent: boolean;
  externalSnapshotUpdatedAt: number | null;
  rendererPresent: boolean;
  rendererReady: boolean | null;
  rendererPhase: string | null;
  rendererDegradedReason: string | null;
  rendererUpdatedAt: number | null;
  scenePresent: boolean;
  sceneReady: boolean | null;
  sceneCycleId: string | null;
  scenePhase: string | null;
  captureClientConnected: boolean | null;
  captureFfmpegRunning: boolean | null;
};

export type BettingFeedRendererHealth = {
  ready: boolean;
  degradedReason: string | null;
  updatedAt: number | null;
  derivation?: BettingFeedRendererDerivation;
};

export type BettingFeedOutcome =
  Exclude<StreamingDuelCycle["outcome"], null> | "cancelled" | null;

export type BettingFeedTerminalOverride = {
  outcome: Exclude<BettingFeedOutcome, "win" | null>;
  cancellationReason: string;
  duelEndTime: number;
};

export type BettingFeedPayload = {
  schemaVersion: number;
  sourceEpoch: number;
  seq: number;
  emittedAt: number;
  duelId: string | null;
  duelKey: string | null;
  competitiveSnapshotVersion: number | null;
  competitiveSnapshotDigest: string | null;
  competitiveSnapshot: StreamingDuelCycle["competitiveSnapshot"];
  phase: StreamingPhase | null;
  phaseVersion: number;
  betOpenTime: number | null;
  betCloseTime: number | null;
  fightStartTime: number | null;
  duelEndTime: number | null;
  winnerId: string | null;
  winnerName: string | null;
  outcome: BettingFeedOutcome;
  cancellationReason: string | null;
  winReason: StreamingDuelCycle["winReason"];
  seed: string | null;
  replayHash: string | null;
  agent1: BettingFeedAgent | null;
  agent2: BettingFeedAgent | null;
  arenaPositions: StreamingDuelCycle["arenaPositions"];
  rendererHealth: BettingFeedRendererHealth | null;
};

export type BettingFeedFrame = {
  seq: number;
  emittedAt: number;
  payload: BettingFeedPayload;
  payloadJson: string;
  payloadBytes: number;
};

export type ReplayDelivery =
  | {
      mode: "bootstrap";
      frames: [];
      latestFrame: BettingFeedFrame | null;
      oldestSeq: number | null;
    }
  | {
      mode: "replay";
      frames: BettingFeedFrame[];
      latestFrame: BettingFeedFrame | null;
      oldestSeq: number | null;
    }
  | {
      mode: "live";
      frames: [];
      latestFrame: BettingFeedFrame;
      oldestSeq: number;
    }
  | {
      mode: "reset";
      frames: [];
      latestFrame: BettingFeedFrame;
      oldestSeq: number;
    };

function resolveWinnerName(cycle: StreamingDuelCycle): string | null {
  if (!cycle.winnerId) return null;
  if (cycle.agent1?.characterId === cycle.winnerId)
    return cycle.agent1?.name ?? null;
  if (cycle.agent2?.characterId === cycle.winnerId)
    return cycle.agent2?.name ?? null;
  return null;
}

function toAgentSnapshot(
  agent: StreamingDuelCycle["agent1"],
  cycle: StreamingDuelCycle | null,
): BettingFeedAgent | null {
  if (!agent) return null;

  const contestant = cycle?.competitiveSnapshot?.contestants.find(
    (candidate) => candidate.agentId === agent.characterId,
  );
  const tacticalStrategy = contestant?.preparation.tacticalStrategy;
  const strategySummary = tacticalStrategy
    ? parseStreamingDuelStrategySummary({
        schemaVersion: STREAMING_DUEL_STRATEGY_SUMMARY_SCHEMA_VERSION,
        approach: tacticalStrategy.approach,
        tacticalMacro: tacticalStrategy.tacticalMacro,
        attackStyle: tacticalStrategy.attackStyle,
        prayer: tacticalStrategy.prayer,
        preferredCombatRole: tacticalStrategy.preferredCombatRole,
        foodThreshold: tacticalStrategy.foodThreshold,
        switchDefensiveAt: tacticalStrategy.switchDefensiveAt,
        source: contestant.preparation.planningSource,
        policyVersion: contestant.preparation.planningPolicyVersion,
      })
    : null;

  return {
    id: agent.characterId,
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    hp: agent.currentHp,
    maxHp: agent.maxHp,
    combatLevel: agent.combatLevel,
    wins: agent.wins,
    losses: agent.losses,
    damageDealtThisFight: agent.damageDealtThisFight,
    rank: agent.rank,
    headToHeadWins: agent.headToHeadWins,
    headToHeadLosses: agent.headToHeadLosses,
    strategySummary,
  };
}

export function buildBettingFeedPayload(params: {
  sourceEpoch: number;
  seq: number;
  emittedAt: number;
  cycle: StreamingDuelCycle | null;
  rendererHealth?: BettingFeedRendererHealth | null;
  terminal?: BettingFeedTerminalOverride | null;
}): BettingFeedPayload {
  const cycle = params.cycle;
  const terminal = params.terminal ?? null;
  return {
    schemaVersion: BETTING_FEED_SCHEMA_VERSION,
    sourceEpoch: params.sourceEpoch,
    seq: params.seq,
    emittedAt: params.emittedAt,
    duelId: cycle?.duelId ?? null,
    duelKey: cycle?.duelKeyHex ?? null,
    competitiveSnapshotVersion: cycle?.competitiveSnapshotVersion ?? null,
    competitiveSnapshotDigest: cycle?.competitiveSnapshotDigest ?? null,
    competitiveSnapshot: cycle?.competitiveSnapshot ?? null,
    phase: cycle?.phase ?? null,
    phaseVersion: cycle?.phaseVersion ?? 0,
    betOpenTime: cycle?.betOpenTime ?? null,
    betCloseTime: cycle?.betCloseTime ?? null,
    fightStartTime: cycle?.fightStartTime ?? null,
    duelEndTime: terminal?.duelEndTime ?? cycle?.duelEndTime ?? null,
    winnerId: cycle?.winnerId ?? null,
    winnerName: cycle ? resolveWinnerName(cycle) : null,
    outcome: terminal?.outcome ?? cycle?.outcome ?? null,
    cancellationReason: terminal?.cancellationReason ?? null,
    winReason: cycle?.winReason ?? null,
    seed: cycle?.seed ?? null,
    replayHash: cycle?.replayHash ?? null,
    agent1: toAgentSnapshot(cycle?.agent1 ?? null, cycle),
    agent2: toAgentSnapshot(cycle?.agent2 ?? null, cycle),
    arenaPositions: cycle?.arenaPositions ?? null,
    rendererHealth: params.rendererHealth ?? null,
  };
}

export function buildBettingFeedDedupKey(payload: BettingFeedPayload): string {
  return JSON.stringify({
    ...payload,
    seq: 0,
    emittedAt: 0,
    rendererHealth: payload.rendererHealth
      ? {
          ready: payload.rendererHealth.ready,
          degradedReason: payload.rendererHealth.degradedReason,
          updatedAt: 0,
        }
      : null,
  });
}

export function selectReplayDelivery(
  frames: BettingFeedFrame[],
  sinceSeq: number,
): ReplayDelivery {
  if (frames.length === 0) {
    return {
      mode: "bootstrap",
      frames: [],
      latestFrame: null,
      oldestSeq: null,
    };
  }

  const oldestSeq = frames[0]?.seq ?? null;
  const latestFrame = frames[frames.length - 1] ?? null;

  if (sinceSeq <= 0 || latestFrame === null) {
    return {
      mode: "bootstrap",
      frames: [],
      latestFrame,
      oldestSeq,
    };
  }

  if (oldestSeq !== null && sinceSeq < oldestSeq) {
    return {
      mode: "reset",
      frames: [],
      latestFrame,
      oldestSeq,
    };
  }

  if (latestFrame && sinceSeq > latestFrame.seq) {
    return {
      mode: "reset",
      frames: [],
      latestFrame,
      oldestSeq: oldestSeq ?? latestFrame.seq,
    };
  }

  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((frames[mid]?.seq ?? 0) <= sinceSeq) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  if (low >= frames.length) {
    return {
      mode: "live",
      frames: [],
      latestFrame,
      oldestSeq: oldestSeq ?? latestFrame.seq,
    };
  }

  return {
    mode: "replay",
    frames: frames.slice(low),
    latestFrame,
    oldestSeq,
  };
}
