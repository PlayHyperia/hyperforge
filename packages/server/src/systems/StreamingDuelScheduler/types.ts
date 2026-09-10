/**
 * StreamingDuelScheduler Types
 *
 * Types for the 15-minute duel cycle streaming mode
 */

import type { DuelPreparationStatus } from "./preparation";
import type { CompetitiveSnapshot } from "./competitive-snapshot.js";
import {
  STREAMING_DUEL_TIMEOUT_POLICY,
  STREAMING_DUEL_TIMING_CONTRACT_VERSION,
} from "./competitive-timing-policy.js";
import type {
  StreamingDuelActionObservation,
  StreamingDuelPreparationSummary,
  StreamingDuelStrategySummary,
} from "@hyperforge/shared";

export type StreamingPhase =
  "IDLE" | "ANNOUNCEMENT" | "COUNTDOWN" | "FIGHTING" | "RESOLUTION";

export type StreamingDuelOutcome = "win" | "draw";
export type StreamingDuelHistoryOutcome = StreamingDuelOutcome | "cancelled";
export type StreamingDuelWinReason =
  "kill" | "forfeit" | "hp_advantage" | "damage_advantage" | "draw";

export type SwitchableStreamingCombatRole = "melee" | "ranged" | "mage";
export const MAX_DUEL_PREPARATION_OPPONENT_HISTORY = 8;
export const FROZEN_STREAMING_ARMOR_SLOTS = [
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
  "cape",
  "amulet",
  "ring",
] as const;
export type FrozenStreamingArmorSlot =
  (typeof FROZEN_STREAMING_ARMOR_SLOTS)[number];
export type FrozenStreamingArmorIds = Record<
  FrozenStreamingArmorSlot,
  string | null
>;

/** Exact pre-market item/spell allowlist for one switchable combat role. */
export interface FrozenStreamingCombatLoadout {
  role: SwitchableStreamingCombatRole;
  weaponId: string;
  arrowsId: string | null;
  shieldId: string | null;
  spellId: string | null;
  /** Present on schema-v3 snapshots; omitted only for legacy frozen cycles. */
  armorIds?: FrozenStreamingArmorIds;
}

export type FrozenStreamingCombatLoadouts = Partial<
  Record<SwitchableStreamingCombatRole, FrozenStreamingCombatLoadout>
>;

export interface AgentContestant {
  characterId: string;
  name: string;
  provider: string;
  model: string;
  combatLevel: number;
  wins: number;
  losses: number;
  currentHp: number;
  maxHp: number;
  originalPosition: [number, number, number];
  damageDealtThisFight: number;
  highestHit: number;
  attacksLanded: number;
  healsUsed: number;
  equipment: Record<string, string>;
  inventory: Array<{ itemId: string; quantity: number } | null>;
  /** itemId → manifest iconPath; streaming client resolves URLs (may lack local ITEMS). */
  itemIconPaths: Record<string, string>;
  /** Immutable pre-market loadout digest; null only for local diagnostic bots. */
  loadoutFingerprint: string | null;
  /** Combat styles supported by gear and supplies present at market open. */
  availableCombatStyles: Array<"melee" | "ranged" | "mage" | "prayer">;
  /** Exact role-specific gear/spell choices permitted after market open. */
  combatLoadouts: FrozenStreamingCombatLoadouts;
  /** True for conserved competitive custody or an exact local diagnostic switch map. */
  loadoutFrozen: boolean;
  /** Exact fixed-point prayer resource frozen before the market opens. */
  prayerPointUnits: number;
  /** Display prayer points derived from the exact frozen units. */
  prayerPoints: number;
  prayerMaxPoints: number;
  rank: number;
  headToHeadWins: number;
  headToHeadLosses: number;
}

export interface StreamingDuelCycle {
  cycleId: string;
  phase: StreamingPhase;

  // Timing (all in milliseconds)
  cycleStartTime: number;
  phaseStartTime: number;
  phaseVersion: number;

  // Contestants (null during IDLE)
  agent1: AgentContestant | null;
  agent2: AgentContestant | null;

  // Active duel tracking
  duelId: string | null;
  duelKeyHex: string | null;
  competitiveSnapshotVersion: number | null;
  competitiveSnapshotDigest: string | null;
  competitiveSnapshot: CompetitiveSnapshot | null;
  arenaId: number | null;
  betOpenTime: number | null;
  betCloseTime: number | null;
  countdownValue: number | null; // 3, 2, 1, 0
  fightStartTime: number | null;
  firstHitAt?: number | null;
  duelEndTime: number | null;
  arenaPositions: {
    agent1: [number, number, number];
    agent2: [number, number, number];
  } | null;

