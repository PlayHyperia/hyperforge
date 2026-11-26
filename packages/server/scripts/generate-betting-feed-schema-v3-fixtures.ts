import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BETTING_FEED_SCHEMA_VERSION,
  buildBettingFeedPayload,
  type BettingFeedPayload,
  type BettingFeedTerminalOverride,
} from "../src/routes/streaming-betting-feed.js";
import {
  STREAMING_TIMING,
  type StreamingDuelCycle,
  type StreamingDuelWinReason,
  type StreamingPhase,
} from "../src/systems/StreamingDuelScheduler/types.js";
import {
  finalizeCompetitiveSnapshot,
  type CompetitiveSnapshotContestant,
} from "../src/systems/StreamingDuelScheduler/competitive-snapshot.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "../src/systems/StreamingDuelScheduler/competitive-tactical-strategy.js";

type ExpectedTerminalDisposition =
  | { action: "settle"; winnerSide: "A" | "B" }
  | { action: "cancel"; outcome: "draw" | "cancelled"; reason: string }
  | null;

export type BettingFeedSchemaV3ContractCase = {
  name: string;
  expected: {
    callbacks: Array<"start" | "lock" | "end">;
    terminalDisposition: ExpectedTerminalDisposition;
  };
  payload: BettingFeedPayload;
};

export type BettingFeedSchemaV3ContractFixture = {
  contract: "hyperia-betting-feed";
  schemaVersion: 3;
  producer: string;
  cases: BettingFeedSchemaV3ContractCase[];
};

const SOURCE_EPOCH = 1_785_829_600_000;
const BASE_TIME = 1_785_829_601_000;
const BET_CLOSE_TIME = BASE_TIME + 60_000;
const FIGHT_START_TIME = BET_CLOSE_TIME + STREAMING_TIMING.COUNTDOWN_DURATION;