  // Result (set during RESOLUTION)
  winnerId: string | null;
  loserId: string | null;
  outcome: StreamingDuelOutcome | null;
  winReason: StreamingDuelWinReason | null;
  seed: string | null;
  replayHash: string | null;

  /** Internal restart-recovery marker; never accepted from public input. */
  recoveredFromPersistence?: boolean;
}

export interface AgentDuelStats {
  characterId: string;
  agentName: string;
  provider: string;
  model: string;
  wins: number;
  losses: number;
  draws: number;
  totalDamageDealt: number;
  totalDamageTaken: number;
  killStreak: number;
  currentStreak: number;
  lastDuelAt: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  characterId: string;
  name: string;
  provider: string;
  model: string;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  combatLevel: number;
  currentStreak: number;
}

export interface RecentDuelEntry {
  cycleId: string;
  duelId: string | null;
  finishedAt: number;
  outcome: StreamingDuelHistoryOutcome;
  agent1Id: string | null;
  agent1Name: string | null;
  agent1OpeningStyle: SwitchableStreamingCombatRole | null;
  agent2Id: string | null;
  agent2Name: string | null;
  agent2OpeningStyle: SwitchableStreamingCombatRole | null;
  winnerId: string | null;
  winnerName: string | null;
  loserId: string | null;
  loserName: string | null;
  winReason: StreamingDuelWinReason | null;
  cancellationReason: string | null;
  damageAgent1: number;
  damageAgent2: number;
  damageWinner: number | null;
  damageLoser: number | null;
}

/**
 * Bounded, participant-relative history supplied to private duel preparation.
 * It contains only immutable outcome data and frozen opening styles; inventory,
 * equipment identifiers, and private preparation details never cross this
 * scheduler event boundary.
 */
export interface DuelPreparationOpponentHistoryEntry {
  cycleId: string;
  finishedAt: number;
  result: "win" | "loss" | "draw";
  ownOpeningStyle: SwitchableStreamingCombatRole | null;
  opponentOpeningStyle: SwitchableStreamingCombatRole | null;
  ownDamage: number;
  opponentDamage: number;
  winReason: StreamingDuelWinReason;
}

export interface StreamingCombatEngagementMetrics {
  checks: number;
  retries: number;
  recoveries: number;
  failures: number;
  proximityCorrections: number;
  currentRetryCount: number;
}

export interface StreamingDuelOperationalMetrics {
  emittedAt: number;
  historyWindow: {
    size: number;
    maxSize: number;
    wins: number;
    draws: number;
    completed: number;
    cancelled: number;
    terminal: number;
    completionRate: number | null;
    cancellationReasons: Record<string, number>;
  };
  engagement: StreamingCombatEngagementMetrics;
  actionObservations: {
    configured: boolean;
    healthy: boolean;
    pending: number;
    persisted: number;
    replayed: number;
    rejected: number;
    persistenceErrors: number;
  };
  current: {
    cycleId: string | null;
    phase: StreamingPhase;
    firstHitLatencyMs: number | null;
    recoveryInProgress: boolean;
    schedulerState: "IDLE" | "WAITING_FOR_AGENTS" | "ACTIVE";
    availableAgents: number;
    requiredAgents: number;
    preparation: {
      enabled: boolean;
      gateInFlight: boolean;
      selectionInFlight: boolean;
      status: DuelPreparationStatus | null;
      expiresAt: number | null;
    };
  };
}

export interface StreamingCycleAgent {
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
  highestHit: number;
  attacksLanded: number;
  healsUsed: number;
  equipment: Record<string, string>;
  inventory: Array<{ itemId: string; quantity: number } | null>;
  itemIconPaths: Record<string, string>;
  loadoutFingerprint: string | null;
  availableCombatStyles: Array<"melee" | "ranged" | "mage" | "prayer">;
  combatLoadouts: FrozenStreamingCombatLoadouts;
  loadoutFrozen: boolean;
  /** Strict frozen strategy disclosure; null for idle or unsupported legacy state. */
  strategySummary: StreamingDuelStrategySummary | null;
  prayerPointUnits: number;
  prayerPoints: number;
  prayerMaxPoints: number;
  rank: number;
  headToHeadWins: number;
  headToHeadLosses: number;
}

export interface StreamingTerminalNotice {
  cycleId: string;
  duelId: string | null;
  outcome: "cancelled";
  reason: string;
  occurredAt: number;
  expiresAt: number;
  agent1Id: string | null;
  agent1Name: string | null;
  agent2Id: string | null;
  agent2Name: string | null;
}

export interface StreamingStateUpdate {
  type: "STREAMING_STATE_UPDATE";
  cycle: {
    cycleId: string;
    phase: StreamingPhase;
    cycleStartTime: number;
    phaseStartTime: number;
    phaseEndTime: number;
    phaseVersion: number;
    timeRemaining: number;

    agent1: StreamingCycleAgent | null;
    agent2: StreamingCycleAgent | null;

    duelId: string | null;
    duelKeyHex: string | null;
    competitiveSnapshotVersion: number | null;
    competitiveSnapshotDigest: string | null;
    competitiveSnapshot: CompetitiveSnapshot | null;
    betOpenTime: number | null;
    betCloseTime: number | null;
    countdown: number | null;
    fightStartTime: number | null;
    firstHitAt: number | null;
    duelEndTime: number | null;
    arenaPositions: {
      agent1: [number, number, number];
      agent2: [number, number, number];
    } | null;
    winnerId: string | null;
    winnerName: string | null;
    outcome: StreamingDuelOutcome | null;
    winReason: string | null;
    seed: string | null;
    replayHash: string | null;
    /** Immutable bounded tail of exact server-authored public fight actions. */
    actionObservations: readonly StreamingDuelActionObservation[];
  };
  leaderboard: LeaderboardEntry[];
  cameraTarget: string | null;
  terminalNotice: StreamingTerminalNotice | null;
  /** Bounded public truth for the exact selected pre-market contestants. */
  preparation?: StreamingDuelPreparationSummary | null;
}

const parseDurationEnv = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallbackMs: number,
  minMs: number,
): number => {
  const configured = env[key];
  if (configured === undefined) return fallbackMs;
  const raw = configured.trim();

  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${key} must be a base-10 integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minMs) {
    throw new Error(`${key} must be a safe integer of at least ${minMs}`);
  }
  return parsed;
};

const DEV_ANNOUNCEMENT_MS = 60 * 1000;
const DEV_FIGHTING_MS = 270 * 1000;
const DEV_END_WARNING_MS = 15 * 1000;
const DEV_RESOLUTION_MS = 10 * 1000;

export {
  STREAMING_DUEL_TIMEOUT_POLICY,
  STREAMING_DUEL_TIMING_CONTRACT_VERSION,
} from "./competitive-timing-policy.js";

export type StreamingDuelTimingContract = Readonly<{
  CONTRACT_VERSION: typeof STREAMING_DUEL_TIMING_CONTRACT_VERSION;
  TIMEOUT_POLICY: typeof STREAMING_DUEL_TIMEOUT_POLICY;
  /** Pre-market deadline; null only when private preparation is disabled. */
  PREPARATION_DURATION: number | null;
  CYCLE_DURATION: number;
  ANNOUNCEMENT_DURATION: number;
  FIGHTING_DURATION: number;
  END_WARNING_DURATION: number;
  MAX_FIGHT_DURATION: number;
  RESOLUTION_DURATION: number;
  COUNTDOWN_TICKS: number;
  COUNTDOWN_DURATION: number;
  STATE_BROADCAST_INTERVAL: number;
  FIGHT_BROADCAST_INTERVAL: number;
  INTER_CYCLE_DELAY_MS: number;
}>;

export function resolveStreamingPreparationDuration(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (env.STREAMING_DUEL_PREPARATION_MS === undefined) return null;
  const raw = env.STREAMING_DUEL_PREPARATION_MS.trim();
  if (!/^\d+$/u.test(raw)) {
    throw new Error("STREAMING_DUEL_PREPARATION_MS must be a base-10 integer");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) {
    throw new Error(
      "STREAMING_DUEL_PREPARATION_MS must be a safe integer of at least 1000",
    );
  }
  return parsed;
}

/**
 * Optional minimum time that an authoritative ready preparation remains
 * publicly observable before market publication. This is a presentation
 * floor, not an extension of the private preparation deadline; when too little
 * time remains, the existing deadline expires the preparation fail-closed.
 */
export function resolveStreamingPublicPreparationMinimumDuration(
  env: NodeJS.ProcessEnv = process.env,
  preparationDurationMs = resolveStreamingPreparationDuration(env),
): number {
  if (env.STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS === undefined) return 0;
  const raw = env.STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS.trim();
  if (!/^\d+$/u.test(raw)) {
    throw new Error(
      "STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS must be a base-10 integer",
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      "STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS must be a safe integer",
    );
  }
  if (parsed === 0) return 0;
  if (parsed < 1_000) {
    throw new Error(
      "STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS must be zero or at least 1000",
    );
  }
  if (preparationDurationMs === null) {
    throw new Error(
      "STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS requires STREAMING_DUEL_PREPARATION_MS",
    );
  }
  if (parsed >= preparationDurationMs) {
    throw new Error(
      "STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS must be below STREAMING_DUEL_PREPARATION_MS",
    );
  }
  return parsed;
}