function deriveDuelKey(cycleId: string): string {
  return createHash("sha256")
    .update(`hyperia-streaming-duel:${cycleId}`)
    .digest("hex");
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function createSnapshotContestant(input: {
  side: "agent1" | "agent2";
  agentId: string;
  name: string;
  provider: string;
  model: string;
  combatLevel: number;
  wins: number;
  losses: number;
  rank: number;
  headToHeadWins: number;
  headToHeadLosses: number;
}): CompetitiveSnapshotContestant {
  const policyFingerprint = createHash("sha256")
    .update(`fixture-policy:${input.agentId}`)
    .digest("hex");
  const loadoutFingerprint = createHash("sha256")
    .update(`fixture-loadout:${input.agentId}`)
    .digest("hex");
  return {
    side: input.side,
    agentId: input.agentId,
    name: input.name,
    provider: input.provider,
    model: input.model,
    combatLevel: input.combatLevel,
    startingHp: 30,
    maxHp: 30,
    wins: input.wins,
    losses: input.losses,
    rank: input.rank,
    headToHeadWins: input.headToHeadWins,
    headToHeadLosses: input.headToHeadLosses,
    loadoutFingerprint,
    equipment: [{ slot: "weapon", itemId: "iron_sword", quantity: 1 }],
    inventory: [{ slot: 0, itemId: "shark", quantity: 3 }],
    selectedSpell: null,
    skillLevels: [
      { skill: "attack", level: 40 },
      { skill: "constitution", level: 30 },
      { skill: "defense", level: 40 },
      { skill: "strength", level: 40 },
    ],
    prayer: {
      pointUnits: 300,
      points: 30,
      maxPoints: 30,
      activePrayers: [],
    },
    initialCombatStyle: "melee",
    availableCombatStyles: ["melee"],
    combatLoadouts: {
      melee: {
        role: "melee",
        weaponId: "iron_sword",
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
      primaryStyle: "melee",
      availableStyles: ["melee"],
      planningSource: "deterministic",
      planningPolicyVersion: "fixture-policy-v1",
      agentPolicyFingerprint: policyFingerprint,
      modelProvider: input.provider,
      model: input.model,
      tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy("melee"),
    },
  };
}

function createCycle(
  suffix: string,
  phase: StreamingPhase,
  overrides: Partial<StreamingDuelCycle> = {},
): StreamingDuelCycle {
  const cycleId = `contract-${suffix}`;
  const duelId = `streaming-${cycleId}`;
  const duelKeyHex = deriveDuelKey(cycleId);
  const competitive = finalizeCompetitiveSnapshot({
    persisted: true,
    frozenAt: BASE_TIME,
    betWindowDurationMs: 60_000,
    timing: {
      contractVersion: STREAMING_TIMING.CONTRACT_VERSION,
      timeoutPolicy: STREAMING_TIMING.TIMEOUT_POLICY,
      countdownDurationMs: STREAMING_TIMING.COUNTDOWN_DURATION,
      fightingDurationMs: STREAMING_TIMING.FIGHTING_DURATION,
      endWarningDurationMs: STREAMING_TIMING.END_WARNING_DURATION,
      maxFightDurationMs: STREAMING_TIMING.MAX_FIGHT_DURATION,
    },
    draft: {
      diagnostic: false,
      preparationId: deterministicUuid(`fixture-preparation:${cycleId}`),
      cycleId,
      duelId,
      duelKey: duelKeyHex,
      contestants: [
        createSnapshotContestant({
          side: "agent1",
          agentId: "agent-a",
          name: "Agent Alpha",
          provider: "openai",
          model: "agent-alpha-v1",
          combatLevel: 42,
          wins: 12,
          losses: 4,
          rank: 1,
          headToHeadWins: 3,
          headToHeadLosses: 2,
        }),
        createSnapshotContestant({
          side: "agent2",
          agentId: "agent-b",
          name: "Agent Beta",
          provider: "anthropic",
          model: "agent-beta-v1",
          combatLevel: 41,
          wins: 10,
          losses: 6,
          rank: 2,
          headToHeadWins: 2,
          headToHeadLosses: 3,
        }),
      ],
    },
  });
  return {
    cycleId,
    phase,
    cycleStartTime: BASE_TIME,
    phaseStartTime: BASE_TIME,
    phaseVersion: 1,
    agent1: {
      characterId: "agent-a",
      name: "Agent Alpha",
      provider: "openai",
      model: "agent-alpha-v1",
      combatLevel: 42,
      wins: 12,
      losses: 4,
      currentHp: 30,
      maxHp: 30,
      originalPosition: [12, 0, -8],
      damageDealtThisFight: 0,
      highestHit: 0,
      attacksLanded: 0,
      healsUsed: 0,
      equipment: {},
      inventory: [],
      itemIconPaths: {},
      rank: 1,
      headToHeadWins: 3,
      headToHeadLosses: 2,
    },
    agent2: {
      characterId: "agent-b",
      name: "Agent Beta",
      provider: "anthropic",
      model: "agent-beta-v1",
      combatLevel: 41,
      wins: 10,
      losses: 6,
      currentHp: 30,
      maxHp: 30,
      originalPosition: [-12, 0, 8],
      damageDealtThisFight: 0,
      highestHit: 0,
      attacksLanded: 0,
      healsUsed: 0,
      equipment: {},
      inventory: [],
      itemIconPaths: {},
      rank: 2,
      headToHeadWins: 2,
      headToHeadLosses: 3,
    },
    duelId,
    duelKeyHex,
    competitiveSnapshotVersion: competitive.snapshot.snapshotVersion,
    competitiveSnapshotDigest: competitive.digest,
    competitiveSnapshot: competitive.snapshot,
    arenaId: 1,
    betOpenTime: BASE_TIME,
    betCloseTime: BET_CLOSE_TIME,
    countdownValue: null,
    fightStartTime: null,
    duelEndTime: null,
    arenaPositions: {
      agent1: [-1, 0, 0],
      agent2: [1, 0, 0],
    },
    winnerId: null,
    loserId: null,
    outcome: null,
    winReason: null,
    seed: null,
    replayHash: null,
    ...overrides,
  };
}

function buildOracleProof(
  cycle: StreamingDuelCycle,
  winnerId: string | null,
  loserId: string | null,
  winReason: StreamingDuelWinReason,
  finishedAt: number,
): { seed: string; replayHash: string } {
  const duelId = cycle.duelId ?? `streaming-${cycle.cycleId}`;
  const fightStartedAt = cycle.fightStartTime ?? cycle.cycleStartTime;
  const seedHex = createHash("sha256")
    .update(`${duelId}-${fightStartedAt}`)
    .digest("hex")
    .slice(0, 16);
  return {
    seed: BigInt(`0x${seedHex}`).toString(),
    replayHash: createHash("sha256")
      .update(
        JSON.stringify({
          duelId,
          cycleId: cycle.cycleId,
          winnerId,
          loserId,
          winReason,
          fightStartedAt,
          finishedAt,
          agent1Id: cycle.agent1?.characterId ?? null,
          agent2Id: cycle.agent2?.characterId ?? null,
          damageAgent1: cycle.agent1?.damageDealtThisFight ?? 0,
          damageAgent2: cycle.agent2?.damageDealtThisFight ?? 0,
        }),
      )
      .digest("hex"),
  };
}

function buildCase(input: {
  name: string;
  seq: number;
  cycle: StreamingDuelCycle | null;
  terminal?: BettingFeedTerminalOverride;
  callbacks: Array<"start" | "lock" | "end">;
  terminalDisposition?: ExpectedTerminalDisposition;
}): BettingFeedSchemaV3ContractCase {
  const nominalEmittedAt = BASE_TIME + input.seq * 1_000;
  const phaseBoundary =
    input.cycle?.phase === "COUNTDOWN"
      ? input.cycle.betCloseTime
      : input.cycle?.phase === "FIGHTING" || input.cycle?.phase === "RESOLUTION"
        ? (input.cycle.fightStartTime ?? input.cycle.betCloseTime)
        : null;
  const emittedAt = Math.max(
    nominalEmittedAt,
    phaseBoundary ?? 0,
    input.cycle?.duelEndTime ?? 0,
  );
  return {
    name: input.name,
    expected: {
      callbacks: input.callbacks,
      terminalDisposition: input.terminalDisposition ?? null,
    },
    payload: buildBettingFeedPayload({
      sourceEpoch: SOURCE_EPOCH,
      seq: input.seq,
      emittedAt,
      cycle: input.cycle,
      terminal: input.terminal,
      rendererHealth: {
        ready: true,
        degradedReason: null,
        updatedAt: emittedAt,
      },
    }),
  };
}

function terminalWinCase(input: {
  name: string;
  seq: number;
  winnerId: "agent-a" | "agent-b";
  reason: Exclude<StreamingDuelWinReason, "draw">;
}): BettingFeedSchemaV3ContractCase {
  const loserId = input.winnerId === "agent-a" ? "agent-b" : "agent-a";
  const finishedAt = FIGHT_START_TIME + input.seq * 1_000;
  const baseCycle = createCycle(input.name, "RESOLUTION", {
    phaseVersion: 4,
    fightStartTime: FIGHT_START_TIME,
    duelEndTime: finishedAt,
    winnerId: input.winnerId,
    loserId,
    outcome: "win",
    winReason: input.reason,
  });
  const proof = buildOracleProof(
    baseCycle,
    input.winnerId,
    loserId,
    input.reason,
    finishedAt,
  );
  return buildCase({
    name: input.name,
    seq: input.seq,
    cycle: { ...baseCycle, ...proof },
    callbacks: ["start", "lock", "end"],
    terminalDisposition: {
      action: "settle",
      winnerSide: input.winnerId === "agent-a" ? "A" : "B",
    },
  });
}

function refundCase(input: {
  name: string;
  seq: number;
  phase: StreamingPhase;
  outcome: "draw" | "cancelled";
  reason: string;
  arenaReleased?: boolean;
}): BettingFeedSchemaV3ContractCase {
  const duelEndTime =
    input.phase === "ANNOUNCEMENT"
      ? BASE_TIME + input.seq * 1_000
      : FIGHT_START_TIME + input.seq * 1_000;
  const cycle = createCycle(input.name, input.phase, {
    phaseVersion: input.phase === "ANNOUNCEMENT" ? 1 : 3,
    fightStartTime: input.phase === "ANNOUNCEMENT" ? null : FIGHT_START_TIME,
    duelEndTime,
    outcome: input.outcome === "draw" ? "draw" : null,
    winReason: input.outcome === "draw" ? "draw" : null,
    ...(input.arenaReleased ? { arenaPositions: null } : {}),
  });
  const proof =
    input.outcome === "draw"
      ? buildOracleProof(cycle, null, null, "draw", duelEndTime)
      : { seed: null, replayHash: null };
  return buildCase({
    name: input.name,
    seq: input.seq,
    cycle: { ...cycle, ...proof },
    terminal: {
      outcome: input.outcome,
      cancellationReason: input.reason,
      duelEndTime,
    },
    callbacks: ["end"],
    terminalDisposition: {
      action: "cancel",
      outcome: input.outcome,
      reason: input.reason,
    },
  });
}

export function buildBettingFeedSchemaV3ContractFixture(): BettingFeedSchemaV3ContractFixture {
  const announcement = createCycle("announcement", "ANNOUNCEMENT");
  const countdown = createCycle("countdown", "COUNTDOWN", {
    phaseVersion: 2,
    countdownValue: 3,
    fightStartTime: FIGHT_START_TIME,
  });
  const fighting = createCycle("fighting", "FIGHTING", {
    phaseVersion: 3,
    fightStartTime: FIGHT_START_TIME,
  });

  const refundDefinitions: Array<{
    name: string;
    phase: StreamingPhase;
    outcome: "draw" | "cancelled";
    reason: string;
    arenaReleased?: boolean;
  }> = [
    {
      name: "draw",
      phase: "RESOLUTION",
      outcome: "draw",
      reason: "draw",
    },
    {
      name: "cancel-contestant-prep-failed",
      phase: "ANNOUNCEMENT",
      outcome: "cancelled",
      reason: "contestant_prep_failed",
    },
    {
      name: "cancel-both-agents-lost-during-prep",
      phase: "ANNOUNCEMENT",
      outcome: "cancelled",
      reason: "both_agents_lost_during_prep",
    },
    {
      name: "cancel-arena-teleport-failed",
      phase: "ANNOUNCEMENT",
      outcome: "cancelled",
      reason: "arena_teleport_failed",
    },
    {
      name: "cancel-both-agents-missing",
      phase: "FIGHTING",
      outcome: "cancelled",
      reason: "both_agents_missing",
    },
    {
      name: "cancel-combat-engagement-failed",
      phase: "FIGHTING",
      outcome: "cancelled",
      reason: "combat_engagement_failed",
    },
    {
      name: "cancel-no-combat-activity",
      phase: "FIGHTING",
      outcome: "cancelled",
      reason: "no_combat_activity",
    },
    {
      name: "cancel-watchdog-announcement-timeout",
      phase: "ANNOUNCEMENT",
      outcome: "cancelled",
      reason: "watchdog_announcement_timeout",
    },
    {
      name: "cancel-watchdog-fighting-timeout",
      phase: "FIGHTING",
      outcome: "cancelled",
      reason: "watchdog_fighting_timeout",
    },
    {
      name: "cancel-competitive-snapshot-recovery-window-elapsed",
      phase: "ANNOUNCEMENT",
      outcome: "cancelled",
      reason: "competitive_snapshot_recovery_window_elapsed",
      arenaReleased: true,
    },
    {
      name: "cancel-scheduler-shutdown",
      phase: "FIGHTING",
      outcome: "cancelled",
      reason: "scheduler_shutdown",
    },
  ];

  return {
    contract: "hyperia-betting-feed",
    schemaVersion: BETTING_FEED_SCHEMA_VERSION,
    producer:
      "packages/server/src/routes/streaming-betting-feed.ts#buildBettingFeedPayload",
    cases: [
      buildCase({
        name: "idle",
        seq: 1,
        cycle: null,
        callbacks: [],
      }),
      buildCase({
        name: "announcement",
        seq: 2,
        cycle: announcement,
        callbacks: ["start"],
      }),
      buildCase({
        name: "countdown",
        seq: 3,
        cycle: countdown,
        callbacks: ["start", "lock"],
      }),
      buildCase({
        name: "fighting",
        seq: 4,
        cycle: fighting,
        callbacks: ["start", "lock"],
      }),
      terminalWinCase({
        name: "win-agent-a-kill",
        seq: 5,
        winnerId: "agent-a",
        reason: "kill",
      }),
      terminalWinCase({
        name: "win-agent-b-forfeit",
        seq: 6,
        winnerId: "agent-b",
        reason: "forfeit",
      }),
      ...refundDefinitions.map((definition, index) =>
        refundCase({ ...definition, seq: index + 7 }),
      ),
    ],
  };
}

export function serializeBettingFeedSchemaV3ContractFixture(): string {
  return `${JSON.stringify(buildBettingFeedSchemaV3ContractFixture(), null, 2)}\n`;
}

const outputPath = fileURLToPath(
  new URL(
    "../tests/fixtures/hyperbet/betting-feed-schema-v3.json",
    import.meta.url,
  ),
);

if (import.meta.main) {
  const next = serializeBettingFeedSchemaV3ContractFixture();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(outputPath, "utf8");
    } catch {
      // A missing fixture is drift and must fail the contract gate.
    }
    if (current !== next) {
      console.error(
        `Betting-feed schema-v3 fixture drifted. Regenerate ${outputPath}`,
      );
      process.exitCode = 1;
    } else {
      console.log(`Betting-feed schema-v3 fixture is current: ${outputPath}`);
    }
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, next, "utf8");
    console.log(`Wrote betting-feed schema-v3 fixture: ${outputPath}`);
  }
}