/**
 * Resolve the earliest market-publication time from the later authoritative
 * contestant readiness receipt. Selection time cannot prove that spectators
 * saw the completed loadouts, especially when planning consumes most of the
 * configured preparation floor.
 */
export function resolveStreamingPublicPreparationReleaseAt(
  preparation: Readonly<{
    selectedAt: number;
    expiresAt: number;
    agent1ReadyAt: number | null;
    agent2ReadyAt: number | null;
  }>,
  minimumDurationMs: number,
): number {
  const timestamps = [
    preparation.selectedAt,
    preparation.expiresAt,
    preparation.agent1ReadyAt,
    preparation.agent2ReadyAt,
  ];
  if (
    !Number.isSafeInteger(minimumDurationMs) ||
    minimumDurationMs < 0 ||
    timestamps.some(
      (timestamp) =>
        timestamp === null || !Number.isSafeInteger(timestamp) || timestamp < 0,
    ) ||
    preparation.expiresAt <= preparation.selectedAt ||
    preparation.agent1ReadyAt! < preparation.selectedAt ||
    preparation.agent2ReadyAt! < preparation.selectedAt ||
    preparation.agent1ReadyAt! > preparation.expiresAt ||
    preparation.agent2ReadyAt! > preparation.expiresAt
  ) {
    throw new Error("invalid ready preparation presentation window");
  }
  const readyAt = Math.max(
    preparation.agent1ReadyAt!,
    preparation.agent2ReadyAt!,
  );
  const releaseAt = readyAt + minimumDurationMs;
  if (!Number.isSafeInteger(releaseAt)) {
    throw new Error(
      "ready preparation presentation window exceeds safe integers",
    );
  }
  return Math.min(preparation.expiresAt, releaseAt);
}

export function resolveStreamingDuelTiming(
  env: NodeJS.ProcessEnv = process.env,
): StreamingDuelTimingContract {
  const PREPARATION_DURATION = resolveStreamingPreparationDuration(env);
  const ANNOUNCEMENT_DURATION = parseDurationEnv(
    env,
    "STREAMING_ANNOUNCEMENT_MS",
    DEV_ANNOUNCEMENT_MS,
    1000,
  );
  const FIGHTING_DURATION = parseDurationEnv(
    env,
    "STREAMING_FIGHTING_MS",
    DEV_FIGHTING_MS,
    5000,
  );
  const END_WARNING_DURATION = parseDurationEnv(
    env,
    "STREAMING_END_WARNING_MS",
    DEV_END_WARNING_MS,
    1000,
  );
  const RESOLUTION_DURATION = parseDurationEnv(
    env,
    "STREAMING_RESOLUTION_MS",
    DEV_RESOLUTION_MS,
    1000,
  );
  const COUNTDOWN_TICKS = parseDurationEnv(
    env,
    "STREAMING_COUNTDOWN_TICKS",
    3,
    1,
  );
  const INTER_CYCLE_DELAY_MS = parseDurationEnv(
    env,
    "STREAMING_INTER_CYCLE_DELAY_MS",
    5000,
    1000,
  );
  const COUNTDOWN_DURATION = (COUNTDOWN_TICKS + 1) * 1000;
  const MAX_FIGHT_DURATION = FIGHTING_DURATION + END_WARNING_DURATION;
  const CYCLE_DURATION =
    ANNOUNCEMENT_DURATION +
    COUNTDOWN_DURATION +
    MAX_FIGHT_DURATION +
    RESOLUTION_DURATION;
  const safeValues = [COUNTDOWN_DURATION, MAX_FIGHT_DURATION, CYCLE_DURATION];
  if (!safeValues.every(Number.isSafeInteger)) {
    throw new Error("Streaming duel timing arithmetic exceeds safe integers");
  }

  return {
    CONTRACT_VERSION: STREAMING_DUEL_TIMING_CONTRACT_VERSION,
    TIMEOUT_POLICY: STREAMING_DUEL_TIMEOUT_POLICY,
    PREPARATION_DURATION,
    CYCLE_DURATION,
    ANNOUNCEMENT_DURATION,
    FIGHTING_DURATION,
    END_WARNING_DURATION,
    MAX_FIGHT_DURATION,
    RESOLUTION_DURATION,
    COUNTDOWN_TICKS,
    COUNTDOWN_DURATION,
    STATE_BROADCAST_INTERVAL: 1000,
    FIGHT_BROADCAST_INTERVAL: 200,
    /** Delay between end of one cycle's cleanup and start of the next cycle.
     * Gives spectators a visual reset and prevents stale avatar artifacts. */
    INTER_CYCLE_DELAY_MS,
  };
}

// Timing constants (in milliseconds). Explicit malformed configuration throws
// during module initialization instead of silently changing a live schedule.
export const STREAMING_TIMING = resolveStreamingDuelTiming();
