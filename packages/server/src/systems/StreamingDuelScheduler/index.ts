/**
 * StreamingDuelScheduler - 15-minute duel cycle for streaming mode
 *
 * Thin facade that orchestrates three extracted managers:
 * - MatchmakingManager: agent registration, stats, pair selection, leaderboard
 * - CameraDirector: camera targeting, activity tracking, idle preview
 * - DuelOrchestrator: combat preparation, execution, cleanup, duel flags
 *
 * The facade owns:
 * - Lifecycle (init, destroy, start, stop)
 * - Tick loop and state machine (handleIdleState, tick, phase transitions)
 * - Event subscriptions (subscribeToEvents)
 * - Broadcasting (broadcastState, getStreamingState)
 */

import type { World } from "@hyperforge/shared";
import {
  EventType,
  DEFAULT_DUEL_RULES,
  calculateCombatLevel,
  AVATAR_OPTIONS,
  DIAGNOSTIC_AVATAR_OPTIONS,
  CANONICAL_DUEL_AVATAR_URL,
  STREAMING_DUEL_PREPARATION_SUMMARY_SCHEMA_VERSION,
  STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITY_TRAIL_LIMIT,
  STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITIES,
  STREAMING_DUEL_PUBLIC_PREPARATION_MODES,
  acquirePreparationActionFence,
  isPlayerProcessingQuiescent,
  parseStreamingDuelPreparationSummary,
  registerStreamingDuelDamageAuthority,
  requestPlayerProcessingQuiescence,
  type PreparationActionFence,
  type StreamingDuelPreparationSummary,
  type StreamingDuelPublicPreparationActivity,
  type StreamingDuelPublicPreparationMode,
  type StreamingDuelStrategySummary,
  type StreamingDuelDamageObservationContext,
} from "@hyperforge/shared";
import crypto from "node:crypto";
import type pg from "pg";

/** Type for network with send method */
interface NetworkWithSend {
  send: <T>(name: string, data: T, ignoreSocketId?: string) => void;
  sendToSpectators?: <T>(name: string, data: T) => void;
  syncStreamingContestants?: (contestantIds: string[]) => void;
}

type DamageFencedResolution = {
  cycleId: string;
  winnerId: string | null;
  loserId: string | null;
  winReason: StreamingDuelWinReason;
  terminalAtOverride?: number;
  terminalState?: {
    terminalAt: number;
    seed: string;
    replayHash: string;
    persisted: boolean;
  };
};

type DamageFencedAbort = {
  cycleId: string;
  reason: string;
  occurredAtOverride?: number;
  terminalPersisted: boolean;
  cycleOverride?: StreamingDuelCycle;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};
import { Logger } from "../ServerNetwork/services";
import { v4 as uuidv4 } from "uuid";
import { errMsg } from "../../shared/errMsg.js";
import { isRetryablePostgresTransactionConflict } from "../../database/postgres-transaction.js";

const PRIVATE_PREPARATION_CONFLICT_RETRIES = 4;

/** Log once if agent_mappings.streaming_duel_enabled cannot be read (e.g. migration not applied). */
let streamingDuelPrefReadWarningLogged = false;
import {
  type StreamingDuelCycle,
  type AgentContestant,
  type StreamingStateUpdate,
  type LeaderboardEntry,
  type RecentDuelEntry,
  type StreamingDuelOperationalMetrics,
  type StreamingPhase,
  type StreamingDuelWinReason,
  type FrozenStreamingCombatLoadouts,
  type SwitchableStreamingCombatRole,
  resolveStreamingPublicPreparationMinimumDuration,
  resolveStreamingPublicPreparationReleaseAt,
  resolveStreamingPreparationDuration,
  STREAMING_TIMING,
} from "./types.js";
export {
  resolveStreamingPreparationDuration,
  resolveStreamingPublicPreparationMinimumDuration,
} from "./types.js";
import { MatchmakingManager } from "./managers/MatchmakingManager.js";
import { CameraDirector } from "./managers/CameraDirector.js";
import {
  DuelOrchestrator,
  isLocalDiagnosticDuelRuntime,
} from "./managers/DuelOrchestrator.js";
import { CycleStateMachine } from "./managers/CycleStateMachine.js";
import {
  DUEL_COMPETITIVE_RECOVERY_CUSTODY_HOLD_EVENT,
  DUEL_PREPARATION_BANK_ACTIONS,
  DUEL_PREPARATION_LOCAL_REVOCATION_EVENT,
  PostgresDuelPreparationStore,
  type DuelPreparationSnapshot,
  type PersistedCompetitiveSnapshot,
} from "./preparation.js";
import {
  resolveDuelPreparationHostLeaseConfig,
  type DuelPreparationHostLeaseConfig,
} from "./preparation-host-lease.js";
import {
  COMPETITIVE_SNAPSHOT_VERSION,
  competitiveSnapshotMismatchPaths,
  finalizeCompetitiveSnapshot,
  type CompetitiveSnapshotContestant,
  type CompetitiveSnapshotDraft,
  type CompetitivePreparationEvidence,
  type CompetitiveSnapshot,
  type CompetitiveSnapshotTimingInput,
} from "./competitive-snapshot.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "./competitive-tactical-strategy.js";
import { resolvePersistedStreamingDuelEligibility } from "../../eliza/agentPopulationPolicy.js";
import { sanitizePublicStreamingState } from "../../streaming/streaming-public-presentation.js";
import { buildCompetitiveTerminalProof } from "./competitive-terminal-proof.js";
import { toPublicStrategySummary } from "./public-strategy-summary.js";
import { sparbotSkillXpForLevel } from "./sparbot-skill-seed.js";
import {
  PostgresStreamingDuelActionObservationStore,
  type StreamingDuelActionObservationPool,
} from "./public-action-observation-ledger.js";

const COMPETITIVE_SNAPSHOT_TIMING = Object.freeze({
  contractVersion: STREAMING_TIMING.CONTRACT_VERSION,
  timeoutPolicy: STREAMING_TIMING.TIMEOUT_POLICY,
  countdownDurationMs: STREAMING_TIMING.COUNTDOWN_DURATION,
  fightingDurationMs: STREAMING_TIMING.FIGHTING_DURATION,
  endWarningDurationMs: STREAMING_TIMING.END_WARNING_DURATION,
  maxFightDurationMs: STREAMING_TIMING.MAX_FIGHT_DURATION,
}) satisfies CompetitiveSnapshotTimingInput;

/**
 * Keep alternate rigs behind the explicit loopback, no-money diagnostic
 * boundary until their complete duel presentation has been approved.
 */
export function resolveStreamingDuelDiagnosticAvatarUrl(
  env: NodeJS.ProcessEnv,
): string {
  const requestedAvatarId = env.STREAMING_DUEL_DIAGNOSTIC_AVATAR_ID?.trim();
  if (!requestedAvatarId) return CANONICAL_DUEL_AVATAR_URL;
  if (!isLocalDiagnosticDuelRuntime(env)) {
    throw new Error(
      "A diagnostic duel avatar override requires the explicit loopback no-money diagnostic boundary",
    );
  }
  const avatar = [...AVATAR_OPTIONS, ...DIAGNOSTIC_AVATAR_OPTIONS].find(
    (candidate) => candidate.id === requestedAvatarId,
  );
  if (!avatar) {
    throw new Error(`Unknown diagnostic duel avatar: ${requestedAvatarId}`);
  }
  return avatar.url;
}

export function assertLocalDiagnosticContestantAuthority(
  env: NodeJS.ProcessEnv,
): void {
  if (!isLocalDiagnosticDuelRuntime(env)) {
    throw new Error(
      "Diagnostic contestant authority requires the explicit loopback no-money boundary",
    );
  }
}

const SWITCHABLE_STREAMING_COMBAT_ROLES =
  new Set<SwitchableStreamingCombatRole>(["melee", "ranged", "mage"]);
const PUBLIC_PREPARATION_ACTIVITIES = new Set<string>(
  STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITIES,
);
const PUBLIC_PREPARATION_MODES = new Set<string>(
  STREAMING_DUEL_PUBLIC_PREPARATION_MODES,
);
const PUBLIC_PREPARATION_ACTIVITY_EVENT_KEYS = [
  "activity",
  "agentId",
  "mode",
  "occurredAt",
  "preparationId",
  "revision",
] as const;

const DIAGNOSTIC_HARPOON_INTERACTION_RANGE_METERS = 4;
const DIAGNOSTIC_HARPOON_MAX_BANK_HEIGHT_METERS = 0.3;
const DIAGNOSTIC_HARPOON_MIN_AGENT_SEPARATION_METERS = 2;

type DiagnosticPreparationTerrain = {
  getHeightAt?: (x: number, z: number) => number;
  isPositionWalkableFast?: (x: number, z: number) => boolean;
};

export type DiagnosticPreparationPosition = [number, number, number];

/**
 * Select two distinct, dry shoreline positions inside the authoritative
 * fishing interaction radius. The active Steve harpoon strike is certified
 * only when the avatar's footing is no more than 0.3m above the water plane,
 * so a topology regression fails instead of producing a misleading capture.
 */
export function selectDiagnosticHarpoonPreparationPositions(
  resourcePosition: DiagnosticPreparationPosition,
  terrain: DiagnosticPreparationTerrain,
): [DiagnosticPreparationPosition, DiagnosticPreparationPosition] {
  if (
    typeof terrain.getHeightAt !== "function" ||
    typeof terrain.isPositionWalkableFast !== "function"
  ) {
    throw new Error("Harpoon preparation requires live terrain authority");
  }

  const [resourceX, waterSurfaceY, resourceZ] = resourcePosition;
  const candidates: Array<{
    position: DiagnosticPreparationPosition;
    distanceToWater: number;
    distanceToResource: number;
  }> = [];
  const sampleStep = 0.25;
  const searchRadius = DIAGNOSTIC_HARPOON_INTERACTION_RANGE_METERS - sampleStep;

  for (let dx = -searchRadius; dx <= searchRadius; dx += sampleStep) {
    for (let dz = -searchRadius; dz <= searchRadius; dz += sampleStep) {
      const distanceToResource = Math.hypot(dx, dz);
      if (distanceToResource < 0.75 || distanceToResource > searchRadius) {
        continue;
      }
      const x = resourceX + dx;
      const z = resourceZ + dz;
      if (!terrain.isPositionWalkableFast(x, z)) continue;
      const y = terrain.getHeightAt(x, z);
      const distanceToWater = y - waterSurfaceY;
      if (
        !Number.isFinite(y) ||
        distanceToWater < 0 ||
        distanceToWater > DIAGNOSTIC_HARPOON_MAX_BANK_HEIGHT_METERS
      ) {
        continue;
      }
      candidates.push({
        position: [x, y, z],
        distanceToWater,
        distanceToResource,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      left.distanceToWater - right.distanceToWater ||
      left.distanceToResource - right.distanceToResource ||
      left.position[0] - right.position[0] ||
      left.position[2] - right.position[2],
  );

  let bestPair:
    | {
        positions: [
          DiagnosticPreparationPosition,
          DiagnosticPreparationPosition,
        ];
        separation: number;
        bankHeightTotal: number;
      }
    | undefined;
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    if (!left) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < candidates.length;
      rightIndex += 1
    ) {
      const right = candidates[rightIndex];
      if (!right) continue;
      const separation = Math.hypot(
        right.position[0] - left.position[0],
        right.position[2] - left.position[2],
      );
      if (separation < DIAGNOSTIC_HARPOON_MIN_AGENT_SEPARATION_METERS) {
        continue;
      }
      const bankHeightTotal = left.distanceToWater + right.distanceToWater;
      if (
        !bestPair ||
        separation > bestPair.separation ||
        (separation === bestPair.separation &&
          bankHeightTotal < bestPair.bankHeightTotal)
      ) {
        bestPair = {
          positions: [left.position, right.position],
          separation,
          bankHeightTotal,
        };
      }
    }
  }

  if (!bestPair) {
    throw new Error(
      "No two certified dry shoreline positions are available for harpoon preparation",
    );
  }
  return bestPair.positions;
}

const getFrozenOpeningStyle = (
  snapshot: CompetitiveSnapshot | null,
  agentId: string | null | undefined,
): SwitchableStreamingCombatRole | null => {
  if (!snapshot || !agentId) return null;
  const style = snapshot.contestants.find(
    (contestant) => contestant.agentId === agentId,
  )?.initialCombatStyle;
  return SWITCHABLE_STREAMING_COMBAT_ROLES.has(
    style as SwitchableStreamingCombatRole,
  )
    ? (style as SwitchableStreamingCombatRole)
    : null;
};

// ============================================================================
// Configuration
// ============================================================================

const config = {
  /** Whether the streaming scheduler is enabled */
  enabled: process.env.STREAMING_DUEL_ENABLED !== "false",

  /** Check if maintenance mode is active (blocks new cycles) */
  isMaintenanceMode: (): boolean =>
    process.env.STREAMING_DUEL_MAINTENANCE_MODE === "true",

  /** Minimum agents required to run duels */
  minAgents: 2,

  /** How long to wait before retrying when insufficient agents (ms) */
  insufficientAgentsRetryInterval: 30_000,

  /** Maximum consecutive insufficient agent warnings before logging at error level */
  maxInsufficientAgentWarnings: 5,

  /** Max duel records to retain in memory for leaderboard/history APIs */
  maxRecentDuels: Math.max(
    20,
    Number.parseInt(process.env.STREAMING_RECENT_DUELS_MAX || "200", 10),
  ),

  /**
   * Persist duel win/loss stats to Postgres.
   * In stream uptime mode (DB_WRITE_ERRORS_NON_FATAL=true), default to disabled
   * to avoid transient DB transport faults taking down the game loop.
   */
  persistStatsToDatabase: (() => {
    const explicit = process.env.STREAMING_PERSIST_STATS;
    if (explicit != null && explicit.trim().length > 0) {
      const normalized = explicit.trim().toLowerCase();
      return !(
        normalized === "0" ||
        normalized === "false" ||
        normalized === "no" ||
        normalized === "off"
      );
    }
    return process.env.DB_WRITE_ERRORS_NON_FATAL !== "true";
  })(),

  /**
   * Max inactive agent stat records to retain in memory.
   * Active agents and current-cycle contestants are never evicted.
   */
  maxAgentStats: Math.max(
    64,
    Number.parseInt(process.env.STREAMING_AGENT_STATS_MAX || "512", 10),
  ),
};

const clampNumber = (value: number, min: number, max: number): number => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const cloneCombatLoadouts = (
  loadouts: FrozenStreamingCombatLoadouts,
): FrozenStreamingCombatLoadouts => {
  const clone: FrozenStreamingCombatLoadouts = {};
  for (const role of ["melee", "ranged", "mage"] as const) {
    const loadout = loadouts[role];
    if (loadout) {
      clone[role] = {
        ...loadout,
        ...(loadout.armorIds ? { armorIds: { ...loadout.armorIds } } : {}),
      };
    }
  }
  return clone;
};

// ============================================================================
// StreamingDuelScheduler Class (Thin Facade)
// ============================================================================

export class StreamingDuelScheduler {
  private readonly world: World;

  // ---- Managers ----
  private readonly matchmaking: MatchmakingManager;
  private readonly camera: CameraDirector;
  private readonly orchestrator: DuelOrchestrator;
  private readonly phaseStateMachine = new CycleStateMachine();
  private readonly preparationStore: PostgresDuelPreparationStore | null;
  private readonly preparationFencingToken: string | null;
  private readonly preparationDurationMs: number | null;
  private readonly publicPreparationMinimumDurationMs: number;
  private readonly preparationHostLeaseConfig: DuelPreparationHostLeaseConfig | null;
  private readonly preparationDiagnosticHostOwnerId = uuidv4();
  private onDeckPreparation: DuelPreparationSnapshot | null = null;
  private onDeckPreparationPairKey: string | null = null;
  private publicPreparationActivities: {
    preparationId: string;
    agents: Map<
      string,
      {
        activity: StreamingDuelPublicPreparationActivity;
        mode: StreamingDuelPublicPreparationMode;
        activityTrail: StreamingDuelPublicPreparationActivity[];
        revision: number;
      }
    >;
  } | null = null;
  private preparationSelectionGeneration = 0;
  private preparationSelectionInFlight: Promise<void> | null = null;
  private preparationSelectionInFlightPairKey: string | null = null;
  private preparationIdleCheckInFlight = false;
  private competitiveRecoveryChecked = false;
  /**
   * Process-start fences keyed by the exact durable preparation. They prevent
   * persisted agents from changing frozen custody before recovery/retirement.
   */
  private readonly competitiveRecoveryCustodyHolds = new Map<
    string,
    readonly [string, string]
  >();
  private preMarketProcessingFences: PreparationActionFence[] = [];
  private readonly deferredProcessingFenceReleases = new Set<{
    fences: PreparationActionFence[];
    playerIds: string[];
    timeout: ReturnType<typeof setTimeout> | null;
  }>();

  // ---- Facade-owned state ----

  /** Current cycle state */
  private currentCycle: StreamingDuelCycle | null = null;

  /** Tick interval for state updates */
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  /** Broadcast interval for streaming state */
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;

  /** Countdown timeout for starting fight after countdown */
  private countdownTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Serialized delay before the next cycle starts. */
  private interCycleTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Prevent asynchronous cleanup continuations from reviving a destroyed scheduler. */
  private isDestroyed = false;
  /** Removes this scheduler's narrow combat-to-custody bridge on replacement. */
  private unregisterDamageAuthority: (() => void) | null = null;
  /** Exact operations that must settle before any competing terminal decision. */
  private readonly pendingDuelDamageOperations = new Map<
    string,
    { cycleId: string; duelId: string }
  >();
  /**
   * A committed damage promise settles just before some projectile callers
   * publish its COMBAT_DAMAGE_DEALT receipt. Release the terminal fence on the
   * next task turn so the exact co-committed terminal identity can arrive
   * first; otherwise ENTITY_DEATH can race a redundant terminal transaction.
   */
  private readonly pendingDuelDamageSettlementTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Resolution waits until every already-authored exact hit is acknowledged. */
  private damageFencedResolution: DamageFencedResolution | null = null;
  /** Cancellation and contestant restoration use the same exact-damage fence. */
  private damageFencedAbort: DamageFencedAbort | null = null;

  /** Event listeners for cleanup */
  private eventListeners: Array<{
    event: string;
    fn: (...args: unknown[]) => void;
  }> = [];

  /** Fast fight broadcast interval (200ms during FIGHTING) (#11) */
  private fightBroadcastInterval: ReturnType<typeof setInterval> | null = null;

  /** Guard against concurrent startCountdown() invocations */
  private _startCountdownInProgress = false;
  private _startCycleInProgress = false;

  /** Guard against concurrent endCycle() invocations (Fix M) */
  private _endCycleInProgress = false;

  /** Latest asynchronous contestant/loadout cleanup started by a terminal path. */
  private pendingCycleCleanup: Promise<void> = Promise.resolve();
  /** Wake retry delays immediately during shutdown so cleanup cannot hang on a timer. */
  private readonly cycleRecoveryRetryWaiters = new Set<() => void>();
  /** A terminal event is never published before its exact snapshot transition commits. */
  private pendingTerminalTransition: Promise<void> | null = null;
  /** One cycle-bound retry for a failed terminal transition; never fan out timers. */
  private terminalTransitionRetryTimeout: ReturnType<typeof setTimeout> | null =
    null;
  /** Latest durable terminal frame retained until a newer market replaces it. */
  private durableBettingTerminal: {
    cycle: StreamingDuelCycle;
    terminal: {
      outcome: "draw" | "cancelled";
      cancellationReason: string;
      duelEndTime: number;
    } | null;
  } | null = null;

  /** Scheduler state for state machine */
  private schedulerState: "IDLE" | "WAITING_FOR_AGENTS" | "ACTIVE" = "IDLE";

  /** Whether a graceful restart is pending (waits for current duel to end) */
  private _pendingGracefulRestart = false;

  /** Embedded spar bots created from POST /admin/duels/debug-matchup (spawn mode). */
  private debugSparbotSpawnIds = new Set<string>();

  /** Standalone sparbots added to the matchmaking pool via /admin/sparbots. */
  private standaloneSparbotIds = new Set<string>();
  private standaloneSparbotMeta = new Map<
    string,
    { name: string; style: string; tier: string; multiStyle: boolean }
  >();

  // ---- Streaming State Cache (Memory Optimization) ----
  /** Cached streaming state to avoid recreating objects every 500ms */
  private _cachedStreamingState: StreamingStateUpdate | null = null;
  /** Last tick when streaming state was fully regenerated */
  private _lastStreamingStateTick = -1;
  /** Current game tick counter (updated by tick loop) */
  private _currentTick = 0;
  /** Last phase when state was generated (for cache invalidation) */
  private _lastStreamingStatePhase: StreamingPhase | null = null;
  /** Last cycle ID when state was generated */
  private _lastStreamingStateCycleId: string | null = null;
  /** Last pair delivered to long-lived canonical stream viewers. */
  private _lastStreamingContestantSyncKey: string | null = null;
  /** Short-lived public presentation of a non-result terminal cycle. */
  private _terminalNotice: StreamingStateUpdate["terminalNotice"] = null;
  /** Cached agent objects to avoid recreation (reused in getStreamingState) */
  private _cachedAgent1: StreamingStateUpdate["cycle"]["agent1"] = null;
  private _cachedAgent2: StreamingStateUpdate["cycle"]["agent1"] = null;
  /** Pre-allocated idle cycle object (reused when no active cycle) */
  private readonly _idleCycleObject: StreamingStateUpdate["cycle"] = {
    cycleId: "",
    phase: "IDLE",
    cycleStartTime: 0,
    phaseStartTime: 0,
    phaseEndTime: 0,
    phaseVersion: 0,
    timeRemaining: 0,
    agent1: null,
    agent2: null,
    duelId: null,
    duelKeyHex: null,
    competitiveSnapshotVersion: null,
    competitiveSnapshotDigest: null,
    competitiveSnapshot: null,
    betOpenTime: null,
    betCloseTime: null,
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
  };
  /** Pre-allocated active cycle object (reused during active cycle) */
  private readonly _activeCycleObject: StreamingStateUpdate["cycle"] = {
    cycleId: "",
    phase: "IDLE",
    cycleStartTime: 0,
    phaseStartTime: 0,
    phaseEndTime: 0,
    phaseVersion: 0,
    timeRemaining: 0,
    agent1: null,
    agent2: null,
    duelId: null,
    duelKeyHex: null,
    competitiveSnapshotVersion: null,
    competitiveSnapshotDigest: null,
    competitiveSnapshot: null,
    betOpenTime: null,
    betCloseTime: null,
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
  };
  /** Pre-allocated streaming state return object */
  private readonly _streamingStateObject: StreamingStateUpdate = {
    type: "STREAMING_STATE_UPDATE",
    cycle: this._idleCycleObject,
    leaderboard: [],
    cameraTarget: null,
    terminalNotice: null,
    preparation: null,
  };

  constructor(world: World, options: { fencingToken?: string } = {}) {
    this.world = world;
    this.preparationDurationMs = resolveStreamingPreparationDuration();
    this.publicPreparationMinimumDurationMs =
      resolveStreamingPublicPreparationMinimumDuration(
        process.env,
        this.preparationDurationMs,
      );
    this.preparationHostLeaseConfig =
      this.preparationDurationMs === null
        ? null
        : resolveDuelPreparationHostLeaseConfig();
    this.preparationFencingToken = options.fencingToken ?? null;
    const pool = (world as { pgPool?: pg.Pool }).pgPool;
    if (this.preparationDurationMs !== null) {
      if (!this.preparationFencingToken) {
        throw new Error(
          "private duel preparation requires a verified scheduler fencing token",
        );
      }
      if (!pool) {
        throw new Error(
          "private duel preparation requires the authoritative PostgreSQL pool",
        );
      }
      this.preparationStore = new PostgresDuelPreparationStore(pool);
    } else {
      this.preparationStore = null;
    }

    // -- Wire up managers --

    this.matchmaking = new MatchmakingManager(
      world,
      this.getDatabase.bind(this),
      {
        minAgents: config.minAgents,
        maxRecentDuels: config.maxRecentDuels,
        persistStatsToDatabase: config.persistStatsToDatabase,
        maxAgentStats: config.maxAgentStats,
        insufficientAgentsRetryInterval: config.insufficientAgentsRetryInterval,
        maxInsufficientAgentWarnings: config.maxInsufficientAgentWarnings,
      },
    );

    this.camera = new CameraDirector(
      world,
      () => this.matchmaking.availableAgents,
      () => this.currentCycle,
      () => this.matchmaking.nextDuelPair,
      (pair) => {
        this.matchmaking.nextDuelPair = pair;
        if (
          pair === null &&
          this.matchmaking.availableAgents.size >= config.minAgents
        ) {
          this.matchmaking.refreshNextDuelPair(Date.now());
        }
      },
    );

    this.orchestrator = new DuelOrchestrator(
      world,
      () => this.currentCycle,
      (fields) => {
        if (this.currentCycle) {
          if (fields.phase && fields.phase !== this.currentCycle.phase) {
            this.phaseStateMachine.transition(fields.phase as StreamingPhase);
            this.currentCycle.phaseVersion += 1;
          }
          Object.assign(this.currentCycle, fields);
        }
      },
      () => this.matchmaking.agentStats,
      (winnerId, loserId, winReason, terminalAtOverride) =>
        this.handleResolution(
          winnerId,
          loserId,
          winReason,
          undefined,
          terminalAtOverride,
        ),
      (reason, occurredAtOverride) =>
        this.abortCycleToIdle(reason, occurredAtOverride),
      () => this.matchmaking.getLeaderboard(),
      () => this.matchmaking.getRecentDuels(),
      (playerId) =>
        this.debugSparbotSpawnIds.has(playerId) ||
        this.standaloneSparbotIds.has(playerId),
      pool
        ? new PostgresStreamingDuelActionObservationStore(
            pool as unknown as StreamingDuelActionObservationPool,
          )
        : null,
    );

    // -- Wire matchmaking callbacks --

    this.matchmaking.setCallbacks({
      getCycleContestantIds: () => this.camera.getCycleContestantIds(),
      getCurrentCycleAgentDamage: (characterId: string) => {
        if (!this.currentCycle) return null;
        if (this.currentCycle.agent1?.characterId === characterId) {
          return {
            damageDealtThisFight: this.currentCycle.agent1.damageDealtThisFight,
          };
        }
        if (this.currentCycle.agent2?.characterId === characterId) {
          return {
            damageDealtThisFight: this.currentCycle.agent2.damageDealtThisFight,
          };
        }
        return null;
      },
      onAgentRegistered: (agentId: string, now: number) => {
        this.camera.ensureAgentActivity(agentId, now);
      },
      onAgentUnregistered: (agentId: string) => {
        this.camera.deleteAgentActivity(agentId);

        if (
          this.currentCycle?.phase === "ANNOUNCEMENT" &&
          (this.currentCycle.agent1?.characterId === agentId ||
            this.currentCycle.agent2?.characterId === agentId)
        ) {
          // A selected contestant disappearing during preparation is a no
          // contest, not a delayed provisioning error. Begin the durable
          // cancellation while the contestant is still available for cleanup.
          this.abortCycleToIdle("contestant_unavailable");
          return;
        }

        // Check if this agent is in an active duel - forfeit them
        if (
          this.currentCycle &&
          (this.currentCycle.phase === "FIGHTING" ||
            this.currentCycle.phase === "COUNTDOWN")
        ) {
          const { agent1, agent2 } = this.currentCycle;

          if (agent1?.characterId === agentId) {
            if (agent2) {
              Logger.info(
                "StreamingDuelScheduler",
                `${agent1.name} disconnected, ${agent2.name} wins by forfeit`,
              );
              this.orchestrator.stopCombatLoop();
              this.orchestrator.startResolution(
                agent2.characterId,
                agentId,
                "forfeit",
              );
            }
          } else if (agent2?.characterId === agentId) {
            if (agent1) {
              Logger.info(
                "StreamingDuelScheduler",
                `${agent2.name} disconnected, ${agent1.name} wins by forfeit`,
              );
              this.orchestrator.stopCombatLoop();
              this.orchestrator.startResolution(
                agent1.characterId,
                agentId,
                "forfeit",
              );
            }
          }
        }
      },
      onNextDuelPairChanged: (pair) => {
        if (pair) {
          this.notifyOnDeckAgents();
        } else {
          void this.cancelOnDeckPreparation("pair_cleared");
        }
      },
    });
  }

  private deriveStreamingDuelKeyHex(cycleId: string): string {
    return crypto
      .createHash("sha256")
      .update(`hyperia-streaming-duel:${cycleId}`)
      .digest("hex");
  }

  // ============================================================================
  // Database Access
  // ============================================================================

  /** Get the database connection, or null. */
  private getDatabase():
    import("drizzle-orm/node-postgres").NodePgDatabase | null {
    const databaseSystem = this.world.getSystem("database") as {
      getDb?: () => import("drizzle-orm/node-postgres").NodePgDatabase | null;
    } | null;
    return databaseSystem?.getDb?.() ?? null;
  }

  /**
   * Register for streaming duels only when `agent_mappings.streaming_duel_enabled` is true.
   * A DB-backed launch requires an explicit positive mapping. Missing or
   * unreadable authority fails closed; DB-free diagnostic worlds retain their
   * existing direct-registration behavior above this boundary.
   */
  private registerAgentIfEligible(agentId: string): void {
    if (this.isDestroyed) return;
    // Standalone sparbots are created only behind the explicit loopback,
    // no-money diagnostic authority and carry a server-reserved identity.
    // Their PLAYER_JOINED event is emitted before spawnStandaloneSparbots can
    // finish attaching diagnostic metadata. Do not start the production
    // agent_mappings lookup for that event: its delayed negative result would
    // otherwise unregister the already-validated diagnostic contestant and
    // leave the maintenance-held renderer with no preview entities to warm.
    if (
      agentId.startsWith("sparbot-standalone-") &&
      isLocalDiagnosticDuelRuntime(process.env)
    ) {
      this.registerDiagnosticAgent(agentId);
      return;
    }
    const db = this.getDatabase();
    if (!db) {
      if (isLocalDiagnosticDuelRuntime(process.env)) {
        this.matchmaking.markStreamingDuelOptOut(agentId, false);
        this.matchmaking.registerAgent(agentId);
      } else {
        this.matchmaking.markStreamingDuelOptOut(agentId, true);
        if (!streamingDuelPrefReadWarningLogged) {
          streamingDuelPrefReadWarningLogged = true;
          Logger.warn(
            "StreamingDuelScheduler",
            "Database-backed duel participation authority is unavailable. Matchmaking remains disabled for unverified agents.",
          );
        }
      }
      return;
    }

    void this.registerAgentFromDatabasePreference(agentId, db);
  }

  private registerDiagnosticAgent(agentId: string): void {
    assertLocalDiagnosticContestantAuthority(process.env);
    this.matchmaking.markStreamingDuelOptOut(agentId, false);
    this.matchmaking.registerAgent(agentId);
  }

  private async registerAgentFromDatabasePreference(
    agentId: string,
    db: import("drizzle-orm/node-postgres").NodePgDatabase,
  ): Promise<void> {
    let enabled = false;
    try {
      const { agentMappings } = await import("../../database/schema.js");
      const { eq, or } = await import("drizzle-orm");
      const rows = await db
        .select({ streamingDuelEnabled: agentMappings.streamingDuelEnabled })
        .from(agentMappings)
        .where(
          or(
            eq(agentMappings.characterId, agentId),
            eq(agentMappings.agentId, agentId),
          ),
        )
        .limit(2);
      enabled = resolvePersistedStreamingDuelEligibility(
        rows.map((row) => row.streamingDuelEnabled),
      );
    } catch (err) {
      if (!streamingDuelPrefReadWarningLogged) {
        streamingDuelPrefReadWarningLogged = true;
        Logger.warn(
          "StreamingDuelScheduler",
          `Could not read agent streaming duel preference (${errMsg(err)}). ` +
            "If the column is missing, run `bun run db:migrate` in packages/server against the same DATABASE_URL as this server. Matchmaking remains disabled for this agent.",
        );
      }
    }

    if (this.isDestroyed) return;

    this.matchmaking.markStreamingDuelOptOut(agentId, !enabled);
    if (enabled) {
      this.matchmaking.registerAgent(agentId);
    }
  }

  private async reconcilePersistedStreamingDuelParticipation(
    agentIds: readonly string[],
  ): Promise<void> {
    const db = this.getDatabase();
    const uniqueAgentIds = [...new Set(agentIds)].filter(Boolean);
    if (!db) {
      for (const agentId of uniqueAgentIds) {
        this.matchmaking.markStreamingDuelOptOut(agentId, true);
      }
      return;
    }
    await Promise.all(
      uniqueAgentIds.map((agentId) =>
        this.registerAgentFromDatabasePreference(agentId, db),
      ),
    );
  }

  /** Agents already in the world when the scheduler starts (same rules as PLAYER_JOINED). */
  private scanForExistingAgentsWithEligibility(): void {
    const allEntities = this.getAuthoritativeWorldEntities();
    if (!allEntities) return;
    let agentCount = 0;

    for (const [id, entity] of allEntities) {
      const entityAny = entity as {
        type?: string;
        isAgent?: boolean;
        isEmbeddedAgent?: boolean;
        data?: { isAgent?: boolean; isEmbeddedAgent?: boolean; name?: string };
      };

      if (
        entityAny.type === "player" &&
        id.startsWith("sparbot-standalone-") &&
        isLocalDiagnosticDuelRuntime(process.env)
      ) {
        this.restoreStandaloneSparbotIdentity(id, entityAny.data?.name);
        this.registerDiagnosticAgent(id);
        agentCount++;
        continue;
      }

      if (
        entityAny.type === "player" &&
        (entityAny.isAgent === true ||
          entityAny.isEmbeddedAgent === true ||
          entityAny.data?.isAgent === true ||
          entityAny.data?.isEmbeddedAgent === true)
      ) {
        this.registerAgentIfEligible(id);
        agentCount++;
      }
    }

    if (agentCount > 0) {
      Logger.info(
        "StreamingDuelScheduler",
        `Found ${agentCount} existing agent(s) during initialization`,
      );
    }
  }

  /**
   * Rehydrate smoke-owned contestants after a fenced scheduler handoff. Lease
   * loss destroys scheduler-local sets but deliberately leaves AgentManager and
   * world entities alive. Their reserved server-generated id is therefore the
   * durable diagnostic identity for the replacement scheduler.
   */
  private restoreStandaloneSparbotIdentity(
    agentId: string,
    name?: string,
    frozenStyle?: "melee" | "ranged" | "mage" | "prayer",
  ): void {
    assertLocalDiagnosticContestantAuthority(process.env);
    if (!agentId.startsWith("sparbot-standalone-")) return;
    this.standaloneSparbotIds.add(agentId);
    const readiness = this.orchestrator.inspectCompetitiveLoadout(agentId);
    const style =
      frozenStyle ?? (readiness.ok ? readiness.initialCombatRole : "melee");
    const multiStyle = agentId.startsWith("sparbot-standalone-multi-");
    this.orchestrator.setDebugCombatRoleOverride(agentId, style);
    this.orchestrator.setDiagnosticMultiStyleAllowed(agentId, multiStyle);
    this.standaloneSparbotMeta.set(agentId, {
      name: name?.trim() || agentId,
      style,
      tier: "adept",
      multiStyle,
    });
  }

  private reconcileStandaloneSparbotsFromWorld(): void {
    if (!isLocalDiagnosticDuelRuntime(process.env)) return;
    const allEntities = this.getAuthoritativeWorldEntities();
    if (!allEntities) return;
    for (const [id, entity] of allEntities) {
      if (!id.startsWith("sparbot-standalone-")) continue;
      const entityAny = entity as {
        type?: string;
        data?: { name?: string };
      };
      if (entityAny.type !== "player") continue;
      this.restoreStandaloneSparbotIdentity(id, entityAny.data?.name);
      this.registerDiagnosticAgent(id);
    }
  }

  private getAuthoritativeWorldEntities(): Map<string, unknown> | null {
    const entities = this.world.entities as {
      items?: Map<string, unknown>;
      getAllEntities?: () => Map<string, unknown>;
    };
    // `Entities`, used by the live World runtime, owns the authoritative map
    // as `items`. `getAllEntities()` belongs to the alternate EntityManager and
    // test harnesses, so retain it only as a compatibility fallback.
    if (entities.items instanceof Map) return entities.items;
    return entities.getAllEntities?.() ?? null;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /** Start the streaming duel scheduler (alias for init) */
  start(): void {
    this.init();
  }

  /** Stop the streaming duel scheduler (alias for destroy) */
  stop(): void {
    this.destroy();
  }

  /** Get current cycle (public accessor) */
  getCurrentCycle(): StreamingDuelCycle | null {
    return this.currentCycle;
  }

  getDurableBettingTerminal(): {
    cycle: StreamingDuelCycle;
    terminal: {
      outcome: "draw" | "cancelled";
      cancellationReason: string;
      duelEndTime: number;
    } | null;
  } | null {
    return this.durableBettingTerminal;
  }

  /**
   * Request a graceful server restart after the current duel ends.
   * The server will complete the current FIGHTING/RESOLUTION phase,
   * then trigger a SIGTERM to allow PM2 to restart it with new code.
   *
   * @returns Whether the restart was scheduled (false if already pending)
   */
  requestGracefulRestart(): boolean {
    if (this._pendingGracefulRestart) {
      Logger.info("StreamingDuelScheduler", "Graceful restart already pending");
      return false;
    }

    this._pendingGracefulRestart = true;
    const phase = this.currentCycle?.phase ?? "IDLE";

    if (phase === "IDLE" || phase === "ANNOUNCEMENT") {
      // No active duel, restart immediately
      Logger.info(
        "StreamingDuelScheduler",
        "No active duel, triggering immediate graceful restart",
      );
      this.triggerGracefulRestart();
    } else {
      Logger.info(
        "StreamingDuelScheduler",
        `Graceful restart scheduled after current duel (phase: ${phase})`,
      );
    }

    return true;
  }

  /**
   * Check if a graceful restart is pending
   */
  isPendingRestart(): boolean {
    return this._pendingGracefulRestart;
  }

  /**
   * Trigger the actual graceful restart by sending SIGTERM to self.
   * PM2 will handle the restart.
   */
  private triggerGracefulRestart(): void {
    Logger.info(
      "StreamingDuelScheduler",
      "Triggering graceful restart (SIGTERM)",
    );
    // Give a moment for logs to flush
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 500);
  }

  /** Initialize the streaming duel scheduler */
  init(): void {
    if (!config.enabled) {
      Logger.info(
        "StreamingDuelScheduler",
        "Streaming duel scheduler disabled",
      );
      return;
    }

    this.isDestroyed = false;
    this.unregisterDamageAuthority?.();
    this.unregisterDamageAuthority = registerStreamingDuelDamageAuthority(
      this.world,
      {
        createDamageObservationContext: (attackerId, targetId, damage) =>
          (() => {
            const publicActionObservation =
              this.orchestrator.createAuthoritativeDamageObservationContext(
                attackerId,
                targetId,
                damage,
              );
            if (!publicActionObservation) return null;
            const cycle = this.currentCycle;
            const snapshot = cycle?.competitiveSnapshot;
            if (!snapshot?.persisted) return { publicActionObservation };
            if (
              !snapshot.preparationId ||
              !cycle?.competitiveSnapshotDigest ||
              !this.preparationFencingToken
            ) {
              return null;
            }
            return {
              publicActionObservation,
              competitiveAuthority: {
                preparationId: snapshot.preparationId,
                fencingToken: this.preparationFencingToken,
                snapshotDigest: cycle.competitiveSnapshotDigest,
              },
            };
          })(),
        handleDamageCommitStarted: (context) => {
          const cycle = this.currentCycle;
          if (
            this.isDestroyed ||
            cycle?.phase !== "FIGHTING" ||
            cycle.cycleId !== context.cycleId ||
            (cycle.duelId ?? `streaming-${cycle.cycleId}`) !== context.duelId ||
            !(
              (context.actorId === cycle.agent1?.characterId &&
                context.opponentId === cycle.agent2?.characterId) ||
              (context.actorId === cycle.agent2?.characterId &&
                context.opponentId === cycle.agent1?.characterId)
            )
          ) {
            return;
          }
          this.pendingDuelDamageOperations.set(context.operationId, {
            cycleId: context.cycleId,
            duelId: context.duelId,
          });
        },
        handleDamageCommitSettled: (context) => {
          const pending = this.pendingDuelDamageOperations.get(
            context.operationId,
          );
          if (
            pending?.cycleId === context.cycleId &&
            pending.duelId === context.duelId &&
            !this.pendingDuelDamageSettlementTimers.has(context.operationId)
          ) {
            const timer = setTimeout(() => {
              this.pendingDuelDamageSettlementTimers.delete(
                context.operationId,
              );
              const current = this.pendingDuelDamageOperations.get(
                context.operationId,
              );
              if (
                current?.cycleId !== context.cycleId ||
                current.duelId !== context.duelId
              ) {
                return;
              }
              this.pendingDuelDamageOperations.delete(context.operationId);
              this.resumeDamageFencedTerminal(context.cycleId);
            }, 0);
            this.pendingDuelDamageSettlementTimers.set(
              context.operationId,
              timer,
            );
          }
        },
        handleDamageCommitFailure: (attackerId, targetId, reason, context) => {
          const cycle = this.currentCycle;
          if (
            !this.isDestroyed &&
            cycle?.phase === "FIGHTING" &&
            (!context ||
              (context.cycleId === cycle.cycleId &&
                context.duelId ===
                  (cycle.duelId ?? `streaming-${cycle.cycleId}`))) &&
            [cycle.agent1?.characterId, cycle.agent2?.characterId].includes(
              attackerId,
            ) &&
            [cycle.agent1?.characterId, cycle.agent2?.characterId].includes(
              targetId,
            )
          ) {
            if (context) {
              const timer = this.pendingDuelDamageSettlementTimers.get(
                context.operationId,
              );
              if (timer) clearTimeout(timer);
              this.pendingDuelDamageSettlementTimers.delete(
                context.operationId,
              );
              this.pendingDuelDamageOperations.delete(context.operationId);
              this.resumeDamageFencedTerminal(context.cycleId);
            }
            Logger.warn(
              "StreamingDuelScheduler",
              `Cancelling duel after damage authority failure (${reason})`,
            );
            this.abortCycleToIdle("damage_authority_failed");
          }
        },
      },
    );

    Logger.info(
      "StreamingDuelScheduler",
      "Initializing streaming duel scheduler",
    );
    if (!config.persistStatsToDatabase) {
      Logger.info(
        "StreamingDuelScheduler",
        "Stats persistence disabled (STREAMING_PERSIST_STATS=false or DB_WRITE_ERRORS_NON_FATAL=true)",
      );
    }

    void this.matchmaking
      .hydrateRecentDuelsFromDatabase()
      .then((loadedCount) => {
        if (!this.isDestroyed && loadedCount > 0) {
          Logger.info(
            "StreamingDuelScheduler",
            `Restored ${loadedCount} persisted recent duel(s)`,
          );
        }
      })
      .catch((err) => {
        if (!this.isDestroyed) {
          Logger.warn(
            "StreamingDuelScheduler",
            `Failed to restore recent duel history: ${errMsg(err)}`,
          );
        }
      });

    // Subscribe to player events to track agents
    this.subscribeToEvents();

    // Scan for any agents that were already spawned before we initialized
    this.scanForExistingAgentsWithEligibility();

    // Start the main tick loop
    this.startTickLoop();

    // Start broadcasting state to viewers
    this.startStateBroadcast();

    Logger.info(
      "StreamingDuelScheduler",
      "Streaming duel scheduler initialized",
    );
  }

  /**
   * Load recovery fences before persisted agents are initialized. A failed
   * read rejects scheduler startup rather than allowing mutable contestants to
   * race an unresolved competitive snapshot.
   */
  async primeCompetitiveRecoveryCustodyHolds(): Promise<void> {
    const store = this.preparationStore;
    if (!store) return;
    const list = (
      store as PostgresDuelPreparationStore & {
        listCompetitiveRecoveryCustodyHolds?: PostgresDuelPreparationStore["listCompetitiveRecoveryCustodyHolds"];
      }
    ).listCompetitiveRecoveryCustodyHolds;
    if (!list) return;
    const holds = await list.call(store);
    for (const hold of holds) {
      this.competitiveRecoveryCustodyHolds.set(hold.preparationId, [
        hold.agent1Id,
        hold.agent2Id,
      ]);
    }
    for (const [, contestantIds] of this.competitiveRecoveryCustodyHolds) {
      for (const contestantId of contestantIds) {
        this.applyCompetitiveRecoveryCustodyHolds(contestantId);
      }
    }
  }

  private recoveryHoldPreparationIdsForAgent(agentId: string): string[] {
    const preparationIds: string[] = [];
    for (const [preparationId, contestantIds] of this
      .competitiveRecoveryCustodyHolds) {
      if (contestantIds.includes(agentId)) preparationIds.push(preparationId);
    }
    return preparationIds;
  }

  private applyCompetitiveRecoveryCustodyHolds(agentId: string): void {
    const preparationIds = this.recoveryHoldPreparationIdsForAgent(agentId);
    if (preparationIds.length === 0) return;
    const entity = this.world.entities.get(agentId);
    if (entity) {
      entity.data.inStreamingDuel = true;
      entity.data.preventRespawn = true;
      entity.markNetworkDirty?.();
    }
    for (const preparationId of preparationIds) {
      this.world.emit(DUEL_COMPETITIVE_RECOVERY_CUSTODY_HOLD_EVENT, {
        preparationId,
        agentId,
        active: true,
      });
    }
  }

  private holdCompetitiveSnapshotRecovery(
    competitive: PersistedCompetitiveSnapshot,
  ): void {
    const preparationId = competitive.preparation.preparationId;
    const contestantIds = [
      competitive.snapshot.contestants[0].agentId,
      competitive.snapshot.contestants[1].agentId,
    ] as const;
    this.competitiveRecoveryCustodyHolds.set(preparationId, contestantIds);
    for (const contestantId of contestantIds) {
      this.applyCompetitiveRecoveryCustodyHolds(contestantId);
    }
  }

  private releaseCompetitiveRecoveryCustodyHold(preparationId: string): void {
    const contestantIds =
      this.competitiveRecoveryCustodyHolds.get(preparationId);
    if (!contestantIds) return;
    this.competitiveRecoveryCustodyHolds.delete(preparationId);
    for (const contestantId of contestantIds) {
      this.world.emit(DUEL_COMPETITIVE_RECOVERY_CUSTODY_HOLD_EVENT, {
        preparationId,
        agentId: contestantId,
        active: false,
      });
      if (
        this.recoveryHoldPreparationIdsForAgent(contestantId).length === 0 &&
        this.currentCycle?.agent1?.characterId !== contestantId &&
        this.currentCycle?.agent2?.characterId !== contestantId
      ) {
        const entity = this.world.entities.get(contestantId);
        if (entity) {
          entity.data.inStreamingDuel = false;
          entity.data.preventRespawn = false;
          entity.markNetworkDirty?.();
        }
      }
    }
  }

  /** Destroy the scheduler and cleanup */
  destroy(cancellationReason = "scheduler_shutdown"): void {
    this.isDestroyed = true;
    this.unregisterDamageAuthority?.();
    this.unregisterDamageAuthority = null;
    for (const timer of this.pendingDuelDamageSettlementTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingDuelDamageSettlementTimers.clear();
    this.pendingDuelDamageOperations.clear();
    this.damageFencedResolution = null;
    this.damageFencedAbort?.resolve();
    this.damageFencedAbort = null;
    this.releasePreMarketProcessingFences();
    for (const pending of this.deferredProcessingFenceReleases) {
      if (pending.timeout) clearTimeout(pending.timeout);
      for (const fence of pending.fences) fence.release();
    }
    this.deferredProcessingFenceReleases.clear();
    for (const wake of this.cycleRecoveryRetryWaiters) wake();
    this.cycleRecoveryRetryWaiters.clear();
    if (this.terminalTransitionRetryTimeout) {
      clearTimeout(this.terminalTransitionRetryTimeout);
      this.terminalTransitionRetryTimeout = null;
    }
    const cycleAtShutdown = this.currentCycle;
    let cycleCleanup = this.pendingCycleCleanup;
    if (cycleAtShutdown?.phase === "RESOLUTION") {
      // The sporting result is already terminal. Clean the contestants without
      // emitting a contradictory cancellation after a committed winner/draw.
      cycleCleanup = this.recoverCycleUntilCommitted({
        cycle: cycleAtShutdown,
        cleanup: () => this.orchestrator.cleanupAfterAbort(cycleAtShutdown),
        context: `Resolution shutdown ${cycleAtShutdown.cycleId}`,
      })
        .then(() => undefined)
        .catch((err) => {
          Logger.warn(
            "StreamingDuelScheduler",
            `Resolution cleanup during shutdown failed: ${errMsg(err)}`,
          );
        })
        .then(() => undefined);
      this.pendingCycleCleanup = cycleCleanup;
      this.currentCycle = null;
    } else if (cycleAtShutdown) {
      // A nonterminal cycle must publish its exact cancellation identity before
      // listeners are detached and the in-memory cycle disappears.
      cycleCleanup = this.abortCycleToIdle(cancellationReason).catch(
        async (error) => {
          Logger.warn(
            "StreamingDuelScheduler",
            `Shutdown terminal barrier failed closed: ${errMsg(error)}`,
          );
          // Leave the durable snapshot replayable for the next authority, but
          // still make one best-effort local custody repair before exit.
          await this.orchestrator
            .cleanupAfterAbort(cycleAtShutdown)
            .catch((cleanupError) => {
              Logger.warn(
                "StreamingDuelScheduler",
                `Post-failure shutdown cleanup failed: ${errMsg(cleanupError)}`,
              );
            });
        },
      );
    }
    const preparationCleanup = this.cancelOnDeckPreparation(cancellationReason);
    this.pendingCycleCleanup = Promise.all([cycleCleanup, preparationCleanup])
      .then(() => this.orchestrator.waitForPublicActionObservations())
      .finally(() => {
        // A persisted live cycle cannot restore custody until its cancellation
        // has committed. Retain the orchestrator snapshots until that finishes.
        this.orchestrator.reset();
        this.camera.reset();
        this.matchmaking.reset();
        this.debugSparbotSpawnIds.clear();
      });

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }

    this.stopFightBroadcast();

    if (this.countdownTimeout) {
      clearTimeout(this.countdownTimeout);
      this.countdownTimeout = null;
    }

    if (this.interCycleTimeout) {
      clearTimeout(this.interCycleTimeout);
      this.interCycleTimeout = null;
    }

    if (this.terminalTransitionRetryTimeout) {
      clearTimeout(this.terminalTransitionRetryTimeout);
      this.terminalTransitionRetryTimeout = null;
    }

    // Remove event listeners
    for (const { event, fn } of this.eventListeners) {
      this.world.off(event, fn);
    }
    this.eventListeners = [];

    // Reset facade state
    this._startCountdownInProgress = false;
    this._startCycleInProgress = false;
    this._endCycleInProgress = false;
    this.schedulerState = "IDLE";
    this.currentCycle = null;
    this.phaseStateMachine.forceIdle();
    this.phaseStateMachine.removeAllListeners();

    Logger.info("StreamingDuelScheduler", "Streaming duel scheduler destroyed");
  }

  /** Wait until contestant/loadout restoration triggered by destroy has settled. */
  waitForShutdownCleanup(): Promise<void> {
    return this.pendingCycleCleanup;
  }

  /** Wait for authoritative arrow/rune terminals at a combat boundary. */
  waitForCombatCustodySettlements(): Promise<void> {
    return this.orchestrator.waitForCombatCustodySettlements();
  }

  // ============================================================================
  // Event Subscriptions
  // ============================================================================

  private subscribeToEvents(): void {
    // Track agent spawns
    const onPlayerJoined = (payload: unknown) => {
      const data = payload as {
        playerId?: string;
        isEmbeddedAgent?: boolean;
        isAgent?: boolean;
      };

      if (data.playerId && (data.isEmbeddedAgent || data.isAgent)) {
        this.applyCompetitiveRecoveryCustodyHolds(data.playerId);
        void this.registerAgentIfEligible(data.playerId);
      }
    };
    this.world.on(EventType.PLAYER_JOINED, onPlayerJoined);
    this.eventListeners.push({
      event: EventType.PLAYER_JOINED,
      fn: onPlayerJoined,
    });

    // Track agent leaves
    const onPlayerLeft = (payload: unknown) => {
      const data = payload as {
        playerId?: string;
        reconnectGraceActive?: boolean;
      };
      if (data.playerId) {
        const isCurrentCycleContestant =
          this.currentCycle?.agent1?.characterId === data.playerId ||
          this.currentCycle?.agent2?.characterId === data.playerId;
        if (data.reconnectGraceActive === true && !isCurrentCycleContestant) {
          this.matchmaking.suspendAgentForReconnect(data.playerId);
          return;
        }
        this.matchmaking.unregisterAgent(data.playerId);
      }
    };
    this.world.on(EventType.PLAYER_LEFT, onPlayerLeft);
    this.eventListeners.push({
      event: EventType.PLAYER_LEFT,
      fn: onPlayerLeft,
    });

    // Track duel completions
    const onDuelCompleted = (payload: unknown) => {
      this.handleDuelCompleted(payload);
    };
    this.world.on("duel:completed", onDuelCompleted);
    this.eventListeners.push({ event: "duel:completed", fn: onDuelCompleted });

    // Track combat damage for duel stats
    const onCombatDamageDealt = (payload: unknown) => {
      this.handleEntityDamaged(payload);
    };
    this.world.on(EventType.COMBAT_DAMAGE_DEALT, onCombatDamageDealt);
    this.eventListeners.push({
      event: EventType.COMBAT_DAMAGE_DEALT,
      fn: onCombatDamageDealt,
    });

    // Track authoritative healing after PlayerSystem has actually changed the
    // entity health pool. AI inventory requests are attempts, not proof.
    const onEntityHealed = (payload: unknown) => {
      this.handleEntityHealed(payload);
    };
    this.world.on(EventType.ENTITY_HEALED, onEntityHealed);
    this.eventListeners.push({
      event: EventType.ENTITY_HEALED,
      fn: onEntityHealed,
    });

    // Track entity deaths
    const onEntityDeath = (payload: unknown) => {
      this.handleEntityDeath(payload);
    };
    this.world.on(EventType.ENTITY_DEATH, onEntityDeath);
    this.eventListeners.push({
      event: EventType.ENTITY_DEATH,
      fn: onEntityDeath,
    });

    const onPreparationReady = (payload: unknown) => {
      const data = payload as {
        preparationId?: string;
        agentId?: string;
        planEvidence?: CompetitivePreparationEvidence;
      };
      if (data.preparationId && data.agentId) {
        void this.confirmOnDeckPreparation(
          data.preparationId,
          data.agentId,
          true,
          data.planEvidence,
        );
      }
    };
    this.world.on("duel:preparation:ready", onPreparationReady);
    this.eventListeners.push({
      event: "duel:preparation:ready",
      fn: onPreparationReady,
    });

    const onPreparationPlanStatus = (payload: unknown) => {
      const data = payload as {
        preparationId?: string;
        agentId?: string;
        status?: string;
        failureReason?: string;
      };
      if (data.status === "failed" && data.preparationId && data.agentId) {
        const failureReason =
          typeof data.failureReason === "string" && data.failureReason.trim()
            ? data.failureReason.trim().slice(0, 256)
            : "preparation_failed";
        Logger.warn(
          "StreamingDuelScheduler",
          `Private preparation ${data.preparationId} failed for agent ${data.agentId}: ${failureReason}`,
        );
        void this.handleOnDeckPreparationAgentFailure(
          data.preparationId,
          data.agentId,
        );
      }
    };
    this.world.on(
      "duel:preparation:agent_plan_status",
      onPreparationPlanStatus,
    );
    this.eventListeners.push({
      event: "duel:preparation:agent_plan_status",
      fn: onPreparationPlanStatus,
    });

    const onPreparationPublicActivity = (payload: unknown) => {
      this.handlePreparationPublicActivity(payload);
    };
    this.world.on(
      "duel:preparation:public_activity",
      onPreparationPublicActivity,
    );
    this.eventListeners.push({
      event: "duel:preparation:public_activity",
      fn: onPreparationPublicActivity,
    });
  }

  // ============================================================================
  // Public API Delegates
  // ============================================================================

  /**
   * Apply streaming duel participation from persisted preference (or DB PATCH).
   * `agentId` must be the in-world player / character id (same as PLAYER_JOINED `playerId`),
   * not the dashboard `agent_mappings.agent_id` mapping key.
   */
  applyStreamingDuelParticipation(agentId: string, enabled: boolean): void {
    if (!enabled) {
      this.matchmaking.markStreamingDuelOptOut(agentId, true);
      return;
    }
    this.matchmaking.markStreamingDuelOptOut(agentId, false);
    this.matchmaking.registerAgent(agentId);
  }

  /** Register an agent for duel scheduling */
  registerAgent(agentId: string): void {
    this.matchmaking.registerAgent(agentId);
  }

  /** Unregister an agent from duel scheduling */
  unregisterAgent(agentId: string): void {
    this.matchmaking.unregisterAgent(agentId);
  }

  /** Get leaderboard sorted by win rate */
  getLeaderboard(): LeaderboardEntry[] {
    return this.matchmaking.getLeaderboard();
  }

  /** Get recent duel history */
  getRecentDuels(limit: number = 30): RecentDuelEntry[] {
    return this.matchmaking.getRecentDuels(limit);
  }

  /** Bounded operational view used by health dashboards and admin tooling. */
  getOperationalMetrics(): StreamingDuelOperationalMetrics {
    const recentDuels = this.matchmaking.getRecentDuels(config.maxRecentDuels);
    let wins = 0;
    let draws = 0;
    let cancelled = 0;
    const cancellationReasons: Record<string, number> = {};

    for (const duel of recentDuels) {
      if (duel.outcome === "win") {
        wins++;
      } else if (duel.outcome === "draw") {
        draws++;
      } else {
        cancelled++;
        const reason = duel.cancellationReason || "unspecified";
        cancellationReasons[reason] = (cancellationReasons[reason] ?? 0) + 1;
      }
    }

    const completed = wins + draws;
    const terminal = completed + cancelled;
    const cycle = this.currentCycle;
    const firstHitLatencyMs =
      cycle?.firstHitAt != null && cycle.fightStartTime != null
        ? Math.max(0, cycle.firstHitAt - cycle.fightStartTime)
        : null;
    const actionObservationHealth =
      this.orchestrator.getPublicActionObservationHealth();

    return {
      emittedAt: Date.now(),
      historyWindow: {
        size: recentDuels.length,
        maxSize: config.maxRecentDuels,
        wins,
        draws,
        completed,
        cancelled,
        terminal,
        completionRate: terminal > 0 ? completed / terminal : null,
        cancellationReasons,
      },
      engagement: this.orchestrator.getEngagementMetrics(),
      actionObservations: {
        configured: actionObservationHealth.configured,
        healthy: actionObservationHealth.lastError === null,
        pending: actionObservationHealth.pending,
        persisted: actionObservationHealth.persisted,
        replayed: actionObservationHealth.replayed,
        rejected: actionObservationHealth.rejected,
        persistenceErrors: actionObservationHealth.persistenceErrors,
      },
      current: {
        cycleId: cycle?.cycleId ?? null,
        phase: cycle?.phase ?? "IDLE",
        firstHitLatencyMs,
        recoveryInProgress: this._endCycleInProgress,
        schedulerState: this.schedulerState,
        availableAgents: this.matchmaking.availableAgents.size,
        requiredAgents: config.minAgents,
        preparation: {
          enabled: this.preparationStore !== null,
          gateInFlight: this.preparationIdleCheckInFlight,
          selectionInFlight: this.preparationSelectionInFlight !== null,
          status: this.onDeckPreparation?.status ?? null,
          expiresAt: this.onDeckPreparation?.expiresAt ?? null,
        },
      },
    };
  }

  // ============================================================================
  // Main Tick Loop
  // ============================================================================

  private startTickLoop(): void {
    // Run tick every second
    this.tickInterval = setInterval(() => {
      this.tick();
    }, 1000);

    // Run first tick immediately
    this.tick();
  }

  private hasPendingDamageForCurrentCycle(): boolean {
    const cycle = this.currentCycle;
    if (!cycle) return false;
    const duelId = cycle.duelId ?? `streaming-${cycle.cycleId}`;
    for (const pending of this.pendingDuelDamageOperations.values()) {
      if (pending.cycleId === cycle.cycleId && pending.duelId === duelId) {
        return true;
      }
    }
    return false;
  }

  private resumeDamageFencedTerminal(settledCycleId: string): void {
    if (this.hasPendingDamageForCurrentCycle()) return;
    const deferred = this.damageFencedResolution;
    if (
      deferred &&
      deferred.cycleId === settledCycleId &&
      this.currentCycle?.cycleId === deferred.cycleId
    ) {
      this.damageFencedResolution = null;
      this.handleResolution(
        deferred.winnerId,
        deferred.loserId,
        deferred.winReason,
        deferred.terminalState,
        deferred.terminalAtOverride,
      );
    }

    const deferredAbort = this.damageFencedAbort;
    if (
      !deferredAbort ||
      deferredAbort.cycleId !== settledCycleId ||
      (this.currentCycle?.cycleId !== deferredAbort.cycleId &&
        deferredAbort.cycleOverride?.cycleId !== deferredAbort.cycleId)
    ) {
      return;
    }
    this.damageFencedAbort = null;
    void this.abortCycleToIdle(
      deferredAbort.reason,
      deferredAbort.occurredAtOverride,
      deferredAbort.terminalPersisted,
      deferredAbort.cycleOverride,
    ).then(deferredAbort.resolve, deferredAbort.reject);
  }

  private tick(): void {
    const now = Date.now();
    this.camera.refreshAgentActivity(now);

    // If no active cycle, check if we can start one
    if (!this.currentCycle) {
      this.handleIdleState(now);
      if (!this.currentCycle) {
        this.camera.syncIdlePreviewAndCamera(now);
        return;
      }
    }

    if (this.pendingTerminalTransition) return;

    // Fix K — Watchdog for stuck phases. If any phase exceeds its generous
    // grace period, abort to IDLE rather than staying stuck forever.
    const phaseElapsed = now - this.currentCycle.phaseStartTime;
    // Reduced grace periods (10s instead of 30s) to fail faster on stuck phases
    const PHASE_TIMEOUT_MS: Partial<Record<StreamingPhase, number>> = {
      ANNOUNCEMENT: 10_000 + STREAMING_TIMING.ANNOUNCEMENT_DURATION,
      COUNTDOWN: 5_000 + STREAMING_TIMING.COUNTDOWN_DURATION,
      FIGHTING:
        10_000 +
        STREAMING_TIMING.FIGHTING_DURATION +
        STREAMING_TIMING.END_WARNING_DURATION,
      RESOLUTION: 10_000 + STREAMING_TIMING.RESOLUTION_DURATION,
    };
    const maxPhaseMs = PHASE_TIMEOUT_MS[this.currentCycle.phase];
    if (maxPhaseMs !== undefined && phaseElapsed > maxPhaseMs) {
      if (
        this.currentCycle.phase === "FIGHTING" &&
        this.hasPendingDamageForCurrentCycle()
      ) {
        // Database truth owns the terminal edge. A watchdog cancellation may
        // proceed on the first tick after every exact damage operation settles.
        return;
      }
      Logger.warn(
        "StreamingDuelScheduler",
        `Watchdog: phase ${this.currentCycle.phase} stuck for ${Math.round(phaseElapsed / 1000)}s (max ${Math.round(maxPhaseMs / 1000)}s), aborting`,
      );
      this.abortCycleToIdle(
        `watchdog_${this.currentCycle.phase.toLowerCase()}_timeout`,
      );
      return;
    }

    // Process current phase
    switch (this.currentCycle.phase) {
      case "ANNOUNCEMENT":
        this.tickAnnouncement(now);
        break;
      case "COUNTDOWN":
        // Fix N — COUNTDOWN fallback. If fightStartTime has passed by >2s and
        // the countdownTimeout was lost (GC'd, cleared by accident), force-start.
        if (
          this.currentCycle.fightStartTime &&
          now > this.currentCycle.fightStartTime + 2000 &&
          this.countdownTimeout === null
        ) {
          Logger.warn(
            "StreamingDuelScheduler",
            "COUNTDOWN fallback: fightStartTime passed and countdownTimeout lost, force-starting fight",
          );
          this.doStartFight(now);
        }
        break;
      case "FIGHTING":
        this.tickFighting(now);
        break;
      case "RESOLUTION":
        this.tickResolution(now);
        break;
    }

    // Update camera target
    this.camera.updateCameraTarget(now);
  }

  // ============================================================================
  // State Machine Management
  // ============================================================================

  /**
   * Handle idle state - check if we can start a new cycle
   * Implements proper error handling and auto-recovery for insufficient agents
   */
  private handleIdleState(now: number): void {
    // Guard: don't start a new cycle while endCycle cleanup is still in flight
    if (this._endCycleInProgress) return;

    // Hold the cancelled/no-contest presentation for the same bounded window
    // used by ordinary results so at least one public state broadcast can show
    // the terminal outcome before another matchup replaces it.
    if (this._terminalNotice) {
      if (now < this._terminalNotice.expiresAt) return;
      this._terminalNotice = null;
    }

    this.orchestrator.clearStaleDuelFlagsForIdleAgents(
      this.matchmaking.availableAgents,
    );

    // Check for maintenance mode - don't start new cycles during deployment
    if (config.isMaintenanceMode()) {
      this.schedulerState = "IDLE";
      return;
    }

    // Frozen competitive evidence outranks fresh matchmaking. Recover or
    // durably cancel it even if one/both contestants have not reconnected;
    // otherwise an abandoned real-money market could be hidden behind the
    // ordinary minimum-agent gate.
    if (this.preparationStore && !this.competitiveRecoveryChecked) {
      this.schedulerState = "ACTIVE";
      void this.advancePrivatePreparationGate(now);
      return;
    }

    if (this.matchmaking.availableAgents.size < config.minAgents) {
      this.reconcileStandaloneSparbotsFromWorld();
    }
    const agentCount = this.matchmaking.availableAgents.size;

    if (agentCount >= config.minAgents) {
      // Reset warning counter on success
      if (this.matchmaking.insufficientAgentWarningCount > 0) {
        Logger.info(
          "StreamingDuelScheduler",
          `Agent availability recovered: ${agentCount} agents now available`,
        );
        this.matchmaking.insufficientAgentWarningCount = 0;
      }

      // Transition to active state
      this.schedulerState = "ACTIVE";
      if (this.preparationStore) {
        void this.advancePrivatePreparationGate(now);
      } else {
        void this.startNewCycle();
      }
      return;
    }

    // Not enough agents - implement auto-recovery with logging
    this.schedulerState = "WAITING_FOR_AGENTS";

    // Throttle logging to avoid spam
    const timeSinceLastLog = now - this.matchmaking.lastInsufficientAgentsLog;
    if (timeSinceLastLog >= config.insufficientAgentsRetryInterval) {
      this.matchmaking.insufficientAgentWarningCount++;
      this.matchmaking.lastInsufficientAgentsLog = now;

      const message =
        `Insufficient agents for duel: ${agentCount}/${config.minAgents}. ` +
        `Waiting for agents to join... (check ${this.matchmaking.insufficientAgentWarningCount})`;

      if (
        this.matchmaking.insufficientAgentWarningCount >=
        config.maxInsufficientAgentWarnings
      ) {
        // Escalate to error after multiple warnings
        Logger.error(
          "StreamingDuelScheduler",
          `${message} Consider spawning more agents or checking agent spawner.`,
        );
      } else {
        Logger.warn("StreamingDuelScheduler", message);
      }

      // Emit event for external monitoring
      this.world.emit("streaming:waiting_for_agents", {
        currentAgents: agentCount,
        requiredAgents: config.minAgents,
        warningCount: this.matchmaking.insufficientAgentWarningCount,
      });
    }
  }

  // ============================================================================
  // Cycle Management
  // ============================================================================

  private buildCompetitiveSnapshotContestant(
    side: "agent1" | "agent2",
    agent: AgentContestant,
    planEvidence: CompetitivePreparationEvidence | null,
  ): CompetitiveSnapshotContestant | null {
    const frozen = this.orchestrator.getFrozenCompetitiveState(
      agent.characterId,
    );
    if (!frozen) return null;
    const evidence =
      planEvidence ??
      (frozen.diagnostic
        ? {
            primaryStyle: frozen.initialCombatRole,
            availableStyles: [...frozen.availableCombatStyles],
            planningSource: "diagnostic" as const,
            planningPolicyVersion: "diagnostic-v1",
            agentPolicyFingerprint: null,
            modelProvider: "diagnostic",
            model: "diagnostic",
            tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy(
              frozen.initialCombatRole,
            ),
          }
        : null);
    if (!evidence) return null;
    const plannedStyles = [...evidence.availableStyles].sort().join(",");
    const frozenStyles = [...frozen.availableCombatStyles].sort().join(",");
    if (
      evidence.primaryStyle !== frozen.initialCombatRole ||
      plannedStyles !== frozenStyles
    ) {
      return null;
    }
    agent.provider = evidence.modelProvider;
    agent.model = evidence.model;
    return {
      side,
      agentId: agent.characterId,
      name: agent.name,
      provider: evidence.modelProvider,
      model: evidence.model,
      combatLevel: agent.combatLevel,
      // Full-health start is an existing duel rule enforced during preparation
      // and immediately before combat; bind the promised starting value here.
      startingHp: agent.maxHp,
      maxHp: agent.maxHp,
      wins: agent.wins,
      losses: agent.losses,
      rank: agent.rank,
      headToHeadWins: agent.headToHeadWins,
      headToHeadLosses: agent.headToHeadLosses,
      loadoutFingerprint: frozen.fingerprint,
      equipment: frozen.equipment,
      inventory: frozen.inventory,
      selectedSpell: frozen.selectedSpell,
      skillLevels: frozen.skillLevels,
      prayer: frozen.prayer,
      initialCombatStyle: frozen.initialCombatRole,
      availableCombatStyles: frozen.availableCombatStyles,
      combatLoadouts: frozen.combatLoadouts,
      preparation: evidence,
    };
  }

  private competitiveSnapshotContestantReconstructionIssue(
    agent: AgentContestant,
    planEvidence: CompetitivePreparationEvidence | null,
  ): string {
    const frozen = this.orchestrator.getFrozenCompetitiveState(
      agent.characterId,
    );
    if (!frozen) return "frozen_state_missing";
    const evidence =
      planEvidence ??
      (frozen.diagnostic
        ? {
            primaryStyle: frozen.initialCombatRole,
            availableStyles: [...frozen.availableCombatStyles],
            planningSource: "diagnostic" as const,
            planningPolicyVersion: "diagnostic-v1",
            agentPolicyFingerprint: null,
            modelProvider: "diagnostic",
            model: "diagnostic",
            tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy(
              frozen.initialCombatRole,
            ),
          }
        : null);
    if (!evidence) return "preparation_evidence_missing";
    if (evidence.primaryStyle !== frozen.initialCombatRole) {
      return "primary_style_mismatch";
    }
    const plannedStyles = [...evidence.availableStyles].sort().join(",");
    const frozenStyles = [...frozen.availableCombatStyles].sort().join(",");
    if (plannedStyles !== frozenStyles) return "available_styles_mismatch";
    return "unclassified";
  }

  private contestantFromCompetitiveSnapshot(
    contestant: CompetitiveSnapshotContestant,
  ): AgentContestant {
    const inventory: AgentContestant["inventory"] = Array.from(
      { length: 28 },
      () => null,
    );
    for (const item of contestant.inventory) {
      if (item.slot >= 0 && item.slot < inventory.length) {
        inventory[item.slot] = { itemId: item.itemId, quantity: item.quantity };
      }
    }
    const entity = this.world.entities.get(contestant.agentId) as
      | {
          position?: { x?: number; y?: number; z?: number } | number[];
          data?: {
            position?: { x?: number; y?: number; z?: number } | number[];
          };
        }
      | undefined;
    const rawPosition = entity?.data?.position ?? entity?.position;
    const originalPosition: [number, number, number] = Array.isArray(
      rawPosition,
    )
      ? [
          Number(rawPosition[0]) || 0,
          Number(rawPosition[1]) || 0,
          Number(rawPosition[2]) || 0,
        ]
      : rawPosition && typeof rawPosition === "object"
        ? [
            Number(rawPosition.x) || 0,
            Number(rawPosition.y) || 0,
            Number(rawPosition.z) || 0,
          ]
        : [0, 0, 0];
    return {
      characterId: contestant.agentId,
      name: contestant.name,
      provider: contestant.provider,
      model: contestant.model,
      combatLevel: contestant.combatLevel,
      wins: contestant.wins,
      losses: contestant.losses,
      currentHp: contestant.startingHp,
      maxHp: contestant.maxHp,
      originalPosition,
      damageDealtThisFight: 0,
      highestHit: 0,
      attacksLanded: 0,
      healsUsed: 0,
      equipment: Object.fromEntries(
        contestant.equipment.map((item) => [item.slot, item.itemId]),
      ),
      inventory,
      itemIconPaths: {},
      loadoutFingerprint: contestant.loadoutFingerprint,
      availableCombatStyles: [...contestant.availableCombatStyles],
      combatLoadouts: cloneCombatLoadouts(contestant.combatLoadouts),
      loadoutFrozen: true,
      prayerPointUnits: contestant.prayer.pointUnits,
      prayerPoints: contestant.prayer.points,
      prayerMaxPoints: contestant.prayer.maxPoints,
      rank: contestant.rank,
      headToHeadWins: contestant.headToHeadWins,
      headToHeadLosses: contestant.headToHeadLosses,
    };
  }

  private installRecoveredCompetitiveCycle(
    competitive: PersistedCompetitiveSnapshot,
    agent1: AgentContestant,
    agent2: AgentContestant,
  ): void {
    const { snapshot, digest } = competitive;
    this.phaseStateMachine.transition("ANNOUNCEMENT");
    this.currentCycle = {
      cycleId: snapshot.cycleId,
      phase: "ANNOUNCEMENT",
      cycleStartTime: snapshot.betOpenTime,
      phaseStartTime: snapshot.betOpenTime,
      phaseVersion: 1,
      agent1,
      agent2,
      duelId: snapshot.duelId,
      duelKeyHex: snapshot.duelKey,
      competitiveSnapshotVersion: snapshot.snapshotVersion,
      competitiveSnapshotDigest: digest,
      competitiveSnapshot: snapshot,
      arenaId: null,
      betOpenTime: snapshot.betOpenTime,
      betCloseTime: snapshot.betCloseTime,
      countdownValue: null,
      fightStartTime:
        snapshot.betCloseTime + STREAMING_TIMING.COUNTDOWN_DURATION,
      firstHitAt: null,
      duelEndTime: null,
      arenaPositions: null,
      winnerId: null,
      loserId: null,
      outcome: null,
      winReason: null,
      seed: null,
      replayHash: null,
      recoveredFromPersistence: true,
    };
    this.orchestrator.activatePublicActionObservations(snapshot.cycleId);
    this.durableBettingTerminal = null;
    this.onDeckPreparation = null;
    this.onDeckPreparationPairKey = null;
    this.publicPreparationActivities = null;
    this.camera.clearIdlePreparationActivityCut();
    this.matchmaking.nextDuelPair = null;
  }

  private emitRecoveredCompetitiveCycle(
    competitive: PersistedCompetitiveSnapshot,
  ): void {
    const cycle = this.currentCycle;
    if (!cycle?.agent1 || !cycle.agent2) return;
    const { snapshot, digest, preparation } = competitive;
    const publicAgent = (agent: AgentContestant) => ({
      id: agent.characterId,
      name: agent.name,
      loadoutFingerprint: agent.loadoutFingerprint,
      availableCombatStyles: [...agent.availableCombatStyles],
      combatLoadouts: cloneCombatLoadouts(agent.combatLoadouts),
      prayerPointUnits: agent.prayerPointUnits,
      prayerPoints: agent.prayerPoints,
      prayerMaxPoints: agent.prayerMaxPoints,
    });
    this.world.emit("duel:preparation:frozen", {
      preparationId: preparation.preparationId,
      agent1Id: preparation.agent1Id,
      agent2Id: preparation.agent2Id,
      selectedAt: preparation.selectedAt,
      frozenAt: preparation.frozenAt,
      competitiveSnapshotVersion: snapshot.snapshotVersion,
      competitiveSnapshotDigest: digest,
      recovered: true,
    });
    const lifecyclePayload = {
      cycleId: snapshot.cycleId,
      duelId: snapshot.duelId,
      duelKeyHex: snapshot.duelKey,
      competitiveSnapshotVersion: snapshot.snapshotVersion,
      competitiveSnapshotDigest: digest,
      competitiveSnapshot: snapshot,
      betOpenTime: snapshot.betOpenTime,
      betCloseTime: snapshot.betCloseTime,
      agent1: publicAgent(cycle.agent1),
      agent2: publicAgent(cycle.agent2),
      recovered: true,
    };
    this.world.emit("streaming:cycle:started", lifecyclePayload);
    this.world.emit("streaming:announcement:start", {
      ...lifecyclePayload,
      duration: snapshot.betCloseTime - snapshot.betOpenTime,
    });
    this.world.emit("duel:scheduled", {
      duelId: snapshot.duelId,
      agent1Id: cycle.agent1.characterId,
      agent2Id: cycle.agent2.characterId,
      agent1Name: cycle.agent1.name,
      agent2Name: cycle.agent2.name,
      agent1LoadoutFingerprint: cycle.agent1.loadoutFingerprint,
      agent2LoadoutFingerprint: cycle.agent2.loadoutFingerprint,
      agent1CombatStyles: [...cycle.agent1.availableCombatStyles],
      agent2CombatStyles: [...cycle.agent2.availableCombatStyles],
      agent1CombatLoadouts: cloneCombatLoadouts(cycle.agent1.combatLoadouts),
      agent2CombatLoadouts: cloneCombatLoadouts(cycle.agent2.combatLoadouts),
      agent1PrayerPointUnits: cycle.agent1.prayerPointUnits,
      agent2PrayerPointUnits: cycle.agent2.prayerPointUnits,
      agent1PrayerMaxPoints: cycle.agent1.prayerMaxPoints,
      agent2PrayerMaxPoints: cycle.agent2.prayerMaxPoints,
      competitiveSnapshotVersion: snapshot.snapshotVersion,
      competitiveSnapshotDigest: digest,
      competitiveSnapshot: snapshot,
      startTime: snapshot.betCloseTime,
      recovered: true,
    });
  }

  private async cancelRecoveredCompetitiveSnapshot(
    competitive: PersistedCompetitiveSnapshot,
    reason: string,
    occurredAt: number,
  ): Promise<boolean> {
    const store = this.preparationStore;
    const fencingToken = this.preparationFencingToken;
    if (!store || !fencingToken) return false;
    const terminal = await store.markCompetitiveSnapshotTerminal({
      preparationId: competitive.preparation.preparationId,
      fencingToken,
      snapshotDigest: competitive.digest,
      terminal: {
        outcome: "cancelled",
        winnerId: null,
        winReason: null,
        cancellationReason: reason,
        seed: null,
        replayHash: null,
        terminalAt: occurredAt,
      },
    });
    if (!terminal) return false;
    const agent1 = this.contestantFromCompetitiveSnapshot(
      terminal.snapshot.contestants[0],
    );
    const agent2 = this.contestantFromCompetitiveSnapshot(
      terminal.snapshot.contestants[1],
    );
    this.installRecoveredCompetitiveCycle(terminal, agent1, agent2);
    await this.orchestrator.waitForPublicActionObservations();
    this.competitiveRecoveryChecked = true;
    this.abortCycleToIdle(reason, occurredAt, true);
    return true;
  }

  private async persistCompetitiveTerminal(
    cycle: StreamingDuelCycle,
    terminal: {
      outcome: "win" | "draw" | "cancelled";
      winnerId: string | null;
      winReason: string | null;
      cancellationReason: string | null;
      seed: string | null;
      replayHash: string | null;
      terminalAt: number;
    },
  ): Promise<boolean> {
    const store = this.preparationStore;
    const fencingToken = this.preparationFencingToken;
    const snapshot = cycle.competitiveSnapshot;
    if (!snapshot?.persisted) return true;
    if (
      !store ||
      !fencingToken ||
      !snapshot.preparationId ||
      !cycle.competitiveSnapshotDigest
    ) {
      return false;
    }
    const mark = (
      store as PostgresDuelPreparationStore & {
        markCompetitiveSnapshotTerminal?: PostgresDuelPreparationStore["markCompetitiveSnapshotTerminal"];
      }
    ).markCompetitiveSnapshotTerminal;
    // Test doubles predating durable snapshot lifecycle retain synchronous
    // behavior; the production PostgreSQL store always supplies this method.
    if (!mark) return true;
    const persisted = await mark.call(store, {
      preparationId: snapshot.preparationId,
      fencingToken,
      snapshotDigest: cycle.competitiveSnapshotDigest,
      terminal,
    });
    return persisted?.lifecycleStatus === "terminal";
  }

  private async persistCompetitiveLifecycleMilestone(
    cycle: StreamingDuelCycle,
    milestone: "locked" | "duel",
    occurredAt: number,
  ): Promise<boolean> {
    const store = this.preparationStore;
    const fencingToken = this.preparationFencingToken;
    const snapshot = cycle.competitiveSnapshot;
    if (!snapshot?.persisted) return true;
    if (
      !store ||
      !fencingToken ||
      !snapshot.preparationId ||
      !cycle.competitiveSnapshotDigest
    ) {
      return false;
    }
    const lifecycleStore = store as PostgresDuelPreparationStore & {
      markCompetitiveSnapshotLocked?: PostgresDuelPreparationStore["markCompetitiveSnapshotLocked"];
      markCompetitiveSnapshotDuelStarted?: PostgresDuelPreparationStore["markCompetitiveSnapshotDuelStarted"];
    };
    const persisted =
      milestone === "locked"
        ? await lifecycleStore.markCompetitiveSnapshotLocked?.call(store, {
            preparationId: snapshot.preparationId,
            fencingToken,
            snapshotDigest: cycle.competitiveSnapshotDigest,
            lockedAt: occurredAt,
          })
        : await lifecycleStore.markCompetitiveSnapshotDuelStarted?.call(store, {
            preparationId: snapshot.preparationId,
            fencingToken,
            snapshotDigest: cycle.competitiveSnapshotDigest,
            duelStartedAt: occurredAt,
          });
    // Test doubles predating lifecycle timestamps intentionally omit these
    // methods. The production PostgreSQL store always supplies both.
    if (
      milestone === "locked" &&
      !lifecycleStore.markCompetitiveSnapshotLocked
    ) {
      return true;
    }
    if (
      milestone === "duel" &&
      !lifecycleStore.markCompetitiveSnapshotDuelStarted
    ) {
      return true;
    }
    return Boolean(
      persisted &&
      persisted.lifecycleStatus === "frozen" &&
      (milestone === "locked"
        ? persisted.lockedAt === occurredAt
        : persisted.duelStartedAt === occurredAt),
    );
  }

  private async persistCompetitiveRecovery(
    cycle: StreamingDuelCycle,
    recoveredAt: number,
  ): Promise<boolean> {
    const store = this.preparationStore;
    const fencingToken = this.preparationFencingToken;
    const snapshot = cycle.competitiveSnapshot;
    if (!snapshot?.persisted) return true;
    if (
      !store ||
      !fencingToken ||
      !snapshot.preparationId ||
      !cycle.competitiveSnapshotDigest
    ) {
      return false;
    }
    const mark = (
      store as PostgresDuelPreparationStore & {
        markCompetitiveSnapshotRecovered?: PostgresDuelPreparationStore["markCompetitiveSnapshotRecovered"];
      }
    ).markCompetitiveSnapshotRecovered;
    if (!mark) return true;
    const persisted = await mark.call(store, {
      preparationId: snapshot.preparationId,
      fencingToken,
      snapshotDigest: cycle.competitiveSnapshotDigest,
      recoveredAt,
    });
    return Boolean(
      persisted?.lifecycleStatus === "retired" &&
      persisted.recoveredAt === recoveredAt,
    );
  }

  private waitForCycleRecoveryRetry(): Promise<boolean> {
    if (this.isDestroyed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (shouldRetry: boolean) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.cycleRecoveryRetryWaiters.delete(wakeForShutdown);
        resolve(shouldRetry);
      };
      const wakeForShutdown = () => finish(false);
      this.cycleRecoveryRetryWaiters.add(wakeForShutdown);
      timeout = setTimeout(() => finish(!this.isDestroyed), 1_000);
    });
  }

  private continueRecoveredBacklogWithoutInterCycleDelay(): void {
    this.interCycleTimeout = setTimeout(() => {
      this.interCycleTimeout = null;
      this._endCycleInProgress = false;
      if (this.isDestroyed) return;
      if (this._pendingGracefulRestart) {
        this.triggerGracefulRestart();
        return;
      }
      this.schedulerState = "ACTIVE";
      void this.advancePrivatePreparationGate(Date.now());
    }, 0);
  }

  /**
   * Do not admit another cycle until contestant custody is restored and the
   * immutable terminal snapshot is retired from restart replay. Cleanup may be
   * safely retried from its captured cycle data; once cleanup succeeds, only
   * the exact same recoveredAt write is retried so the durable edge cannot
   * drift across attempts.
   */
  private async recoverCycleUntilCommitted(input: {
    cycle: StreamingDuelCycle;
    cleanup: () => Promise<void>;
    initialCleanup?: Promise<void>;
    context: string;
    terminalAtFloor?: number;
  }): Promise<boolean> {
    let cleanupComplete = false;
    let initialCleanup = input.initialCleanup ?? null;
    let recoveredAt: number | null = null;
    let attempts = 0;

    while (true) {
      let operation = cleanupComplete
        ? "competitive recovery persistence"
        : "contestant cleanup";
      try {
        if (!cleanupComplete) {
          const cleanupAttempt = initialCleanup ?? input.cleanup();
          initialCleanup = null;
          await cleanupAttempt;
          cleanupComplete = true;
          recoveredAt = Math.max(
            Date.now(),
            input.terminalAtFloor ?? 0,
            input.cycle.duelEndTime ?? 0,
          );
          operation = "competitive recovery persistence";
        }
        const persisted = await this.persistCompetitiveRecovery(
          input.cycle,
          recoveredAt!,
        );
        if (!persisted) {
          throw new Error("competitive_recovery_persistence_rejected");
        }
        if (input.cycle.competitiveSnapshot?.persisted) {
          // The claim API intentionally returns one fenced snapshot at a time.
          // A successful retirement therefore proves only this row, not that
          // the restart backlog is empty. Force the idle gate to claim again
          // before any newer preparation or market can be admitted.
          this.competitiveRecoveryChecked = false;
          if (input.cycle.competitiveSnapshot.preparationId) {
            this.releaseCompetitiveRecoveryCustodyHold(
              input.cycle.competitiveSnapshot.preparationId,
            );
          }
        }
        return true;
      } catch (error) {
        attempts++;
        if (attempts === 1 || attempts % 30 === 0 || this.isDestroyed) {
          Logger.warn(
            "StreamingDuelScheduler",
            `${input.context} ${operation} attempt ${attempts} failed closed: ${errMsg(error)}`,
          );
        }
        if (this.isDestroyed || !(await this.waitForCycleRecoveryRetry())) {
          return false;
        }
      }
    }
  }

  private async replayPersistedCompetitiveTerminal(
    competitive: PersistedCompetitiveSnapshot,
    now: number,
  ): Promise<boolean> {
    const terminal = competitive.terminal;
    if (!terminal) return false;
    if (terminal.outcome === "cancelled") {
      return this.cancelRecoveredCompetitiveSnapshot(
        competitive,
        terminal.cancellationReason!,
        terminal.terminalAt,
      );
    }

    const agent1 = this.contestantFromCompetitiveSnapshot(
      competitive.snapshot.contestants[0],
    );
    const agent2 = this.contestantFromCompetitiveSnapshot(
      competitive.snapshot.contestants[1],
    );
    this.installRecoveredCompetitiveCycle(competitive, agent1, agent2);
    await this.orchestrator.waitForPublicActionObservations();
    this.phaseStateMachine.transition("COUNTDOWN");
    this.phaseStateMachine.transition("FIGHTING");
    this.phaseStateMachine.transition("RESOLUTION");
    const cycle = this.currentCycle!;
    cycle.phase = "RESOLUTION";
    // Preserve the original resolution clock. Old terminal backlog rows still
    // publish their immutable result, but they do not consume a fresh full
    // spectator-resolution window after every restart.
    cycle.phaseStartTime = Math.min(
      now,
      Math.max(terminal.terminalAt, now - STREAMING_TIMING.RESOLUTION_DURATION),
    );
    cycle.phaseVersion = 4;
    cycle.duelEndTime = terminal.terminalAt;
    cycle.winnerId = terminal.winnerId;
    cycle.loserId = terminal.winnerId
      ? terminal.winnerId === agent1.characterId
        ? agent2.characterId
        : agent1.characterId
      : null;
    cycle.outcome = terminal.outcome;
    cycle.winReason = terminal.winReason as StreamingDuelWinReason;
    cycle.seed = terminal.seed;
    cycle.replayHash = terminal.replayHash;
    this.durableBettingTerminal = {
      cycle,
      terminal:
        terminal.outcome === "draw"
          ? {
              outcome: "draw",
              cancellationReason: "draw",
              duelEndTime: terminal.terminalAt,
            }
          : null,
    };
    const winnerName = terminal.winnerId
      ? terminal.winnerId === agent1.characterId
        ? agent1.name
        : agent2.name
      : null;
    const loserName = cycle.loserId
      ? cycle.loserId === agent1.characterId
        ? agent1.name
        : agent2.name
      : null;
    this.world.emit("streaming:resolution:start", {
      cycleId: cycle.cycleId,
      duelId: cycle.duelId,
      duelKeyHex: cycle.duelKeyHex,
      duelEndTime: terminal.terminalAt,
      winnerId: terminal.winnerId,
      loserId: cycle.loserId,
      winnerName,
      loserName,
      outcome: terminal.outcome,
      agent1Id: agent1.characterId,
      agent1Name: agent1.name,
      agent2Id: agent2.characterId,
      agent2Name: agent2.name,
      winReason: terminal.winReason,
      seed: terminal.seed,
      replayHash: terminal.replayHash,
      recovered: true,
    });
    if (terminal.outcome === "draw") {
      this.world.emit("streaming:cycle:aborted", {
        cycleId: cycle.cycleId,
        duelId: cycle.duelId,
        duelKeyHex: cycle.duelKeyHex,
        reason: "draw",
        agent1Id: agent1.characterId,
        agent2Id: agent2.characterId,
        agent1Name: agent1.name,
        agent2Name: agent2.name,
        recovered: true,
      });
    }
    this.broadcastState();
    Logger.info(
      "StreamingDuelScheduler",
      `Replayed durable ${terminal.outcome} for cycle ${cycle.cycleId}`,
    );
    this.competitiveRecoveryChecked = true;
    if (terminal.terminalAt + STREAMING_TIMING.RESOLUTION_DURATION <= now) {
      // The exact terminal frame and lifecycle event have already been
      // published above. Do not make an expired restart backlog wait for the
      // next one-second scheduler tick before custody recovery can begin.
      this.endCycle();
    }
    return true;
  }

  /**
   * The launcher-owned sparbots are ordinary persisted character rows but the
   * external-agent server mode intentionally does not auto-start every agent
   * at boot. A cold authority replacement may therefore need to restore only
   * the two exact frozen contestants before digest verification. This path is
   * unavailable outside the explicit loopback/no-money diagnostic boundary.
   */
  private async rehydrateStandaloneSnapshotContestants(
    contestants: readonly CompetitiveSnapshotContestant[],
  ): Promise<void> {
    if (
      !isLocalDiagnosticDuelRuntime(process.env) ||
      contestants.length !== 2 ||
      contestants.some(
        (contestant) => !contestant.agentId.startsWith("sparbot-standalone-"),
      )
    ) {
      return;
    }
    const { getAgentManager } = await import("../../eliza/index.js");
    const agentManager = getAgentManager();
    const db = this.getDatabase();
    if (!agentManager || !db) return;

    const { characters } = await import("../../database/schema.js");
    const { inArray } = await import("drizzle-orm");
    const ids = contestants.map((contestant) => contestant.agentId);
    const rows = await db
      .select({
        id: characters.id,
        accountId: characters.accountId,
        name: characters.name,
        isAgent: characters.isAgent,
      })
      .from(characters)
      .where(inArray(characters.id, ids));
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    if (
      contestants.some((contestant) => {
        const row = rowsById.get(contestant.agentId);
        return (
          !row ||
          row.isAgent !== 1 ||
          row.name !== contestant.name ||
          !String(row.accountId || "").trim()
        );
      })
    ) {
      Logger.warn(
        "StreamingDuelScheduler",
        "Deferred cold standalone recovery because persisted contestant identity is unavailable",
      );
      return;
    }

    const diagnosticAvatarUrl = resolveStreamingDuelDiagnosticAvatarUrl(
      process.env,
    );
    for (const contestant of contestants) {
      const row = rowsById.get(contestant.agentId)!;
      if (!agentManager.hasAgent(contestant.agentId)) {
        await agentManager.createAgent({
          characterId: contestant.agentId,
          accountId: row.accountId,
          name: contestant.name,
          scriptedRole: "combat",
          enableLlm: false,
          characterConfig: {
            name: contestant.name,
            settings: { avatar: diagnosticAvatarUrl },
          },
          autoStart: true,
        });
      }
      agentManager
        .getAgentService(contestant.agentId)
        ?.setAutonomousBehaviorEnabled(false);
      this.restoreStandaloneSparbotIdentity(
        contestant.agentId,
        contestant.name,
        contestant.initialCombatStyle,
      );
      this.registerDiagnosticAgent(contestant.agentId);
    }
  }

  private async recoverFrozenCompetitiveSnapshot(
    now: number,
  ): Promise<"handled" | "none" | "deferred"> {
    const store = this.preparationStore;
    const fencingToken = this.preparationFencingToken;
    if (!store || !fencingToken) return "none";
    const claim = (
      store as PostgresDuelPreparationStore & {
        claimLatestCompetitiveSnapshotForRecovery?: (
          token: string,
        ) => Promise<PersistedCompetitiveSnapshot | null>;
      }
    ).claimLatestCompetitiveSnapshotForRecovery;
    if (!claim) return "none";
    const competitive = await claim.call(store, fencingToken);
    if (!competitive) return "none";
    this.holdCompetitiveSnapshotRecovery(competitive);
    const { snapshot, preparation } = competitive;
    const recoverableLocalDiagnostic =
      snapshot.diagnostic &&
      isLocalDiagnosticDuelRuntime(process.env) &&
      snapshot.contestants.every(
        (contestant) =>
          contestant.agentId.startsWith("sparbot-standalone-") &&
          contestant.preparation.planningSource === "diagnostic",
      );
    const finalizeRecovery = async (
      operation: Promise<boolean>,
    ): Promise<"handled" | "deferred"> =>
      (await operation) ? "handled" : "deferred";
    if (competitive.lifecycleStatus === "terminal") {
      return finalizeRecovery(
        this.replayPersistedCompetitiveTerminal(competitive, now),
      );
    }
    if (snapshot.snapshotVersion !== COMPETITIVE_SNAPSHOT_VERSION) {
      return finalizeRecovery(
        this.cancelRecoveredCompetitiveSnapshot(
          competitive,
          "competitive_snapshot_recovery_loadout_schema_unavailable",
          now,
        ),
      );
    }
    if (
      (snapshot.diagnostic && !recoverableLocalDiagnostic) ||
      !snapshot.persisted ||
      snapshot.preparationId !== preparation.preparationId ||
      snapshot.contestants[0].agentId !== preparation.agent1Id ||
      snapshot.contestants[1].agentId !== preparation.agent2Id
    ) {
      return finalizeRecovery(
        this.cancelRecoveredCompetitiveSnapshot(
          competitive,
          "competitive_snapshot_recovery_invalid",
          now,
        ),
      );
    }
    if (now >= snapshot.betCloseTime) {
      return finalizeRecovery(
        this.cancelRecoveredCompetitiveSnapshot(
          competitive,
          "competitive_snapshot_recovery_window_elapsed",
          now,
        ),
      );
    }

    let agent1 = this.orchestrator.createContestant(
      preparation.agent1Id,
      preparation.agent2Id,
    );
    let agent2 = this.orchestrator.createContestant(
      preparation.agent2Id,
      preparation.agent1Id,
    );
    const expected1 = snapshot.contestants[0];
    const expected2 = snapshot.contestants[1];
    if (!agent1 || !agent2) {
      await this.rehydrateStandaloneSnapshotContestants(snapshot.contestants);
      agent1 = this.orchestrator.createContestant(
        preparation.agent1Id,
        preparation.agent2Id,
      );
      agent2 = this.orchestrator.createContestant(
        preparation.agent2Id,
        preparation.agent1Id,
      );
      // A replacement process initializes AgentManager, entity persistence,
      // inventory, equipment, and Prayer after the scheduler. Preserve the
      // frozen market and retry until the immutable close time instead of
      // cancelling real-money authority because one startup tick ran first.
      if (!agent1 || !agent2) return "deferred";
    }
    const immutableCharacterMatches = (
      agent: AgentContestant | null,
      expected: CompetitiveSnapshotContestant,
    ) =>
      Boolean(
        agent &&
        agent.characterId === expected.agentId &&
        agent.name === expected.name &&
        agent.combatLevel === expected.combatLevel &&
        agent.maxHp === expected.maxHp,
      );
    if (
      !immutableCharacterMatches(agent1, expected1) ||
      !immutableCharacterMatches(agent2, expected2)
    ) {
      return finalizeRecovery(
        this.cancelRecoveredCompetitiveSnapshot(
          competitive,
          "competitive_snapshot_recovery_identity_drift",
          now,
        ),
      );
    }
    // Win/loss/rank/head-to-head data is already committed inside the frozen
    // snapshot. A cold process intentionally starts with empty in-memory
    // leaderboard maps, so re-deriving these fields would reject valid truth
    // or rewrite what bettors saw. Preserve the snapshot values while still
    // requiring live character, skill, health, equipment, inventory, Prayer,
    // policy, and digest verification below.
    for (const [agent, expected] of [
      [agent1!, expected1],
      [agent2!, expected2],
    ] as const) {
      agent.wins = expected.wins;
      agent.losses = expected.losses;
      agent.rank = expected.rank;
      agent.headToHeadWins = expected.headToHeadWins;
      agent.headToHeadLosses = expected.headToHeadLosses;
    }
    const [planRecovery1, planRecovery2] = await Promise.all([
      this.orchestrator.recoverCompetitivePreparationLoadout(
        preparation.agent1Id,
        preparation.preparationId,
      ),
      this.orchestrator.recoverCompetitivePreparationLoadout(
        preparation.agent2Id,
        preparation.preparationId,
      ),
    ]);
    if (!planRecovery1.ok || !planRecovery2.ok) {
      const transientPlanRecoveryReasons = new Set([
        "player_missing",
        "equipment_not_initialized",
        "inventory_not_initialized",
        "inventory_busy",
        "persistence_failed",
      ]);
      if (
        (!planRecovery1.ok &&
          transientPlanRecoveryReasons.has(planRecovery1.reason)) ||
        (!planRecovery2.ok &&
          transientPlanRecoveryReasons.has(planRecovery2.reason))
      ) {
        return "deferred";
      }
      Logger.error(
        "StreamingDuelScheduler",
        `Competitive preparation receipt recovery failed for cycle ${snapshot.cycleId}: agent1=${planRecovery1.ok ? "ready" : planRecovery1.reason}, agent2=${planRecovery2.ok ? "ready" : planRecovery2.reason}`,
      );
      return finalizeRecovery(
        this.cancelRecoveredCompetitiveSnapshot(
          competitive,
          "competitive_snapshot_recovery_loadout_drift",
          now,
        ),
      );
    }
    const policyValidation =
      await this.orchestrator.validateCompetitiveAgentPolicies({
        cycleId: snapshot.cycleId,
        diagnostic: snapshot.diagnostic,
        contestants: snapshot.contestants,
      });
    if (!policyValidation.ok) {
      return finalizeRecovery(
        this.cancelRecoveredCompetitiveSnapshot(
          competitive,
          policyValidation.reason === "competitive_agent_policy_drift"
            ? "competitive_snapshot_recovery_policy_drift"
            : policyValidation.reason ===
                "competitive_tactical_strategy_unavailable"
              ? "competitive_snapshot_recovery_tactical_strategy_unavailable"
              : "competitive_snapshot_recovery_policy_unavailable",
          now,
        ),
      );
    }
    const frozen1 = snapshot.diagnostic
      ? this.orchestrator.restoreDiagnosticCompetitiveLoadoutFromSnapshot(
          agent1!,
          expected1,
        )
      : this.orchestrator.freezeCompetitiveLoadout(agent1!);
    const frozen2 = snapshot.diagnostic
      ? this.orchestrator.restoreDiagnosticCompetitiveLoadoutFromSnapshot(
          agent2!,
          expected2,
        )
      : this.orchestrator.freezeCompetitiveLoadout(agent2!);
    if (
      !frozen1.ok ||
      !frozen2.ok ||
      frozen1.diagnostic !== snapshot.diagnostic ||
      frozen2.diagnostic !== snapshot.diagnostic
    ) {
      this.orchestrator.releaseCompetitiveLoadout(preparation.agent1Id);
      this.orchestrator.releaseCompetitiveLoadout(preparation.agent2Id);
      const transientReasons = new Set([
        "contestant_missing",
        "player_state_unavailable",
        "player_state_not_ready",
        "equipment_state_unavailable",
        "inventory_state_unavailable",
        "inventory_not_ready",
        "equipment_not_ready",
        "equipment_not_initialized",
        "inventory_not_initialized",
        "prayer_state_unavailable",
        "prayer_state_not_ready",
      ]);
      if (
        (!frozen1.ok && transientReasons.has(frozen1.reason)) ||
        (!frozen2.ok && transientReasons.has(frozen2.reason))
      ) {
        return "deferred";
      }
      return finalizeRecovery(
        this.cancelRecoveredCompetitiveSnapshot(
          competitive,
          "competitive_snapshot_recovery_loadout_drift",
          now,
        ),
      );
    }
    const actual1 = this.buildCompetitiveSnapshotContestant(
      "agent1",
      agent1!,
      preparation.agent1PlanEvidence,
    );
    const actual2 = this.buildCompetitiveSnapshotContestant(
      "agent2",
      agent2!,
      preparation.agent2PlanEvidence,
    );
    let digestMatches = false;
    let reconstructedSnapshot: CompetitiveSnapshot | null = null;
    let reconstructedDigest: string | null = null;
    if (actual1 && actual2) {
      const reconstructed = finalizeCompetitiveSnapshot({
        draft: {
          diagnostic: snapshot.diagnostic,
          preparationId: preparation.preparationId,
          cycleId: snapshot.cycleId,
          duelId: snapshot.duelId,
          duelKey: snapshot.duelKey,
          contestants: [actual1, actual2],
        },
        persisted: true,
        frozenAt: snapshot.frozenAt,
        betWindowDurationMs: snapshot.betCloseTime - snapshot.betOpenTime,
        timing: COMPETITIVE_SNAPSHOT_TIMING,
      });
      reconstructedSnapshot = reconstructed.snapshot;
      reconstructedDigest = reconstructed.digest;
      digestMatches = reconstructed.digest === competitive.digest;
    }
    if (!digestMatches) {
      const reconstructionDetails = [
        [agent1!, expected1, preparation.agent1PlanEvidence],
        [agent2!, expected2, preparation.agent2PlanEvidence],
      ].map(([agent, expected, planEvidence]) => {
        const frozen = this.orchestrator.getFrozenCompetitiveState(
          (agent as AgentContestant).characterId,
        );
        return {
          agentId: (agent as AgentContestant).characterId,
          expectedPrimaryStyle: (
            planEvidence as CompetitivePreparationEvidence | null
          )?.primaryStyle,
          expectedInitialCombatStyle: (
            expected as CompetitiveSnapshotContestant
          ).initialCombatStyle,
          actualInitialCombatStyle: frozen?.initialCombatRole ?? null,
          expectedAvailableCombatStyles: (
            expected as CompetitiveSnapshotContestant
          ).availableCombatStyles,
          actualAvailableCombatStyles: frozen?.availableCombatStyles ?? null,
          expectedLoadoutFingerprint: (
            expected as CompetitiveSnapshotContestant
          ).loadoutFingerprint,
          actualLoadoutFingerprint: frozen?.fingerprint ?? null,
          actualEquipment: frozen?.equipment ?? null,
          actualSelectedSpell: frozen?.selectedSpell ?? null,
        };
      });
      const mismatchPaths = reconstructedSnapshot
        ? competitiveSnapshotMismatchPaths(snapshot, reconstructedSnapshot)
        : [
            ...(!actual1
              ? [
                  `$.contestants[0].reconstruction.${this.competitiveSnapshotContestantReconstructionIssue(
                    agent1!,
                    preparation.agent1PlanEvidence,
                  )}`,
                ]
              : []),
            ...(!actual2
              ? [
                  `$.contestants[1].reconstruction.${this.competitiveSnapshotContestantReconstructionIssue(
                    agent2!,
                    preparation.agent2PlanEvidence,
                  )}`,
                ]
              : []),
          ];
      Logger.error(
        "StreamingDuelScheduler",
        `Competitive snapshot recovery integrity failure for cycle ${snapshot.cycleId}; mismatchPaths=${mismatchPaths.join(",")}; reconstruction=${JSON.stringify(reconstructionDetails)}`,
        null,
        {
          preparationId: preparation.preparationId,
          cycleId: snapshot.cycleId,
          expectedDigest: competitive.digest,
          reconstructedDigest,
          mismatchPaths,
          reconstructionDetails,
        },
      );
      this.orchestrator.releaseCompetitiveLoadout(preparation.agent1Id);
      this.orchestrator.releaseCompetitiveLoadout(preparation.agent2Id);
      return finalizeRecovery(
        this.cancelRecoveredCompetitiveSnapshot(
          competitive,
          "competitive_snapshot_recovery_state_drift",
          now,
        ),
      );
    }

    this.installRecoveredCompetitiveCycle(competitive, agent1!, agent2!);
    await this.orchestrator.waitForPublicActionObservations();
    this.orchestrator.setDuelFlags(true);
    this.orchestrator.forceStopAgentCombat(agent1!.characterId);
    this.orchestrator.forceStopAgentCombat(agent2!.characterId);
    this.orchestrator.restoreHealth(agent1!.characterId);
    this.orchestrator.restoreHealth(agent2!.characterId);
    this.camera.setCameraTarget(agent1!.characterId, now);
    try {
      this.orchestrator.teleportToArena(
        agent1!.characterId,
        agent2!.characterId,
        true,
      );
    } catch (error) {
      if (this.currentCycle?.cycleId === snapshot.cycleId) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Failed to restage recovered contestants: ${errMsg(error)}`,
        );
        this.abortCycleToIdle("arena_teleport_failed");
      }
      this.competitiveRecoveryChecked = true;
      return "handled";
    }
    this.emitRecoveredCompetitiveCycle(competitive);
    Logger.info(
      "StreamingDuelScheduler",
      `Recovered frozen cycle ${snapshot.cycleId} with immutable digest ${competitive.digest}`,
    );
    this.competitiveRecoveryChecked = true;
    return "handled";
  }

  private releasePreMarketProcessingFences(): void {
    for (const fence of this.preMarketProcessingFences) fence.release();
    this.preMarketProcessingFences = [];
  }

  private arePlayersProcessingQuiescent(playerIds: readonly string[]): boolean {
    return playerIds.every((playerId) =>
      isPlayerProcessingQuiescent(this.world, playerId),
    );
  }

  /**
   * Keep failed or timed-out admissions fenced until every loaded processing
   * authority reports idle. The retry timer is deliberately unref'd so a
   * failed diagnostic cannot keep a shutting-down server process alive.
   */
  private releaseProcessingFencesWhenSettled(
    fences: PreparationActionFence[],
    playerIds: readonly string[],
  ): void {
    const pending = {
      fences,
      playerIds: [...playerIds],
      timeout: null as ReturnType<typeof setTimeout> | null,
    };
    this.deferredProcessingFenceReleases.add(pending);

    const check = (): void => {
      pending.timeout = null;
      if (
        this.isDestroyed ||
        this.arePlayersProcessingQuiescent(pending.playerIds)
      ) {
        for (const fence of pending.fences) fence.release();
        this.deferredProcessingFenceReleases.delete(pending);
        return;
      }
      pending.timeout = setTimeout(
        check,
        STREAMING_TIMING.STATE_BROADCAST_INTERVAL,
      );
      (
        pending.timeout as ReturnType<typeof setTimeout> & {
          unref?: () => void;
        }
      ).unref?.();
    };

    check();
  }

  private async waitForPlayerProcessingQuiescence(
    playerIds: readonly string[],
    deadline: number,
  ): Promise<boolean> {
    while (!this.isDestroyed) {
      if (this.arePlayersProcessingQuiescent(playerIds)) return true;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      await new Promise<void>((resolve) => {
        setTimeout(
          resolve,
          Math.min(STREAMING_TIMING.STATE_BROADCAST_INTERVAL, remainingMs),
        );
      });
    }
    return false;
  }

  /**
   * Fence new work first, then cancel uncommitted work and wait for any
   * admitted durable action to settle. A competitive snapshot is never frozen
   * unless both contestants are authoritatively idle before the preparation
   * lease expires. DB-free diagnostics get an immediate, no-wait boundary.
   */
  private quiesceContestantsBeforeCompetitiveFreeze(
    playerIds: readonly string[],
    preparation?: DuelPreparationSnapshot,
  ): boolean | Promise<boolean> {
    this.releasePreMarketProcessingFences();
    const fences = playerIds.map((playerId) =>
      acquirePreparationActionFence(this.world, playerId),
    );
    let failedRequest: ReturnType<
      typeof requestPlayerProcessingQuiescence
    > | null = null;
    for (const playerId of playerIds) {
      const result = requestPlayerProcessingQuiescence(this.world, playerId);
      if (!result.ok && !failedRequest) failedRequest = result;
    }
    if (failedRequest && !failedRequest.ok) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Cycle rejected before market processing barrier: ${failedRequest.reason}${failedRequest.systemName ? `:${failedRequest.systemName}` : ""}`,
      );
      this.releaseProcessingFencesWhenSettled(fences, playerIds);
      return false;
    }

    if (this.arePlayersProcessingQuiescent(playerIds)) {
      this.preMarketProcessingFences = fences;
      return true;
    }

    const deadline = preparation?.expiresAt ?? Date.now();
    if (deadline <= Date.now()) {
      this.releaseProcessingFencesWhenSettled(fences, playerIds);
      return false;
    }

    return this.waitForPlayerProcessingQuiescence(playerIds, deadline).then(
      (quiet) => {
        if (!quiet) {
          this.releaseProcessingFencesWhenSettled(fences, playerIds);
          return false;
        }
        this.preMarketProcessingFences = fences;
        return true;
      },
    );
  }

  private startNewCycle(
    forcedPair?: {
      agent1Id: string;
      agent2Id: string;
      selectedAt: number;
    },
    preparation?: DuelPreparationSnapshot,
  ): Promise<boolean> {
    if (this._startCycleInProgress) return Promise.resolve(false);
    this._startCycleInProgress = true;
    return this.startNewCycleInternal(forcedPair, preparation)
      .then(() => this.currentCycle !== null)
      .catch(async (error: unknown) => {
        if (this.isDestroyed) return false;
        await this.reconcilePersistedStreamingDuelParticipation(
          preparation
            ? [preparation.agent1Id, preparation.agent2Id]
            : forcedPair
              ? [forcedPair.agent1Id, forcedPair.agent2Id]
              : [],
        );
        Logger.error(
          "StreamingDuelScheduler",
          `Failed to start duel cycle: ${errMsg(error)}`,
        );
        if (this.currentCycle) {
          this.abortCycleToIdle("cycle_start_failed");
        } else {
          this.schedulerState = "WAITING_FOR_AGENTS";
        }
        return false;
      })
      .finally(() => {
        this.releasePreMarketProcessingFences();
        this._startCycleInProgress = false;
      });
  }

  private async startNewCycleInternal(
    forcedPair?: {
      agent1Id: string;
      agent2Id: string;
      selectedAt: number;
    },
    preparation?: DuelPreparationSnapshot,
  ): Promise<void> {
    // Guard: don't start a new cycle while endCycle cleanup is still in flight
    if (this._endCycleInProgress) {
      Logger.warn(
        "StreamingDuelScheduler",
        "startNewCycle blocked: endCycle cleanup still in progress",
      );
      return;
    }

    const cycleId = uuidv4();
    const now = Date.now();
    this._terminalNotice = null;

    const agents = Array.from(this.matchmaking.availableAgents);

    // CRITICAL: Double-check agent count with error handling
    if (agents.length < config.minAgents) {
      Logger.error(
        "StreamingDuelScheduler",
        `startNewCycle called with insufficient agents: ${agents.length}/${config.minAgents}. ` +
          `This indicates a state machine bug.`,
      );
      this.schedulerState = "WAITING_FOR_AGENTS";
      return;
    }

    // Validate all agents still exist in the world before selection
    const validAgents = agents.filter((agentId) => {
      const entity = this.world.entities.get(agentId);
      if (!entity) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Agent ${agentId} no longer exists in world, removing from available list`,
        );
        this.matchmaking.availableAgents.delete(agentId);
        return false;
      }
      const runtimeStatus = this.getContestantRuntimeStatus(agentId);
      if (runtimeStatus !== "alive") {
        Logger.warn(
          "StreamingDuelScheduler",
          `Agent ${agentId} is not alive at cycle preflight (${runtimeStatus})`,
        );
        return false;
      }
      return true;
    });

    // A public matchup can only be selected from contestants whose current
    // authoritative loadout can be frozen. This is a read-only preflight; the
    // selected pair is frozen below before any market-open event is emitted.
    const loadoutReadyAgents = validAgents.filter((agentId) => {
      const readiness = this.orchestrator.inspectCompetitiveLoadout(agentId);
      if (readiness.ok) return true;
      Logger.warn(
        "StreamingDuelScheduler",
        `Agent ${agentId} is not duel-ready: ${readiness.reason}`,
      );
      return false;
    });

    // Re-check after world and competitive-readiness validation.
    if (loadoutReadyAgents.length < config.minAgents) {
      Logger.warn(
        "StreamingDuelScheduler",
        `After readiness validation, only ${loadoutReadyAgents.length} valid agents remain. Waiting for more.`,
      );
      this.schedulerState = "WAITING_FOR_AGENTS";
      return;
    }

    const validReadySet = new Set(loadoutReadyAgents);
    const selectedPair = forcedPair
      ? validReadySet.has(forcedPair.agent1Id) &&
        validReadySet.has(forcedPair.agent2Id) &&
        forcedPair.agent1Id !== forcedPair.agent2Id
        ? forcedPair
        : null
      : (this.matchmaking.consumePreselectedDuelPair(loadoutReadyAgents) ??
        this.matchmaking.chooseRandomPairFromPool(loadoutReadyAgents, now));
    const agent1Id = selectedPair?.agent1Id ?? null;
    const agent2Id = selectedPair?.agent2Id ?? null;

    // Validate: ensure different agents selected (safety check)
    if (!agent1Id || !agent2Id || agent1Id === agent2Id) {
      Logger.error(
        "StreamingDuelScheduler",
        "Could not select two distinct valid agents for a cycle",
      );
      return;
    }

    // Get agent data
    const agent1 = this.orchestrator.createContestant(agent1Id, agent2Id);
    const agent2 = this.orchestrator.createContestant(agent2Id, agent1Id);

    if (!agent1 || !agent2) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Failed to create contestants: agent1=${!!agent1}, agent2=${!!agent2}`,
      );
      // Remove invalid agents from available list
      if (!agent1) this.matchmaking.availableAgents.delete(agent1Id);
      if (!agent2) this.matchmaking.availableAgents.delete(agent2Id);
      return;
    }

    const selectedReadiness1 =
      this.orchestrator.inspectCompetitiveLoadout(agent1Id);
    const selectedReadiness2 =
      this.orchestrator.inspectCompetitiveLoadout(agent2Id);
    const diagnosticPair =
      selectedReadiness1.ok &&
      selectedReadiness2.ok &&
      selectedReadiness1.diagnostic &&
      selectedReadiness2.diagnostic;
    const [prayerReady1, prayerReady2] = diagnosticPair
      ? ([{ ok: true }, { ok: true }] as const)
      : await Promise.all([
          this.orchestrator.preparePrayerForCompetitiveFreeze(agent1Id),
          this.orchestrator.preparePrayerForCompetitiveFreeze(agent2Id),
        ]);
    if (this.isDestroyed) return;
    if (!prayerReady1.ok || !prayerReady2.ok) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Cycle rejected before market prayer freeze: agent1=${prayerReady1.ok ? "ready" : prayerReady1.reason}, agent2=${prayerReady2.ok ? "ready" : prayerReady2.reason}`,
      );
      this.schedulerState = "WAITING_FOR_AGENTS";
      return;
    }

    // Prayer policy may involve an asynchronous provider check. Revalidate
    // authoritative life at the final private boundary before loadout freeze
    // can create a market-visible competitive snapshot.
    if (
      this.getContestantRuntimeStatus(agent1Id) !== "alive" ||
      this.getContestantRuntimeStatus(agent2Id) !== "alive"
    ) {
      Logger.warn(
        "StreamingDuelScheduler",
        "Cycle rejected before market freeze because a contestant became unavailable",
      );
      this.schedulerState = "WAITING_FOR_AGENTS";
      return;
    }

    const processingQuiescence = this.quiesceContestantsBeforeCompetitiveFreeze(
      [agent1Id, agent2Id],
      preparation,
    );
    const processingQuiescent =
      typeof processingQuiescence === "boolean"
        ? processingQuiescence
        : await processingQuiescence;
    if (!processingQuiescent) {
      if (!this.isDestroyed) {
        Logger.warn(
          "StreamingDuelScheduler",
          "Cycle rejected before market freeze because contestant processing did not become idle before the preparation deadline",
        );
        this.schedulerState = "WAITING_FOR_AGENTS";
      }
      return;
    }

    try {
      // Quiescence can wait for an already-committed transaction. Revalidate
      // life after that wait and before creating any market-visible snapshot.
      if (
        this.isDestroyed ||
        this.getContestantRuntimeStatus(agent1Id) !== "alive" ||
        this.getContestantRuntimeStatus(agent2Id) !== "alive"
      ) {
        if (!this.isDestroyed) this.schedulerState = "WAITING_FOR_AGENTS";
        return;
      }

      const frozen1 = this.orchestrator.freezeCompetitiveLoadout(agent1);
      const frozen2 = this.orchestrator.freezeCompetitiveLoadout(agent2);
      if (
        !frozen1.ok ||
        !frozen2.ok ||
        frozen1.diagnostic !== frozen2.diagnostic
      ) {
        this.orchestrator.releaseCompetitiveLoadout(agent1Id);
        this.orchestrator.releaseCompetitiveLoadout(agent2Id);
        Logger.warn(
          "StreamingDuelScheduler",
          `Cycle rejected before market open: agent1=${frozen1.ok ? (frozen1.diagnostic ? "diagnostic" : "frozen") : frozen1.reason}, agent2=${frozen2.ok ? (frozen2.diagnostic ? "diagnostic" : "frozen") : frozen2.reason}`,
        );
        this.schedulerState = "WAITING_FOR_AGENTS";
        return;
      }

      const duelId = `streaming-${cycleId}`;
      const duelKeyHex = this.deriveStreamingDuelKeyHex(cycleId);
      if (
        this.preparationStore &&
        (!preparation ||
          preparation.status !== "ready" ||
          preparation.agent1Id !== agent1.characterId ||
          preparation.agent2Id !== agent2.characterId)
      ) {
        this.orchestrator.releaseCompetitiveLoadout(agent1Id);
        this.orchestrator.releaseCompetitiveLoadout(agent2Id);
        throw new Error("durable_preparation_snapshot_mismatch");
      }
      if (
        !this.preparationStore &&
        process.env.NODE_ENV === "production" &&
        !diagnosticPair
      ) {
        this.orchestrator.releaseCompetitiveLoadout(agent1Id);
        this.orchestrator.releaseCompetitiveLoadout(agent2Id);
        Logger.error(
          "StreamingDuelScheduler",
          "Production market rejected: durable preparation/snapshot store is not configured",
        );
        this.schedulerState = "WAITING_FOR_AGENTS";
        return;
      }

      const snapshotAgent1 = this.buildCompetitiveSnapshotContestant(
        "agent1",
        agent1,
        preparation?.agent1PlanEvidence ?? null,
      );
      const snapshotAgent2 = this.buildCompetitiveSnapshotContestant(
        "agent2",
        agent2,
        preparation?.agent2PlanEvidence ?? null,
      );
      if (!snapshotAgent1 || !snapshotAgent2) {
        this.orchestrator.releaseCompetitiveLoadout(agent1Id);
        this.orchestrator.releaseCompetitiveLoadout(agent2Id);
        throw new Error("competitive_snapshot_evidence_mismatch");
      }
      if (!diagnosticPair) {
        const policyValidation =
          await this.orchestrator.validateCompetitiveAgentPolicies({
            cycleId,
            diagnostic: false,
            contestants: [snapshotAgent1, snapshotAgent2],
          });
        if (!policyValidation.ok) {
          this.orchestrator.releaseCompetitiveLoadout(agent1Id);
          this.orchestrator.releaseCompetitiveLoadout(agent2Id);
          throw new Error(policyValidation.reason);
        }
      }
      const snapshotDraft: CompetitiveSnapshotDraft = {
        diagnostic: diagnosticPair,
        preparationId: preparation?.preparationId ?? null,
        cycleId,
        duelId,
        duelKey: duelKeyHex,
        contestants: [snapshotAgent1, snapshotAgent2],
      };
      let competitive:
        | Pick<
            PersistedCompetitiveSnapshot,
            "preparation" | "snapshot" | "digest"
          >
        | {
            preparation: null;
            snapshot: CompetitiveSnapshot;
            digest: string;
          }
        | null;
      if (this.preparationStore) {
        try {
          competitive =
            await this.preparationStore.freezeWithCompetitiveSnapshot({
              preparationId: preparation!.preparationId,
              fencingToken: this.preparationFencingToken!,
              draft: snapshotDraft,
              betWindowDurationMs: STREAMING_TIMING.ANNOUNCEMENT_DURATION,
              timing: COMPETITIVE_SNAPSHOT_TIMING,
            });
        } catch (error) {
          this.orchestrator.releaseCompetitiveLoadout(agent1Id);
          this.orchestrator.releaseCompetitiveLoadout(agent2Id);
          throw error;
        }
      } else {
        // Keep the isolated DB-free diagnostic lane synchronous. Besides
        // preserving deterministic local harnesses, this avoids a window where
        // init() reports IDLE even though a diagnostic cycle has already been
        // selected. The production branch above remains durably awaited.
        competitive = {
          preparation: null,
          ...finalizeCompetitiveSnapshot({
            draft: snapshotDraft,
            persisted: false,
            frozenAt: Date.now(),
            betWindowDurationMs: STREAMING_TIMING.ANNOUNCEMENT_DURATION,
            timing: COMPETITIVE_SNAPSHOT_TIMING,
          }),
        };
      }
      if (!competitive) {
        this.orchestrator.releaseCompetitiveLoadout(agent1Id);
        this.orchestrator.releaseCompetitiveLoadout(agent2Id);
        throw new Error("competitive_snapshot_persistence_failed");
      }
      if (this.isDestroyed) {
        this.orchestrator.releaseCompetitiveLoadout(agent1Id);
        this.orchestrator.releaseCompetitiveLoadout(agent2Id);
        return;
      }
      const { snapshot, digest: competitiveSnapshotDigest } = competitive;
      const betOpenTime = snapshot.betOpenTime;
      const betCloseTime = snapshot.betCloseTime;

      this.phaseStateMachine.transition("ANNOUNCEMENT");
      this.currentCycle = {
        cycleId,
        phase: "ANNOUNCEMENT",
        cycleStartTime: betOpenTime,
        phaseStartTime: betOpenTime,
        phaseVersion: 1,
        agent1,
        agent2,
        duelId,
        duelKeyHex,
        competitiveSnapshotVersion: snapshot.snapshotVersion,
        competitiveSnapshotDigest,
        competitiveSnapshot: snapshot,
        arenaId: null,
        betOpenTime,
        betCloseTime,
        countdownValue: null,
        fightStartTime: betCloseTime + STREAMING_TIMING.COUNTDOWN_DURATION,
        firstHitAt: null,
        duelEndTime: null,
        arenaPositions: null,
        winnerId: null,
        loserId: null,
        outcome: null,
        winReason: null,
        seed: null,
        replayHash: null,
      };
      this.durableBettingTerminal = null;
      if (competitive.preparation) {
        this.world.emit("duel:preparation:frozen", {
          preparationId: competitive.preparation.preparationId,
          agent1Id: competitive.preparation.agent1Id,
          agent2Id: competitive.preparation.agent2Id,
          selectedAt: competitive.preparation.selectedAt,
          frozenAt: competitive.preparation.frozenAt,
          competitiveSnapshotVersion: snapshot.snapshotVersion,
          competitiveSnapshotDigest,
        });
      }
      this.matchmaking.refreshNextDuelPair(betOpenTime);
      this.notifyOnDeckAgents();

      // Mark agents as in a streaming duel immediately so their autonomous AI
      // won't make them attack each other or wander into combat during announcement.
      this.orchestrator.setDuelFlags(true);

      // Force-end any combat the selected agents are already in.
      this.orchestrator.forceStopAgentCombat(agent1.characterId);
      this.orchestrator.forceStopAgentCombat(agent2.characterId);

      // Restore full health immediately so the first broadcast shows full HP.
      this.orchestrator.restoreHealth(agent1.characterId);
      this.orchestrator.restoreHealth(agent2.characterId);

      // Present the announced matchup in the arena immediately. Waiting until
      // COUNTDOWN left both selected contestants at their previous world
      // positions for the full market-open window, so the canonical camera had
      // no in-ring subjects and briefly framed hidden/overlapping avatars. The
      // countdown prep teleports to these same marks again after loadout work,
      // making that second placement idempotent rather than a visible snap.
      try {
        this.orchestrator.teleportToArena(
          agent1.characterId,
          agent2.characterId,
          true,
        );
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Failed to stage announced contestants in arena: ${errMsg(err)}`,
        );
        this.abortCycleToIdle("arena_teleport_failed");
        return;
      }

      // Set initial camera target
      this.camera.setCameraTarget(agent1.characterId, betOpenTime);

      Logger.info(
        "StreamingDuelScheduler",
        `New cycle started: ${agent1.name} vs ${agent2.name}`,
      );

      // Emit announcement event
      this.world.emit("streaming:cycle:started", {
        cycleId,
        duelId,
        duelKeyHex: this.currentCycle.duelKeyHex,
        competitiveSnapshotVersion: snapshot.snapshotVersion,
        competitiveSnapshotDigest,
        competitiveSnapshot: snapshot,
        betOpenTime,
        betCloseTime,
        agent1: {
          id: agent1.characterId,
          name: agent1.name,
          loadoutFingerprint: agent1.loadoutFingerprint,
          availableCombatStyles: agent1.availableCombatStyles,
          combatLoadouts: cloneCombatLoadouts(agent1.combatLoadouts),
          prayerPointUnits: agent1.prayerPointUnits,
          prayerPoints: agent1.prayerPoints,
          prayerMaxPoints: agent1.prayerMaxPoints,
        },
        agent2: {
          id: agent2.characterId,
          name: agent2.name,
          loadoutFingerprint: agent2.loadoutFingerprint,
          availableCombatStyles: agent2.availableCombatStyles,
          combatLoadouts: cloneCombatLoadouts(agent2.combatLoadouts),
          prayerPointUnits: agent2.prayerPointUnits,
          prayerPoints: agent2.prayerPoints,
          prayerMaxPoints: agent2.prayerMaxPoints,
        },
      });

      this.world.emit("streaming:announcement:start", {
        cycleId,
        duelId,
        duelKeyHex: this.currentCycle.duelKeyHex,
        competitiveSnapshotVersion: snapshot.snapshotVersion,
        competitiveSnapshotDigest,
        competitiveSnapshot: snapshot,
        betOpenTime,
        betCloseTime,
        agent1: {
          id: agent1.characterId,
          name: agent1.name,
          loadoutFingerprint: agent1.loadoutFingerprint,
          availableCombatStyles: agent1.availableCombatStyles,
          combatLoadouts: cloneCombatLoadouts(agent1.combatLoadouts),
          prayerPointUnits: agent1.prayerPointUnits,
          prayerPoints: agent1.prayerPoints,
          prayerMaxPoints: agent1.prayerMaxPoints,
        },
        agent2: {
          id: agent2.characterId,
          name: agent2.name,
          loadoutFingerprint: agent2.loadoutFingerprint,
          availableCombatStyles: agent2.availableCombatStyles,
          combatLoadouts: cloneCombatLoadouts(agent2.combatLoadouts),
          prayerPointUnits: agent2.prayerPointUnits,
          prayerPoints: agent2.prayerPoints,
          prayerMaxPoints: agent2.prayerMaxPoints,
        },
        duration: STREAMING_TIMING.ANNOUNCEMENT_DURATION,
      });

      // Hyperbet / DuelBettingBridge: same payload shape as legacy DuelScheduler
      this.world.emit("duel:scheduled", {
        duelId,
        agent1Id: agent1.characterId,
        agent2Id: agent2.characterId,
        agent1Name: agent1.name,
        agent2Name: agent2.name,
        agent1LoadoutFingerprint: agent1.loadoutFingerprint,
        agent2LoadoutFingerprint: agent2.loadoutFingerprint,
        agent1CombatStyles: agent1.availableCombatStyles,
        agent2CombatStyles: agent2.availableCombatStyles,
        agent1CombatLoadouts: cloneCombatLoadouts(agent1.combatLoadouts),
        agent2CombatLoadouts: cloneCombatLoadouts(agent2.combatLoadouts),
        agent1PrayerPointUnits: agent1.prayerPointUnits,
        agent2PrayerPointUnits: agent2.prayerPointUnits,
        agent1PrayerMaxPoints: agent1.prayerMaxPoints,
        agent2PrayerMaxPoints: agent2.prayerMaxPoints,
        competitiveSnapshotVersion: snapshot.snapshotVersion,
        competitiveSnapshotDigest,
        competitiveSnapshot: snapshot,
        startTime: betCloseTime,
      });
    } finally {
      this.releasePreMarketProcessingFences();
    }
  }

  /**
   * Notify on-deck agents that they are next up for a duel so they can prepare
   * (bank items, withdraw food, move to arena lobby).
   */
  private notifyOnDeckAgents(): void {
    const pair = this.matchmaking.nextDuelPair;
    if (!pair) return;

    if (this.preparationStore) {
      void this.beginOnDeckPreparation(pair);
      return;
    }

    const agent1Entity = this.world.entities.get(pair.agent1Id);
    const agent2Entity = this.world.entities.get(pair.agent2Id);
    const agent1Name =
      (agent1Entity?.data as { name?: string })?.name ?? "Unknown";
    const agent2Name =
      (agent2Entity?.data as { name?: string })?.name ?? "Unknown";

    this.world.emit("duel:on-deck", {
      agent1Id: pair.agent1Id,
      agent1Name,
      agent2Id: pair.agent2Id,
      agent2Name,
    });

    Logger.info(
      "StreamingDuelScheduler",
      `On-deck notification sent: ${agent1Name} vs ${agent2Name}`,
    );
  }

  private async beginOnDeckPreparation(pair: {
    agent1Id: string;
    agent2Id: string;
  }): Promise<void> {
    const store = this.preparationStore;
    const durationMs = this.preparationDurationMs;
    const fencingToken = this.preparationFencingToken;
    if (!store || durationMs === null || !fencingToken) return;

    // Agent registration can select an on-deck pair before the scheduler's
    // first idle tick. Never persist or disclose a fresh preparation until the
    // entire fenced competitive-recovery backlog has been proven empty.
    if (!this.competitiveRecoveryChecked) return;

    const currentContestants = new Set(
      [
        this.currentCycle?.agent1?.characterId,
        this.currentCycle?.agent2?.characterId,
      ].filter((id): id is string => Boolean(id)),
    );
    if (
      currentContestants.has(pair.agent1Id) ||
      currentContestants.has(pair.agent2Id)
    ) {
      // With a two-agent population the next pair is necessarily the current
      // pair. Defer private banking until cleanup has released duel custody.
      return;
    }

    const pairKey = `${pair.agent1Id}\u0000${pair.agent2Id}`;
    if (
      this.onDeckPreparationPairKey === pairKey &&
      (this.onDeckPreparation?.status === "preparing" ||
        this.onDeckPreparation?.status === "ready")
    ) {
      return;
    }

    if (
      this.preparationSelectionInFlight &&
      this.preparationSelectionInFlightPairKey === pairKey
    ) {
      // Selection delivery may include agent-side prayer/loadout preparation.
      // Reconciliation must never queue behind that work: the durable gate is
      // responsible for observing readiness, expiry, and recovery independently.
      return;
    }

    const previousSelection = this.preparationSelectionInFlight;
    if (previousSelection) {
      // Invalidate a selection for a different pair, then let its own bounded
      // persistence path unwind. A later scheduler tick will start the current
      // pair without accumulating waiters behind the old promise.
      ++this.preparationSelectionGeneration;
      return;
    }

    const generation = ++this.preparationSelectionGeneration;
    const selection = this.persistOnDeckPreparation(pair, pairKey, generation);
    this.preparationSelectionInFlight = selection;
    this.preparationSelectionInFlightPairKey = pairKey;
    try {
      await selection;
    } finally {
      if (this.preparationSelectionInFlight === selection) {
        this.preparationSelectionInFlight = null;
        this.preparationSelectionInFlightPairKey = null;
      }
    }
  }

  private async persistOnDeckPreparation(
    pair: { agent1Id: string; agent2Id: string },
    pairKey: string,
    generation: number,
  ): Promise<void> {
    const store = this.preparationStore;
    const durationMs = this.preparationDurationMs;
    const fencingToken = this.preparationFencingToken;
    if (!store || durationMs === null || !fencingToken) return;
    try {
      await this.matchmaking.waitForAgentStatsHydration([
        pair.agent1Id,
        pair.agent2Id,
      ]);
      const preparation = await store.create({
        preparationId: uuidv4(),
        fencingToken,
        agent1Id: pair.agent1Id,
        agent2Id: pair.agent2Id,
        diagnostic:
          isLocalDiagnosticDuelRuntime(process.env) &&
          [pair.agent1Id, pair.agent2Id].every((agentId) => {
            const readiness =
              this.orchestrator.inspectCompetitiveLoadout(agentId);
            return readiness.ok && readiness.diagnostic;
          }),
        durationMs,
        allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
      });
      const currentPair = this.matchmaking.nextDuelPair;
      if (
        generation !== this.preparationSelectionGeneration ||
        currentPair?.agent1Id !== pair.agent1Id ||
        currentPair?.agent2Id !== pair.agent2Id
      ) {
        await store.cancel({
          preparationId: preparation.preparationId,
          fencingToken,
          reason: "pair_changed",
        });
        return;
      }
      this.onDeckPreparation = preparation;
      this.onDeckPreparationPairKey = pairKey;
      const announced = await this.emitOnDeckPreparationSelected(preparation);
      Logger.info(
        "StreamingDuelScheduler",
        `Private preparation selected: ${pair.agent1Id} vs ${pair.agent2Id}`,
      );
      if (
        announced.status === "ready" &&
        !this.currentCycle &&
        !config.isMaintenanceMode()
      ) {
        // Diagnostic contestants can become ready inside selection delivery.
        // Reconcile immediately instead of waiting for the next one-second
        // scheduler tick, which can land just beyond the supported one-second
        // minimum preparation window. Maintenance remains an absolute launch
        // fence even if it is enabled while asynchronous selection is in
        // flight; the ready record stays durable for the post-maintenance tick.
        await this.advancePrivatePreparationGate(Date.now());
      }
    } catch (error) {
      this.onDeckPreparation = null;
      this.onDeckPreparationPairKey = null;
      await this.reconcilePersistedStreamingDuelParticipation([
        pair.agent1Id,
        pair.agent2Id,
      ]);
      Logger.error(
        "StreamingDuelScheduler",
        `Failed to persist private preparation: ${errMsg(error)}`,
      );
      this.world.emit("duel:preparation:failed", {
        agent1Id: pair.agent1Id,
        agent2Id: pair.agent2Id,
        reason: "preparation_persistence_failed",
      });
    }
  }

  private async emitOnDeckPreparationSelected(
    preparation: DuelPreparationSnapshot,
  ): Promise<DuelPreparationSnapshot> {
    // Standalone sparbots are explicit diagnostic contestants with no durable
    // economy to plan against. They still pass the same prayer/loadout
    // validation and persisted readiness transition, but do so before the
    // selection event so AgentManager observes an already-ready snapshot and
    // never pretends to bank assets the diagnostic contestant does not own.
    let announced = preparation;
    for (const agentId of [preparation.agent1Id, preparation.agent2Id]) {
      if (!this.standaloneSparbotIds.has(agentId)) continue;
      if (!this.preparationStore || !this.preparationHostLeaseConfig) {
        throw new Error("diagnostic_contestant_host_lease_unavailable");
      }
      const hostLeaseInput = {
        preparationId: preparation.preparationId,
        agentId,
        ownerId: this.preparationDiagnosticHostOwnerId,
        leaseDurationMs: this.preparationHostLeaseConfig.leaseMs,
      };
      const claimedHostLease =
        await this.preparationStore.claimContestantHostLease(hostLeaseInput);
      const activeHostLease = claimedHostLease
        ? await this.preparationStore.heartbeatContestantHostLease(
            hostLeaseInput,
          )
        : null;
      if (!activeHostLease) {
        throw new Error("diagnostic_contestant_host_lease_rejected");
      }
      const readiness = this.orchestrator.inspectCompetitiveLoadout(agentId);
      if (!readiness.ok) continue;
      await this.confirmOnDeckPreparation(
        preparation.preparationId,
        agentId,
        false,
        {
          primaryStyle: readiness.initialCombatRole,
          availableStyles: [...readiness.availableCombatStyles],
          planningSource: "diagnostic",
          planningPolicyVersion: "diagnostic-v1",
          agentPolicyFingerprint: null,
          modelProvider: "diagnostic",
          model: "diagnostic",
          tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy(
            readiness.initialCombatRole,
          ),
        },
      );
      const current = this.onDeckPreparation;
      if (!current || current.preparationId !== preparation.preparationId) {
        return announced;
      }
      announced = current;
    }

    const agent1Entity = this.world.entities.get(announced.agent1Id);
    const agent2Entity = this.world.entities.get(announced.agent2Id);
    this.camera.clearIdlePreparationActivityCut();
    await this.hydratePublicPreparationActivities(announced);
    const payload = {
      preparationId: announced.preparationId,
      selectedAt: announced.selectedAt,
      expiresAt: announced.expiresAt,
      agent1Id: announced.agent1Id,
      agent1Name: (agent1Entity?.data as { name?: string })?.name ?? "Unknown",
      agent1Ready: announced.agent1ReadyAt !== null,
      agent1OpponentHistory: this.matchmaking.getOpponentHistory(
        announced.agent1Id,
        announced.agent2Id,
      ),
      agent2Id: announced.agent2Id,
      agent2Name: (agent2Entity?.data as { name?: string })?.name ?? "Unknown",
      agent2Ready: announced.agent2ReadyAt !== null,
      agent2OpponentHistory: this.matchmaking.getOpponentHistory(
        announced.agent2Id,
        announced.agent1Id,
      ),
    };
    this.world.emit("duel:preparation:selected", payload);
    this.world.emit("duel:on-deck", payload);
    return announced;
  }

  private async cancelOnDeckPreparation(reason: string): Promise<void> {
    const store = this.preparationStore;
    const fencingToken = this.preparationFencingToken;
    const preparation = this.onDeckPreparation;
    if (preparation) {
      // Detach the exact preparation being cancelled before awaiting an older
      // selection. A replacement pair may be selected while that promise
      // unwinds and must never be mistaken for the stale session.
      this.onDeckPreparation = null;
      this.onDeckPreparationPairKey = null;
      this.clearPublicPreparationActivities(preparation.preparationId);
      // Durable cancellation can lose a fencing-token race to a successor or
      // be temporarily unavailable during authority loss. Revoke the old
      // process's private-bank capability synchronously without publishing a
      // durable/public terminal transition that PostgreSQL has not confirmed.
      this.world.emit(DUEL_PREPARATION_LOCAL_REVOCATION_EVENT, {
        preparationId: preparation.preparationId,
        reason,
        occurredAt: Date.now(),
      });
    }
    ++this.preparationSelectionGeneration;
    const selectionInFlight = this.preparationSelectionInFlight;
    if (selectionInFlight) {
      await selectionInFlight.catch(() => undefined);
    }
    if (!preparation || !store || !fencingToken) return;
    try {
      const cancelled = await store.cancel({
        preparationId: preparation.preparationId,
        fencingToken,
        reason,
      });
      if (cancelled?.status === "cancelled") {
        this.world.emit("duel:preparation:cancelled", {
          preparationId: cancelled.preparationId,
          reason: cancelled.cancellationReason,
          occurredAt: cancelled.cancelledAt,
        });
      }
    } catch (error) {
      Logger.error(
        "StreamingDuelScheduler",
        `Failed to cancel private preparation: ${errMsg(error)}`,
      );
    }
  }

  /**
   * Cancel a still-private selection when one contestant is authoritatively
   * unavailable. Keeping the registration lets ordinary respawn restore
   * future eligibility; clearing this exact pair prevents a dead contestant
   * from reaching loadout freeze or retaining its preparation bank capability.
   */
  private cancelUnavailableOnDeckContestant(agentId: string): boolean {
    const preparation = this.onDeckPreparation;
    if (
      !preparation ||
      (preparation.agent1Id !== agentId && preparation.agent2Id !== agentId) ||
      this.getContestantRuntimeStatus(agentId) === "alive"
    ) {
      return false;
    }

    const pair = this.matchmaking.nextDuelPair;
    if (pair && (pair.agent1Id === agentId || pair.agent2Id === agentId)) {
      this.matchmaking.nextDuelPair = null;
    }
    void this.cancelOnDeckPreparation("contestant_unavailable");
    return true;
  }

  private async handleOnDeckPreparationAgentFailure(
    preparationId: string,
    agentId: string,
  ): Promise<void> {
    const preparation = this.onDeckPreparation;
    if (
      !preparation ||
      preparation.preparationId !== preparationId ||
      (preparation.agent1Id !== agentId && preparation.agent2Id !== agentId)
    ) {
      return;
    }

    const pair = this.matchmaking.nextDuelPair;
    if (
      pair &&
      ((pair.agent1Id === preparation.agent1Id &&
        pair.agent2Id === preparation.agent2Id) ||
        (pair.agent1Id === preparation.agent2Id &&
          pair.agent2Id === preparation.agent1Id))
    ) {
      this.matchmaking.nextDuelPair = null;
    }
    this.matchmaking.deferAgentAfterPreparationFailure(
      agentId,
      Date.now() + Math.max(0, preparation.expiresAt - preparation.selectedAt),
    );
    this.world.emit("duel:preparation:failed", {
      preparationId,
      agent1Id: preparation.agent1Id,
      agent2Id: preparation.agent2Id,
      failedAgentId: agentId,
      reason: "agent_preparation_failed",
    });
    await this.cancelOnDeckPreparation("agent_preparation_failed");
  }

  /**
   * Consume a report written by a contestant host that cannot emit into this
   * process. The scheduler retains sole cancellation authority and therefore
   * applies its own current fencing token after validating the durable pair.
   */
  private async consumeReportedContestantUnavailability(
    preparation: DuelPreparationSnapshot,
  ): Promise<boolean> {
    const store = this.preparationStore;
    if (!store) return false;
    const reportExpiredContestantHostLease = (
      store as PostgresDuelPreparationStore & {
        reportExpiredContestantHostLease?: PostgresDuelPreparationStore["reportExpiredContestantHostLease"];
      }
    ).reportExpiredContestantHostLease;
    const expiredLeaseReport =
      this.preparationHostLeaseConfig &&
      typeof reportExpiredContestantHostLease === "function"
        ? await reportExpiredContestantHostLease.call(store, {
            preparationId: preparation.preparationId,
            claimGraceMs: this.preparationHostLeaseConfig.claimGraceMs,
          })
        : null;
    const report =
      expiredLeaseReport ??
      (await store.getContestantUnavailability(preparation.preparationId));
    if (!report) return false;
    if (
      report.agentId !== preparation.agent1Id &&
      report.agentId !== preparation.agent2Id
    ) {
      throw new Error("duel_preparation_unavailability_agent_mismatch");
    }

    this.onDeckPreparation = preparation;
    this.onDeckPreparationPairKey = `${preparation.agent1Id}\u0000${preparation.agent2Id}`;
    await this.handleOnDeckPreparationAgentFailure(
      preparation.preparationId,
      report.agentId,
    );
    return true;
  }

  private async confirmOnDeckPreparation(
    preparationId: string,
    agentId: string,
    emitReadinessEvent = true,
    planEvidence?: CompetitivePreparationEvidence,
  ): Promise<void> {
    const store = this.preparationStore;
    const fencingToken = this.preparationFencingToken;
    const current = this.onDeckPreparation;
    if (
      !store ||
      !fencingToken ||
      !current ||
      current.preparationId !== preparationId ||
      (current.agent1Id !== agentId && current.agent2Id !== agentId)
    ) {
      this.world.emit("duel:preparation:readiness_rejected", {
        preparationId,
        agentId,
        reason: "stale_or_unauthorized_preparation",
      });
      return;
    }
    const prayerReadiness =
      await this.orchestrator.preparePrayerForCompetitiveFreeze(agentId);
    if (!prayerReadiness.ok) {
      this.world.emit("duel:preparation:readiness_rejected", {
        preparationId,
        agentId,
        reason: prayerReadiness.reason,
      });
      return;
    }
    const loadoutReadiness =
      this.orchestrator.inspectCompetitiveLoadout(agentId);
    if (!loadoutReadiness.ok) {
      this.world.emit("duel:preparation:readiness_rejected", {
        preparationId,
        agentId,
        reason: loadoutReadiness.reason,
      });
      return;
    }
    if (!planEvidence) {
      this.world.emit("duel:preparation:readiness_rejected", {
        preparationId,
        agentId,
        reason: "preparation_plan_evidence_missing",
      });
      return;
    }
    for (let conflictAttempt = 0; ; conflictAttempt += 1) {
      try {
        const updated = await store.markReady({
          preparationId,
          fencingToken,
          agentId,
          planEvidence,
        });
        if (!updated) {
          this.world.emit("duel:preparation:readiness_rejected", {
            preparationId,
            agentId,
            reason: "preparation_not_mutable",
          });
          return;
        }
        const latest = this.onDeckPreparation;
        if (!latest || latest.preparationId !== preparationId) return;
        const authoritative =
          latest.version > updated.version ? latest : updated;
        this.onDeckPreparation = authoritative;
        if (!emitReadinessEvent) return;
        this.world.emit("duel:preparation:readiness", {
          preparationId,
          agentId,
          agent1Ready: authoritative.agent1ReadyAt !== null,
          agent2Ready: authoritative.agent2ReadyAt !== null,
          bothReady: authoritative.status === "ready",
          expiresAt: authoritative.expiresAt,
        });
        return;
      } catch (error) {
        if (
          isRetryablePostgresTransactionConflict(error) &&
          conflictAttempt < PRIVATE_PREPARATION_CONFLICT_RETRIES
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, 10 * (conflictAttempt + 1)),
          );
          const retryCurrent = this.onDeckPreparation;
          if (
            this.isDestroyed ||
            this.preparationStore !== store ||
            this.preparationFencingToken !== fencingToken ||
            !retryCurrent ||
            retryCurrent.preparationId !== preparationId ||
            (retryCurrent.agent1Id !== agentId &&
              retryCurrent.agent2Id !== agentId)
          ) {
            this.world.emit("duel:preparation:readiness_rejected", {
              preparationId,
              agentId,
              reason: "stale_or_unauthorized_preparation",
            });
            return;
          }
          continue;
        }
        Logger.error(
          "StreamingDuelScheduler",
          `Failed to persist preparation readiness: ${errMsg(error)}`,
        );
        this.world.emit("duel:preparation:readiness_rejected", {
          preparationId,
          agentId,
          reason: "preparation_persistence_failed",
        });
        return;
      }
    }
  }

  private async advancePrivatePreparationGate(
    now: number,
    conflictAttempt = 0,
  ): Promise<void> {
    if (this.preparationIdleCheckInFlight) return;
    const store = this.preparationStore;
    const fencingToken = this.preparationFencingToken;
    if (!store || !fencingToken) return;
    this.preparationIdleCheckInFlight = true;
    let retryConflict = false;
    try {
      if (!this.competitiveRecoveryChecked) {
        const recovered = await this.recoverFrozenCompetitiveSnapshot(now);
        if (recovered === "deferred") return;
        if (recovered === "handled") return;
        this.competitiveRecoveryChecked = true;
      }
      const expired = await store.expire();
      if (
        this.onDeckPreparation &&
        expired.some(
          (entry) =>
            entry.preparationId === this.onDeckPreparation?.preparationId,
        )
      ) {
        const expiredId = this.onDeckPreparation.preparationId;
        this.onDeckPreparation = null;
        this.onDeckPreparationPairKey = null;
        this.clearPublicPreparationActivities(expiredId);
        this.matchmaking.nextDuelPair = null;
        this.world.emit("duel:preparation:expired", {
          preparationId: expiredId,
          occurredAt: now,
        });
      }

      const locallyKnownPreparationId =
        this.onDeckPreparation?.preparationId ?? null;
      let active = this.onDeckPreparation ?? (await store.getActive());
      if (
        active &&
        (active.status === "preparing" || active.status === "ready") &&
        (await this.consumeReportedContestantUnavailability(active))
      ) {
        return;
      }

      let pair = this.matchmaking.nextDuelPair;
      if (!pair) {
        this.matchmaking.refreshNextDuelPair(now);
        pair = this.matchmaking.nextDuelPair;
      }
      if (!pair) return;
      await this.matchmaking.waitForAgentStatsHydration([
        pair.agent1Id,
        pair.agent2Id,
      ]);

      const activeMatchesPair =
        active &&
        ((active.agent1Id === pair.agent1Id &&
          active.agent2Id === pair.agent2Id) ||
          (active.agent1Id === pair.agent2Id &&
            active.agent2Id === pair.agent1Id));
      if (
        !active ||
        active.fencingToken !== fencingToken ||
        !activeMatchesPair
      ) {
        // Preparation delivery is intentionally background work. Awaiting it
        // here can permanently occupy the reconciliation singleflight if an
        // agent callback stalls during a database outage, preventing the gate
        // from observing a durable ready/expired row on subsequent ticks.
        void this.beginOnDeckPreparation(pair);
        return;
      }
      if (
        active.agent1Id !== pair.agent1Id ||
        active.agent2Id !== pair.agent2Id
      ) {
        // Matchmaking side order is not durable. Preserve the already-locked
        // preparation orientation instead of cancelling it, reopening banks,
        // and manufacturing a second selection for the same two contestants.
        pair = {
          agent1Id: active.agent1Id,
          agent2Id: active.agent2Id,
          selectedAt: active.selectedAt,
        };
        this.matchmaking.nextDuelPair = pair;
      }
      this.onDeckPreparation = active;
      this.onDeckPreparationPairKey = `${pair.agent1Id}\u0000${pair.agent2Id}`;
      if (
        locallyKnownPreparationId !== active.preparationId &&
        (active.status === "preparing" || active.status === "ready")
      ) {
        // A scheduler/process restart loses only in-memory delivery state. The
        // durable session remains authoritative, so re-announce it once. A
        // ready session still needs this synchronous delivery edge to fence
        // ordinary autonomy before competitive freeze starts.
        active = await this.emitOnDeckPreparationSelected(active);
      }
      if (active.status !== "ready") return;

      // A direct reconciliation can overlap an operator maintenance change
      // even though the ordinary idle path checks maintenance before entering
      // this method. Keep the durable ready record and private/public state
      // intact so release resumes the exact same preparation instead of
      // launching through the deployment fence or manufacturing a new one.
      if (config.isMaintenanceMode()) return;

      // Retain the exact completed preparation (and its pair-bound camera and
      // activity trail) for the full optional presentation floor measured from
      // the later readiness receipt. Measuring from selection lets slow
      // planning consume the entire public ready hold. The release remains
      // capped by the private deadline, which expires fail-closed on the next
      // reconciliation instead of extending or inventing product timing.
      if (
        now <
        resolveStreamingPublicPreparationReleaseAt(
          active,
          this.publicPreparationMinimumDurationMs,
        )
      ) {
        return;
      }

      this.onDeckPreparation = null;
      this.onDeckPreparationPairKey = null;
      this.clearPublicPreparationActivities(active.preparationId);
      this.matchmaking.nextDuelPair = null;
      const launched = await this.startNewCycle(pair, active);
      if (!launched) {
        const cancelled = await store.cancel({
          preparationId: active.preparationId,
          fencingToken,
          reason: "launch_preflight_failed",
        });
        if (cancelled) {
          this.world.emit("duel:preparation:cancelled", {
            preparationId: cancelled.preparationId,
            reason: cancelled.cancellationReason,
            occurredAt: cancelled.cancelledAt,
          });
        }
        this.matchmaking.refreshNextDuelPair(Date.now());
        return;
      }
    } catch (error) {
      if (
        isRetryablePostgresTransactionConflict(error) &&
        conflictAttempt < PRIVATE_PREPARATION_CONFLICT_RETRIES
      ) {
        retryConflict = true;
      } else {
        Logger.error(
          "StreamingDuelScheduler",
          `Private preparation gate failed closed: ${errMsg(error)}`,
        );
      }
    } finally {
      this.preparationIdleCheckInFlight = false;
    }
    if (retryConflict) {
      await new Promise((resolve) =>
        setTimeout(resolve, 10 * (conflictAttempt + 1)),
      );
      await this.advancePrivatePreparationGate(Date.now(), conflictAttempt + 1);
    }
  }

  // ============================================================================
  // Phase Handlers
  // ============================================================================

  private getContestantRuntimeStatus(
    characterId: string,
  ): "alive" | "dead" | "missing" | "invalid" {
    const entity = this.world.entities.get(characterId);
    if (!entity) return "missing";

    const health = Number((entity.data as { health?: number }).health);
    if (!Number.isFinite(health)) return "invalid";
    return health > 0 ? "alive" : "dead";
  }

  /**
   * Redundant lifecycle fence for lost or delayed leave/death events. Returns
   * true after beginning a terminal path so combat cannot start or continue
   * with an unavailable contestant.
   */
  private resolveUnavailableActiveContestants(): boolean {
    const cycle = this.currentCycle;
    if (
      !cycle?.agent1 ||
      !cycle.agent2 ||
      (cycle.phase !== "COUNTDOWN" && cycle.phase !== "FIGHTING")
    ) {
      return false;
    }

    const status1 = this.getContestantRuntimeStatus(cycle.agent1.characterId);
    const status2 = this.getContestantRuntimeStatus(cycle.agent2.characterId);

    if (status1 === "invalid" || status2 === "invalid") {
      this.abortCycleToIdle("contestant_health_invalid");
      return true;
    }
    if (status1 === "alive" && status2 === "alive") return false;

    if (status1 !== "alive" && status2 !== "alive") {
      if (status1 === "dead" && status2 === "dead") {
        this.resolveAuthoritativeEntityDeath(
          cycle.cycleId,
          cycle.agent1.characterId,
        );
      } else {
        this.abortCycleToIdle("both_agents_missing");
      }
      return true;
    }

    const unavailable =
      status1 === "alive"
        ? { contestant: cycle.agent2, status: status2 }
        : { contestant: cycle.agent1, status: status1 };
    const survivor = status1 === "alive" ? cycle.agent1 : cycle.agent2;

    if (unavailable.status === "missing") {
      this.orchestrator.startResolution(
        survivor.characterId,
        unavailable.contestant.characterId,
        "forfeit",
      );
    } else {
      this.resolveAuthoritativeEntityDeath(
        cycle.cycleId,
        unavailable.contestant.characterId,
      );
    }
    return true;
  }

  private tickAnnouncement(now: number): void {
    if (!this.currentCycle) return;

    const elapsed = now - this.currentCycle.phaseStartTime;

    // Check if announcement phase is over
    if (elapsed >= STREAMING_TIMING.ANNOUNCEMENT_DURATION) {
      void this.startCountdown();
      return;
    }

    // The announcement never early-exits: phase clock, public countdown,
    // betting close, keeper lock, and oracle timing share one immutable edge.
  }

  private async startCountdown(): Promise<void> {
    if (
      !this.currentCycle ||
      !this.currentCycle.agent1 ||
      !this.currentCycle.agent2
    ) {
      return;
    }

    // Guard against re-entry if phase already changed.
    if (this.currentCycle.phase !== "ANNOUNCEMENT") {
      return;
    }

    // Prevent concurrent invocations from overlapping ticks (Fix A).
    if (this._startCountdownInProgress) return;
    this._startCountdownInProgress = true;
    try {
      Logger.info(
        "StreamingDuelScheduler",
        "Preparing contestants for countdown",
      );

      const competitiveSnapshot = this.currentCycle.competitiveSnapshot;
      if (!competitiveSnapshot) {
        this.abortCycleToIdle("competitive_agent_policy_unavailable");
        return;
      }
      const policyValidation =
        await this.orchestrator.validateCompetitiveAgentPolicies({
          cycleId: this.currentCycle.cycleId,
          diagnostic: competitiveSnapshot.diagnostic,
          contestants: competitiveSnapshot.contestants,
        });
      if (!policyValidation.ok) {
        this.abortCycleToIdle(policyValidation.reason);
        return;
      }
      if (!this.currentCycle || this.currentCycle.phase !== "ANNOUNCEMENT") {
        return;
      }

      // Duel flags are already set at ANNOUNCEMENT start (startNewCycle), but
      // re-apply as a safety net in case they were cleared by recovery logic.
      this.orchestrator.setDuelFlags(true);

      // Prepare contestants (fill food, restore HP) but NOT teleport yet.
      // Fix J — timeout wrapper so prep can't block forever.
      const PREP_TIMEOUT_MS = Math.max(
        5_000,
        Number.parseInt(process.env.STREAMING_PREP_TIMEOUT_MS || "30000", 10) ||
          30_000,
      );
      try {
        await Promise.race([
          this.orchestrator.prepareContestantsForDuel(),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error("Prep timed out")),
              PREP_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Contestant prep failed: ${errMsg(err)}`,
        );
        this.abortCycleToIdle("contestant_prep_failed");
        return;
      }

      // Scheduler may have advanced/ended while awaiting prep.
      if (!this.currentCycle || this.currentCycle.phase !== "ANNOUNCEMENT") {
        return;
      }

      // Re-validate both agents after async prep. ANNOUNCEMENT is pre-lock and
      // cannot publish a sporting result, so any loss cancels as a no-contest.
      const postPrepStatus1 = this.getContestantRuntimeStatus(
        this.currentCycle.agent1.characterId,
      );
      const postPrepStatus2 = this.getContestantRuntimeStatus(
        this.currentCycle.agent2.characterId,
      );

      if (postPrepStatus1 === "invalid" || postPrepStatus2 === "invalid") {
        this.abortCycleToIdle("contestant_health_invalid");
        return;
      }
      if (postPrepStatus1 !== "alive" && postPrepStatus2 !== "alive") {
        this.abortCycleToIdle("both_agents_lost_during_prep");
        return;
      }
      if (postPrepStatus1 !== "alive" || postPrepStatus2 !== "alive") {
        this.abortCycleToIdle("contestant_unavailable");
        return;
      }

      // Teleport agents to arena NOW — right as countdown begins.
      try {
        this.orchestrator.teleportToArena(
          this.currentCycle.agent1.characterId,
          this.currentCycle.agent2.characterId,
        );
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `Failed to teleport contestants into arena: ${errMsg(err)}`,
        );
        this.abortCycleToIdle("arena_teleport_failed");
        return;
      }

      if (!this.currentCycle || this.currentCycle.phase !== "ANNOUNCEMENT") {
        return;
      }

      // Ensure stale pathing state does not pull contestants away after teleport.
      this.world.emit("player:movement:cancel", {
        playerId: this.currentCycle.agent1.characterId,
      });
      this.world.emit("player:movement:cancel", {
        playerId: this.currentCycle.agent2.characterId,
      });

      // The immutable betting close must be durable before any COUNTDOWN
      // surface or duel-session signal can imply that the market is locked.
      const cycleAtLock = this.currentCycle;
      const lockedAt = cycleAtLock.betCloseTime;
      if (!Number.isSafeInteger(lockedAt) || lockedAt === null) {
        this.abortCycleToIdle("competitive_lifecycle_persistence_failed");
        return;
      }
      const locked = await this.persistCompetitiveLifecycleMilestone(
        cycleAtLock,
        "locked",
        lockedAt,
      );
      if (!locked) {
        this.abortCycleToIdle("competitive_lifecycle_persistence_failed");
        return;
      }
      if (
        !this.currentCycle ||
        this.currentCycle.cycleId !== cycleAtLock.cycleId ||
        this.currentCycle.phase !== "ANNOUNCEMENT"
      ) {
        return;
      }

      // Notify agent plugins that a duel session is starting so they enter duel mode
      // (pause autonomous behavior, save goals, stop movement).
      const streamingDuelId = `streaming-${this.currentCycle.cycleId}`;
      this.world.emit(EventType.DUEL_SESSION_CREATED, {
        duelId: streamingDuelId,
        challengerId: this.currentCycle.agent1.characterId,
        challengerName: this.currentCycle.agent1.name,
        targetId: this.currentCycle.agent2.characterId,
        targetName: this.currentCycle.agent2.name,
      });

      // Transition to COUNTDOWN without moving the fight boundary that was
      // published with the announcement and committed by the keeper. Any
      // preparation delay consumes countdown time instead of silently
      // extending a market contract after positions can exist.
      const now = Date.now();
      const fightStartTime = this.currentCycle.fightStartTime;
      if (
        !Number.isSafeInteger(fightStartTime) ||
        fightStartTime === null ||
        fightStartTime < lockedAt
      ) {
        this.abortCycleToIdle("competitive_timing_contract_invalid");
        return;
      }
      const countdownDelay = Math.max(0, fightStartTime - now);

      this.phaseStateMachine.transition("COUNTDOWN");
      this.currentCycle.phase = "COUNTDOWN";
      this.currentCycle.phaseStartTime = now;
      this.currentCycle.phaseVersion += 1;
      this.currentCycle.countdownValue = null;
      this.camera.setCameraTarget(
        this.currentCycle.agent1?.characterId ?? null,
        now,
      );

      Logger.info("StreamingDuelScheduler", "Starting countdown");

      // Force immediate broadcast so clients see COUNTDOWN state.
      this.broadcastState();

      // Schedule startFight after the countdown duration.
      if (this.countdownTimeout) {
        clearTimeout(this.countdownTimeout);
      }
      this.countdownTimeout = setTimeout(() => {
        this.countdownTimeout = null;
        void this.doStartFight(fightStartTime);
      }, countdownDelay);
    } finally {
      this._startCountdownInProgress = false;
    }
  }

  /**
   * Wrapper that calls orchestrator.startFight() and handles facade-owned
   * camera logic around the fight start transition.
   */
  private async doStartFight(now: number): Promise<void> {
    if (!this.currentCycle || this.currentCycle.phase !== "COUNTDOWN") {
      return;
    }

    const competitiveSnapshot = this.currentCycle.competitiveSnapshot;
    if (!competitiveSnapshot) {
      this.abortCycleToIdle("competitive_agent_policy_unavailable");
      return;
    }
    const policyValidation =
      await this.orchestrator.validateCompetitiveAgentPolicies({
        cycleId: this.currentCycle.cycleId,
        diagnostic: competitiveSnapshot.diagnostic,
        contestants: competitiveSnapshot.contestants,
      });
    if (!policyValidation.ok) {
      this.abortCycleToIdle(policyValidation.reason);
      return;
    }
    if (!this.currentCycle || this.currentCycle.phase !== "COUNTDOWN") {
      return;
    }

    // Do not durably claim combat started if a leave/death event was lost
    // during countdown. Reconcile from the authoritative entities first.
    if (this.resolveUnavailableActiveContestants()) return;

    const cycleAtFightStart = this.currentCycle;
    const duelStartedAt = cycleAtFightStart.fightStartTime;
    if (!Number.isSafeInteger(duelStartedAt) || duelStartedAt === null) {
      this.abortCycleToIdle("competitive_timing_contract_invalid");
      return;
    }
    const duelStarted = await this.persistCompetitiveLifecycleMilestone(
      cycleAtFightStart,
      "duel",
      duelStartedAt,
    );
    if (!duelStarted) {
      this.abortCycleToIdle("competitive_lifecycle_persistence_failed");
      return;
    }
    if (
      !this.currentCycle ||
      this.currentCycle.cycleId !== cycleAtFightStart.cycleId ||
      this.currentCycle.phase !== "COUNTDOWN"
    ) {
      return;
    }

    // Reset camera cutaway tracking for the new fight phase.
    this.camera.resetFightCutawayTracking();

    // Delegate fight start to orchestrator (handles phase transition, duel flags,
    // health restore, emit, combat initiation, combat AIs).
    // Keep the pre-published start boundary immutable across persistence,
    // combat authority, the public phase clock, and the keeper/on-chain feed.
    // A slow persistence edge may consume part of the round, but it must never
    // silently move the deadline after bettors have seen the timing contract.
    this.orchestrator.startFight(duelStartedAt);

    // If the orchestrator transitioned to FIGHTING, set camera target and start fast broadcast.
    // Re-read cycle since startFight() mutates phase via setCurrentCycleFields.
    const cycleAfterFight = this.currentCycle;
    if (
      cycleAfterFight &&
      (cycleAfterFight.phase as StreamingPhase) === "FIGHTING"
    ) {
      this.camera.setCameraTarget(
        cycleAfterFight.agent1?.characterId ?? null,
        duelStartedAt,
      );
      // Start fast 200ms broadcast for fight phase (#11)
      this.startFightBroadcast();
    }
  }

  private tickFighting(now: number): void {
    if (!this.currentCycle) return;

    // Refresh HP before the lifecycle fence so a missed terminal damage event
    // resolves from authoritative state rather than producing a false timeout.
    this.orchestrator.updateContestantHp();
    if (this.hasPendingDamageForCurrentCycle()) return;
    if (this.resolveUnavailableActiveContestants()) return;

    const elapsed = now - this.currentCycle.phaseStartTime;
    const totalFightDuration =
      STREAMING_TIMING.FIGHTING_DURATION +
      STREAMING_TIMING.END_WARNING_DURATION;

    // Check for end warning
    if (
      elapsed >= STREAMING_TIMING.FIGHTING_DURATION &&
      elapsed < totalFightDuration
    ) {
      // In end warning phase
      const remaining = totalFightDuration - elapsed;
      if (remaining <= 30000 && remaining > 29000) {
        this.world.emit("streaming:fight:end_warning", {
          cycleId: this.currentCycle.cycleId,
          secondsRemaining: Math.ceil(remaining / 1000),
        });
      }
    }

    // Check if fight time is up
    if (elapsed >= totalFightDuration) {
      const committedFightDeadline =
        this.currentCycle.competitiveSnapshot?.timing?.fightDeadline ??
        this.currentCycle.phaseStartTime + totalFightDuration;
      this.orchestrator.endFightByTimeout(committedFightDeadline);
    }
  }

  private tickResolution(now: number): void {
    if (!this.currentCycle) return;

    const elapsed = now - this.currentCycle.phaseStartTime;

    // Check if resolution phase is over
    if (elapsed >= STREAMING_TIMING.RESOLUTION_DURATION) {
      this.endCycle();
    }
  }

  // ============================================================================
  // Resolution Handling (callback from DuelOrchestrator)
  // ============================================================================

  private buildOracleProof(
    cycle: StreamingDuelCycle,
    winnerId: string | null,
    loserId: string | null,
    winReason: StreamingDuelWinReason,
    finishedAt: number,
  ): { seed: string; replayHash: string } {
    const duelId = cycle.duelId ?? `streaming-${cycle.cycleId}`;
    const fightStartedAt = cycle.fightStartTime ?? cycle.cycleStartTime;
    return buildCompetitiveTerminalProof({
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
    });
  }

  /**
   * Handle resolution when DuelOrchestrator calls onResolution.
   * This is the facade's responsibility: phase transition, stats, recording, camera.
   */
  private handleResolution(
    winnerId: string | null,
    loserId: string | null,
    winReason: StreamingDuelWinReason,
    terminalState?: {
      terminalAt: number;
      seed: string;
      replayHash: string;
      persisted: boolean;
    },
    terminalAtOverride?: number,
  ): void {
    if (!this.currentCycle) return;

    // Idempotency guard — only transition from FIGHTING or COUNTDOWN (Fix C).
    if (
      this.currentCycle.phase !== "FIGHTING" &&
      this.currentCycle.phase !== "COUNTDOWN"
    ) {
      return;
    }

    if (this.hasPendingDamageForCurrentCycle()) {
      const deferred: DamageFencedResolution = {
        cycleId: this.currentCycle.cycleId,
        winnerId,
        loserId,
        winReason,
        ...(terminalAtOverride !== undefined ? { terminalAtOverride } : {}),
        // A non-persisted proof was derived before every already-started hit
        // settled and is therefore stale by construction. Only the terminal
        // identity co-committed by the damage authority may cross this fence.
        ...(terminalState?.persisted ? { terminalState } : {}),
      };
      const existing = this.damageFencedResolution;
      if (
        existing &&
        (existing.cycleId !== deferred.cycleId ||
          existing.winnerId !== deferred.winnerId ||
          existing.loserId !== deferred.loserId ||
          existing.winReason !== deferred.winReason ||
          existing.terminalAtOverride !== deferred.terminalAtOverride)
      ) {
        Logger.error(
          "StreamingDuelScheduler",
          "Conflicting resolution arrived while exact damage commits were pending",
        );
        return;
      }
      if (
        existing?.terminalState?.persisted &&
        deferred.terminalState?.persisted &&
        JSON.stringify(existing.terminalState) !==
          JSON.stringify(deferred.terminalState)
      ) {
        Logger.error(
          "StreamingDuelScheduler",
          "Conflicting persisted terminal receipts arrived while exact damage commits were pending",
        );
        return;
      }
      // ENTITY_DEATH is emitted before COMBAT_DAMAGE_DEALT. When the death
      // microtask reaches us first it contributes the sporting result only;
      // the later atomic damage receipt upgrades that deferred result with the
      // exact already-persisted seed/replay identity. The reverse event order
      // retains the same receipt instead of downgrading it to a fresh proof.
      this.damageFencedResolution = deferred.terminalState
        ? deferred
        : (existing ?? deferred);
      return;
    }
    if (this.damageFencedResolution?.cycleId === this.currentCycle.cycleId) {
      this.damageFencedResolution = null;
    }

    // Stop fast fight broadcast (#11)
    this.stopFightBroadcast();

    // Clear countdown timeout if still pending (e.g. forfeit during countdown).
    if (this.countdownTimeout) {
      clearTimeout(this.countdownTimeout);
      this.countdownTimeout = null;
    }

    const isDraw = winReason === "draw";
    if (isDraw) {
      winnerId = null;
      loserId = null;
    } else if (!winnerId || !loserId || winnerId === loserId) {
      this.abortCycleToIdle("invalid_resolution_participants");
      return;
    }

    const proposedTerminal =
      terminalState ??
      (() => {
        const terminalAt = terminalAtOverride ?? Date.now();
        const proof = this.buildOracleProof(
          this.currentCycle!,
          winnerId,
          loserId,
          winReason,
          terminalAt,
        );
        return { terminalAt, ...proof, persisted: false };
      })();
    if (
      !proposedTerminal.persisted &&
      this.currentCycle.competitiveSnapshot?.persisted
    ) {
      if (this.pendingTerminalTransition) return;
      const cycle = this.currentCycle;
      let transition!: Promise<void>;
      transition = this.persistCompetitiveTerminal(cycle, {
        outcome: isDraw ? "draw" : "win",
        winnerId,
        winReason,
        cancellationReason: isDraw ? "draw" : null,
        seed: proposedTerminal.seed,
        replayHash: proposedTerminal.replayHash,
        terminalAt: proposedTerminal.terminalAt,
      })
        .then((persisted) => {
          if (!persisted) {
            throw new Error("competitive_terminal_persistence_rejected");
          }
          if (this.currentCycle?.cycleId === cycle.cycleId) {
            this.handleResolution(winnerId, loserId, winReason, {
              ...proposedTerminal,
              persisted: true,
            });
          }
        })
        .catch((error) => {
          Logger.error(
            "StreamingDuelScheduler",
            `Terminal result persistence failed closed: ${errMsg(error)}`,
          );
          if (this.isDestroyed) throw error;
          if (this.currentCycle?.cycleId === cycle.cycleId) {
            setTimeout(
              () =>
                this.handleResolution(
                  winnerId,
                  loserId,
                  winReason,
                  proposedTerminal,
                ),
              1_000,
            );
          }
        })
        .finally(() => {
          if (this.pendingTerminalTransition === transition) {
            this.pendingTerminalTransition = null;
          }
        });
      this.pendingTerminalTransition = transition;
      const previousCleanup = this.pendingCycleCleanup;
      this.pendingCycleCleanup = Promise.all([
        previousCleanup,
        transition,
      ]).then(() => undefined);
      return;
    }

    const now = proposedTerminal.terminalAt;
    const oracleProof = {
      seed: proposedTerminal.seed,
      replayHash: proposedTerminal.replayHash,
    };

    this.phaseStateMachine.transition("RESOLUTION");
    this.currentCycle.phase = "RESOLUTION";
    this.currentCycle.phaseStartTime = now;
    this.currentCycle.phaseVersion += 1;
    this.currentCycle.duelEndTime = now;
    this.currentCycle.winnerId = winnerId;
    this.currentCycle.loserId = loserId;
    this.currentCycle.outcome = isDraw ? "draw" : "win";
    this.currentCycle.winReason = winReason;
    this.currentCycle.seed = oracleProof.seed;
    this.currentCycle.replayHash = oracleProof.replayHash;
    this.durableBettingTerminal = {
      cycle: this.currentCycle,
      terminal: isDraw
        ? {
            outcome: "draw",
            cancellationReason: "draw",
            duelEndTime: now,
          }
        : null,
    };

    // Update stats — draws don't affect win/loss/streaks (#24)
    const agent1 = this.currentCycle.agent1;
    const agent2 = this.currentCycle.agent2;
    if (isDraw) {
      if (agent1 && agent2) {
        this.matchmaking.updateDrawStats(
          agent1.characterId,
          agent2.characterId,
          {
            // The durable terminal transaction already applied this outcome.
            // Keep the post-commit scheduler edge memory-only.
            persistToDatabase:
              !this.currentCycle.competitiveSnapshot?.persisted,
          },
        );
      }
    } else {
      this.matchmaking.updateStats(winnerId!, loserId!, {
        persistToDatabase: !this.currentCycle.competitiveSnapshot?.persisted,
      });
    }

    // Get winner/loser names
    const winnerName = winnerId
      ? agent1?.characterId === winnerId
        ? agent1.name
        : (agent2?.name ?? "Unknown")
      : null;
    const loserName = loserId
      ? agent1?.characterId === loserId
        ? agent1.name
        : (agent2?.name ?? "Unknown")
      : null;
    const damageAgent1 = agent1?.damageDealtThisFight ?? 0;
    const damageAgent2 = agent2?.damageDealtThisFight ?? 0;
    this.matchmaking.recordRecentDuel({
      cycleId: this.currentCycle.cycleId,
      duelId: this.currentCycle.duelId,
      finishedAt: now,
      outcome: isDraw ? "draw" : "win",
      agent1Id: agent1?.characterId ?? "",
      agent1Name: agent1?.name ?? "Unknown",
      agent1OpeningStyle: getFrozenOpeningStyle(
        this.currentCycle.competitiveSnapshot,
        agent1?.characterId,
      ),
      agent2Id: agent2?.characterId ?? "",
      agent2Name: agent2?.name ?? "Unknown",
      agent2OpeningStyle: getFrozenOpeningStyle(
        this.currentCycle.competitiveSnapshot,
        agent2?.characterId,
      ),
      winnerId,
      winnerName,
      loserId,
      loserName,
      winReason,
      cancellationReason: null,
      damageAgent1,
      damageAgent2,
      damageWinner: winnerId
        ? agent1?.characterId === winnerId
          ? damageAgent1
          : damageAgent2
        : null,
      damageLoser: loserId
        ? agent1?.characterId === loserId
          ? damageAgent1
          : damageAgent2
        : null,
    });

    Logger.info(
      "StreamingDuelScheduler",
      isDraw
        ? `Fight ended in a draw: ${agent1?.name ?? "Unknown"} vs ${agent2?.name ?? "Unknown"}`
        : `Fight ended: ${winnerName} wins by ${winReason}`,
    );

    // Emit resolution event (spectator UI)
    this.world.emit("streaming:resolution:start", {
      cycleId: this.currentCycle.cycleId,
      duelId:
        this.currentCycle.duelId ?? `streaming-${this.currentCycle.cycleId}`,
      duelKeyHex: this.currentCycle.duelKeyHex,
      duelEndTime: now,
      winnerId,
      loserId,
      winnerName,
      loserName,
      outcome: isDraw ? "draw" : "win",
      agent1Id: agent1?.characterId ?? null,
      agent1Name: agent1?.name ?? null,
      agent2Id: agent2?.characterId ?? null,
      agent2Name: agent2?.name ?? null,
      winReason,
      seed: oracleProof.seed,
      replayHash: oracleProof.replayHash,
    });

    const a1 = this.currentCycle.agent1?.characterId ?? "";
    const a2 = this.currentCycle.agent2?.characterId ?? "";
    const resolvedDuelId =
      this.currentCycle.duelId ?? `streaming-${this.currentCycle.cycleId}`;
    if (isDraw) {
      // A draw is not a completed win. Cancel/void betting and notify agents
      // without supplying a fabricated winner to the standard completion event.
      this.world.emit("streaming:cycle:aborted", {
        cycleId: this.currentCycle.cycleId,
        duelId: resolvedDuelId,
        duelKeyHex: this.currentCycle.duelKeyHex,
        reason: "draw",
        agent1Id: a1 || null,
        agent2Id: a2 || null,
        agent1Name: agent1?.name ?? null,
        agent2Name: agent2?.name ?? null,
      });
      this.world.emit(EventType.DUEL_CANCELLED, {
        duelId: resolvedDuelId,
        challengerId: a1,
        targetId: a2,
        reason: "draw",
      });
    } else {
      this.world.emit(EventType.DUEL_COMPLETED, {
        duelId: resolvedDuelId,
        winnerId: winnerId!,
        winnerName: winnerName ?? "Unknown",
        loserId: loserId!,
        loserName: loserName ?? "Unknown",
        reason: winReason === "forfeit" ? "forfeit" : "death",
        seed: oracleProof.seed,
        replayHash: oracleProof.replayHash,
        forfeit: winReason === "forfeit",
        winnerReceives: [],
        winnerReceivesValue: 0,
        challengerStakes: [],
        targetStakes: [],
        challengerId: a1,
        opponentId: a2,
        challengerStakeValue: 0,
        opponentStakeValue: 0,
        summary: {
          duration: now - (this.currentCycle.cycleStartTime ?? now),
          rules: DEFAULT_DUEL_RULES,
          challengerStakeValue: 0,
          targetStakeValue: 0,
        },
      });
    }

    // Set camera to winner
    this.camera.finishFightCutawayTracking(now);
    this.camera.setCameraTarget(winnerId ?? agent1?.characterId ?? null, now);

    // Publish the terminal state immediately. The fast 200 ms fight broadcaster
    // was stopped above, so waiting for the normal one-second interval would
    // leave spectators on a stale FIGHTING frame after the authoritative death.
    this.broadcastState();

    // NOTE: cleanupAfterDuel() (health restore, food removal, teleport out) is
    // deferred to endCycle() so the death animation plays during the RESOLUTION
    // phase before agents are teleported out of the arena.
  }

  // ============================================================================
  // Cycle End
  // ============================================================================

  private endCycle(): void {
    if (!this.currentCycle) return;

    // Fix M — guard against re-entry
    if (this._endCycleInProgress) return;
    this._endCycleInProgress = true;

    const cycleSnapshot = this.currentCycle;
    const now = Date.now();
    const winnerId = cycleSnapshot.winnerId;
    const loserId = cycleSnapshot.loserId;
    const cycleAgent1Id = cycleSnapshot.agent1?.characterId ?? null;
    const cycleAgent2Id = cycleSnapshot.agent2?.characterId ?? null;

    // Snapshot duel food slots before clearing
    const duelFoodSlotsMap = this.orchestrator.getDuelFoodSlotsByAgent();
    const duelFoodSlotsSnapshotByAgent = new Map<
      string,
      Array<{ slot: number; itemId: string }>
    >();
    if (cycleAgent1Id) {
      duelFoodSlotsSnapshotByAgent.set(cycleAgent1Id, [
        ...(duelFoodSlotsMap.get(cycleAgent1Id) ?? []),
      ]);
      duelFoodSlotsMap.delete(cycleAgent1Id);
    }
    if (cycleAgent2Id) {
      duelFoodSlotsSnapshotByAgent.set(cycleAgent2Id, [
        ...(duelFoodSlotsMap.get(cycleAgent2Id) ?? []),
      ]);
      duelFoodSlotsMap.delete(cycleAgent2Id);
    }

    Logger.info(
      "StreamingDuelScheduler",
      `Cycle ${cycleSnapshot.cycleId} ended. Winner: ${winnerId || "none"}`,
    );

    // Emit cycle end
    this.world.emit("streaming:resolution:end", {
      cycleId: cycleSnapshot.cycleId,
      duelId: cycleSnapshot.duelId,
      duelKeyHex: cycleSnapshot.duelKeyHex,
      winnerId,
      loserId,
    });
    this.camera.finishFightCutawayTracking(now);

    // NOTE: Duel flags (inStreamingDuel, preventRespawn) are intentionally NOT
    // cleared here. They stay `true` until cleanupAfterDuel() teleports both
    // agents out of the arena and then clears them via microtask. Clearing
    // flags before the cleanup teleport creates a race condition where
    // DuelSystem.ejectNonDuelingPlayersFromCombatArenas() sees the agents
    // still in the arena with inStreamingDuel=false and emits a spurious
    // extra teleport (causing duplicate teleport VFX).

    // Clear current cycle
    this.currentCycle = null;
    this.orchestrator.clearContestantCache();

    // Transition phase state machine back to IDLE
    this.phaseStateMachine.forceIdle();
    this.schedulerState = "IDLE";

    // Publish IDLE before cleanup moves either contestant out of the arena.
    // Spectator sockets preserve send order, so the renderer releases its
    // resolution visibility gate before receiving the cleanup teleports. The
    // normal one-second broadcaster is too slow for this terminal boundary and
    // otherwise records a visibly empty final result frame.
    this.broadcastState();

    // Await cleanup and durable recovery retirement, then start the next cycle
    // after an inter-cycle delay. Neither a stale contestant nor a replayable
    // terminal snapshot may overlap a newer market.
    const previousCleanup = this.pendingCycleCleanup;
    const recovery = previousCleanup
      .then(() =>
        this.recoverCycleUntilCommitted({
          cycle: cycleSnapshot,
          cleanup: () =>
            this.orchestrator.cleanupAfterDuel(
              cycleSnapshot,
              duelFoodSlotsSnapshotByAgent,
            ),
          context: `Cycle ${cycleSnapshot.cycleId}`,
        }),
      )
      .catch((err) => {
        Logger.error(
          "StreamingDuelScheduler",
          `Cycle ${cycleSnapshot.cycleId} recovery barrier failed closed: ${errMsg(err)}`,
        );
        return false;
      })
      .then((recovered) => {
        if (!recovered || this.isDestroyed) {
          this._endCycleInProgress = false;
          return;
        }

        if (cycleSnapshot.recoveredFromPersistence) {
          this.continueRecoveredBacklogWithoutInterCycleDelay();
          return;
        }

        // Wait for inter-cycle delay so spectators see a clean arena reset
        this.interCycleTimeout = setTimeout(() => {
          this.interCycleTimeout = null;
          if (this.isDestroyed) {
            this._endCycleInProgress = false;
            return;
          }
          this._endCycleInProgress = false;

          // Check for pending graceful restart
          if (this._pendingGracefulRestart) {
            Logger.info(
              "StreamingDuelScheduler",
              "Duel cycle complete, triggering pending graceful restart",
            );
            this.triggerGracefulRestart();
            return;
          }

          // Start new cycle if enough agents are available
          if (this.matchmaking.availableAgents.size >= config.minAgents) {
            this.schedulerState = "ACTIVE";
            if (this.preparationStore) {
              void this.advancePrivatePreparationGate(Date.now());
            } else {
              void this.startNewCycle();
            }
          } else {
            this.schedulerState = "WAITING_FOR_AGENTS";
            Logger.info(
              "StreamingDuelScheduler",
              `Waiting for agents after cycle end: ${this.matchmaking.availableAgents.size}/${config.minAgents}`,
            );
          }
        }, STREAMING_TIMING.INTER_CYCLE_DELAY_MS);
      });
    this.pendingCycleCleanup = recovery.then(() => undefined);
    void this.pendingCycleCleanup;
  }

  /**
   * Abort the current cycle and return to IDLE state.
   * Used when both agents are missing or an unrecoverable error occurs mid-cycle.
   */
  private abortCycleToIdle(
    reason: string,
    occurredAtOverride?: number,
    terminalPersisted = false,
    cycleOverride?: StreamingDuelCycle,
  ): Promise<void> {
    const cycleSnapshot = cycleOverride ?? this.currentCycle;
    if (
      !this.isDestroyed &&
      cycleSnapshot?.phase === "FIGHTING" &&
      this.currentCycle?.cycleId === cycleSnapshot.cycleId &&
      this.hasPendingDamageForCurrentCycle()
    ) {
      const existing = this.damageFencedAbort;
      if (existing) {
        if (
          existing.cycleId !== cycleSnapshot.cycleId ||
          existing.reason !== reason ||
          existing.occurredAtOverride !== occurredAtOverride ||
          existing.terminalPersisted !== terminalPersisted
        ) {
          Logger.error(
            "StreamingDuelScheduler",
            "Conflicting cancellation arrived while exact damage commits were pending",
          );
        }
        return existing.promise;
      }
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      this.damageFencedAbort = {
        cycleId: cycleSnapshot.cycleId,
        reason,
        ...(occurredAtOverride !== undefined ? { occurredAtOverride } : {}),
        terminalPersisted,
        ...(cycleOverride ? { cycleOverride } : {}),
        promise,
        resolve,
        reject,
      };
      return promise;
    }

    Logger.warn("StreamingDuelScheduler", `Aborting cycle to IDLE: ${reason}`);
    let cleanup: (() => Promise<void>) | null = null;
    let initialCleanup: Promise<void> | null = null;

    if (
      cycleSnapshot?.phase === "RESOLUTION" &&
      cycleSnapshot.outcome !== null &&
      !terminalPersisted
    ) {
      Logger.warn(
        "StreamingDuelScheduler",
        `Ignored cancellation ${reason} for already-terminal cycle ${cycleSnapshot.cycleId}`,
      );
      return Promise.resolve();
    }

    this.orchestrator.stopCombatLoop();
    this.orchestrator.clearCombatRetryTimeout();
    this.orchestrator.stopCombatAIs();
    this.stopFightBroadcast();

    if (this.countdownTimeout) {
      clearTimeout(this.countdownTimeout);
      this.countdownTimeout = null;
    }

    if (this.interCycleTimeout) {
      clearTimeout(this.interCycleTimeout);
      this.interCycleTimeout = null;
    }

    const occurredAt = occurredAtOverride ?? Date.now();
    if (cycleSnapshot?.competitiveSnapshot?.persisted && !terminalPersisted) {
      if (
        this.pendingTerminalTransition ||
        this.terminalTransitionRetryTimeout
      ) {
        return this.pendingTerminalTransition ?? this.pendingCycleCleanup;
      }
      let transition!: Promise<void>;
      transition = this.persistCompetitiveTerminal(cycleSnapshot, {
        outcome: "cancelled",
        winnerId: null,
        winReason: null,
        cancellationReason: reason,
        seed: null,
        replayHash: null,
        terminalAt: occurredAt,
      })
        .then(async (persisted) => {
          if (!persisted) {
            throw new Error("competitive_terminal_persistence_rejected");
          }
          if (
            this.currentCycle?.cycleId === cycleSnapshot.cycleId ||
            this.isDestroyed
          ) {
            if (this.terminalTransitionRetryTimeout) {
              clearTimeout(this.terminalTransitionRetryTimeout);
              this.terminalTransitionRetryTimeout = null;
            }
            await this.abortCycleToIdle(
              reason,
              occurredAt,
              true,
              cycleSnapshot,
            );
          }
        })
        .catch((error) => {
          Logger.error(
            "StreamingDuelScheduler",
            `Terminal cancellation persistence failed closed: ${errMsg(error)}`,
          );
          if (this.isDestroyed) throw error;
          if (
            this.currentCycle?.cycleId === cycleSnapshot.cycleId &&
            !this.terminalTransitionRetryTimeout
          ) {
            this.terminalTransitionRetryTimeout = setTimeout(() => {
              this.terminalTransitionRetryTimeout = null;
              if (this.currentCycle?.cycleId === cycleSnapshot.cycleId) {
                void this.abortCycleToIdle(reason, occurredAt, false);
              }
            }, 1_000);
          }
        })
        .finally(() => {
          if (this.pendingTerminalTransition === transition) {
            this.pendingTerminalTransition = null;
          }
        });
      this.pendingTerminalTransition = transition;
      const previousCleanup = this.pendingCycleCleanup;
      this.pendingCycleCleanup = Promise.all([
        previousCleanup,
        transition,
      ]).then(() => undefined);
      return this.pendingCycleCleanup;
    }

    if (cycleSnapshot) {
      this._terminalNotice = {
        cycleId: cycleSnapshot.cycleId,
        duelId: cycleSnapshot.duelId,
        outcome: "cancelled",
        reason,
        occurredAt,
        expiresAt: occurredAt + STREAMING_TIMING.RESOLUTION_DURATION,
        agent1Id: cycleSnapshot.agent1?.characterId ?? null,
        agent1Name: cycleSnapshot.agent1?.name ?? null,
        agent2Id: cycleSnapshot.agent2?.characterId ?? null,
        agent2Name: cycleSnapshot.agent2?.name ?? null,
      };
      this.durableBettingTerminal = {
        cycle: cycleSnapshot,
        terminal: {
          outcome: reason === "draw" ? "draw" : "cancelled",
          cancellationReason: reason,
          duelEndTime: occurredAt,
        },
      };
      this.matchmaking.recordRecentDuel({
        cycleId: cycleSnapshot.cycleId,
        duelId: cycleSnapshot.duelId,
        finishedAt: occurredAt,
        outcome: "cancelled",
        agent1Id: cycleSnapshot.agent1?.characterId ?? null,
        agent1Name: cycleSnapshot.agent1?.name ?? null,
        agent1OpeningStyle: getFrozenOpeningStyle(
          cycleSnapshot.competitiveSnapshot,
          cycleSnapshot.agent1?.characterId,
        ),
        agent2Id: cycleSnapshot.agent2?.characterId ?? null,
        agent2Name: cycleSnapshot.agent2?.name ?? null,
        agent2OpeningStyle: getFrozenOpeningStyle(
          cycleSnapshot.competitiveSnapshot,
          cycleSnapshot.agent2?.characterId,
        ),
        winnerId: null,
        winnerName: null,
        loserId: null,
        loserName: null,
        winReason: null,
        cancellationReason: reason,
        damageAgent1: cycleSnapshot.agent1?.damageDealtThisFight ?? 0,
        damageAgent2: cycleSnapshot.agent2?.damageDealtThisFight ?? 0,
        damageWinner: null,
        damageLoser: null,
      });
      this.world.emit("streaming:cycle:aborted", {
        cycleId: cycleSnapshot.cycleId,
        duelId: cycleSnapshot.duelId,
        duelKeyHex: cycleSnapshot.duelKeyHex,
        reason,
        agent1Id: cycleSnapshot.agent1?.characterId ?? null,
        agent2Id: cycleSnapshot.agent2?.characterId ?? null,
        agent1Name: cycleSnapshot.agent1?.name ?? null,
        agent2Name: cycleSnapshot.agent2?.name ?? null,
      });

      // Restore health, position, combat state, flags, and any scheduler-owned
      // loadout for every cancellation origin. The basic entity restoration is
      // synchronous; inventory/equipment cleanup completes best-effort without
      // delaying the durable cancellation frame.
      this._endCycleInProgress = true;
      cleanup = () => this.orchestrator.cleanupAfterAbort(cycleSnapshot);
      // cleanupAfterAbort repairs visible/runtime state synchronously before
      // returning its persistence promise. Preserve that immediate boundary,
      // then reuse the captured function only if the async portion must retry.
      initialCleanup = cleanup();
    }

    if (
      this.currentCycle === null ||
      this.currentCycle.cycleId === cycleSnapshot?.cycleId
    ) {
      this.currentCycle = null;
      this.orchestrator.clearContestantCache();
      this.phaseStateMachine.forceIdle();
      this.schedulerState = "IDLE";
    }

    if (cleanup && cycleSnapshot) {
      const retryCleanup = cleanup;
      const firstCleanupAttempt = initialCleanup ?? undefined;
      const previousCleanup = terminalPersisted
        ? Promise.resolve()
        : this.pendingCycleCleanup;
      const recovery = previousCleanup
        .then(() =>
          this.recoverCycleUntilCommitted({
            cycle: cycleSnapshot,
            cleanup: retryCleanup,
            initialCleanup: firstCleanupAttempt,
            context: `Abort ${cycleSnapshot.cycleId} (${reason})`,
            terminalAtFloor: occurredAt,
          }),
        )
        .catch((err) => {
          Logger.error(
            "StreamingDuelScheduler",
            `Abort ${cycleSnapshot.cycleId} recovery barrier failed closed: ${errMsg(err)}`,
          );
          return false;
        })
        .then((recovered) => {
          if (!recovered || this.isDestroyed) {
            this._endCycleInProgress = false;
            return;
          }
          if (
            cycleSnapshot.recoveredFromPersistence &&
            occurredAt + STREAMING_TIMING.RESOLUTION_DURATION <= Date.now()
          ) {
            if (this._terminalNotice?.cycleId === cycleSnapshot.cycleId) {
              this._terminalNotice = null;
            }
            this.continueRecoveredBacklogWithoutInterCycleDelay();
            return;
          }
          this._endCycleInProgress = false;
        });
      this.pendingCycleCleanup = recovery.then(() => undefined);
      void this.pendingCycleCleanup;
      return this.pendingCycleCleanup;
    } else {
      this._endCycleInProgress = false;
      this.pendingCycleCleanup = Promise.resolve();
      return this.pendingCycleCleanup;
    }
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  private handleDuelCompleted(payload: unknown): void {
    const data = payload as {
      duelId?: string;
      winnerId?: string;
      loserId?: string;
    };

    if (!this.currentCycle || this.currentCycle.phase !== "FIGHTING") {
      return;
    }

    const authoritativeDuelId =
      this.currentCycle.duelId ?? `streaming-${this.currentCycle.cycleId}`;
    if (!data.duelId || data.duelId !== authoritativeDuelId) {
      return;
    }

    // Check if this is our duel
    if (
      data.winnerId === this.currentCycle.agent1?.characterId ||
      data.winnerId === this.currentCycle.agent2?.characterId
    ) {
      const winnerId = data.winnerId!;
      const loserId =
        winnerId === this.currentCycle.agent1?.characterId
          ? this.currentCycle.agent2?.characterId
          : this.currentCycle.agent1?.characterId;

      if (loserId) {
        this.orchestrator.startResolution(winnerId, loserId, "kill");
      }
    }
  }

  private handleEntityDamaged(payload: unknown): void {
    const data = payload as {
      entityId?: string;
      targetId?: string;
      sourceId?: string;
      attackerId?: string;
      damage?: number;
      publicActionObservation?: StreamingDuelDamageObservationContext;
      competitiveTerminal?: {
        outcome: "win";
        winnerId: string;
        loserId: string;
        winReason: "kill";
        terminalAt: number;
        seed: string;
        replayHash: string;
      };
    };

    const attackerId = data.attackerId || data.sourceId;
    const targetId = data.targetId || data.entityId;
    if (!attackerId || !targetId) return;

    const now = Date.now();
    const damage = Number(data.damage);
    const intensity = Number.isFinite(damage)
      ? clampNumber(damage / 6, 0.4, 5.5)
      : 0.8;
    this.camera.markAgentInteresting(attackerId, intensity, now);
    this.camera.markAgentInteresting(targetId, intensity * 0.7, now);

    if (!this.currentCycle || this.currentCycle.phase !== "FIGHTING") {
      return;
    }

    if (!Number.isFinite(damage) || damage <= 0) {
      return;
    }

    // Update damage dealt and highest hit for the attacker.
    let recordedDuelHit = false;
    if (
      attackerId === this.currentCycle.agent1?.characterId &&
      targetId === this.currentCycle.agent2?.characterId
    ) {
      this.currentCycle.agent1.attacksLanded++;
      this.currentCycle.agent1.damageDealtThisFight += damage;
      if (damage > this.currentCycle.agent1.highestHit) {
        this.currentCycle.agent1.highestHit = damage;
      }
      recordedDuelHit = true;
    } else if (
      attackerId === this.currentCycle.agent2?.characterId &&
      targetId === this.currentCycle.agent1?.characterId
    ) {
      this.currentCycle.agent2.attacksLanded++;
      this.currentCycle.agent2.damageDealtThisFight += damage;
      if (damage > this.currentCycle.agent2.highestHit) {
        this.currentCycle.agent2.highestHit = damage;
      }
      recordedDuelHit = true;
    }
    if (recordedDuelHit && this.currentCycle.firstHitAt == null) {
      this.currentCycle.firstHitAt = now;
    }
    if (recordedDuelHit) {
      this.orchestrator.recordAuthoritativeDamageObservation(
        attackerId,
        targetId,
        damage,
        data.publicActionObservation,
      );
    }

    // Sync target HP immediately so the next broadcast reflects current health
    // (don't wait for the next tickFighting → updateContestantHp cycle).
    const targetEntity = this.world.entities.get(targetId);
    if (targetEntity) {
      const targetData = targetEntity.data as {
        health?: number;
        maxHealth?: number;
      };
      const freshHp = targetData.health;
      const freshMaxHp = targetData.maxHealth;
      if (typeof freshHp === "number" && Number.isFinite(freshHp)) {
        if (this.currentCycle.agent1?.characterId === targetId) {
          this.currentCycle.agent1.currentHp = freshHp;
          if (
            typeof freshMaxHp === "number" &&
            Number.isFinite(freshMaxHp) &&
            freshMaxHp > 0
          ) {
            this.currentCycle.agent1.maxHp = freshMaxHp;
          }
        } else if (this.currentCycle.agent2?.characterId === targetId) {
          this.currentCycle.agent2.currentHp = freshHp;
          if (
            typeof freshMaxHp === "number" &&
            Number.isFinite(freshMaxHp) &&
            freshMaxHp > 0
          ) {
            this.currentCycle.agent2.maxHp = freshMaxHp;
          }
        }
      }
    }

    const terminal = data.competitiveTerminal;
    if (terminal) {
      const observation = data.publicActionObservation;
      if (
        !recordedDuelHit ||
        terminal.outcome !== "win" ||
        terminal.winnerId !== attackerId ||
        terminal.loserId !== targetId ||
        terminal.winReason !== "kill" ||
        !observation ||
        terminal.terminalAt !== observation.observedAt ||
        !/^(0|[1-9][0-9]{0,19})$/.test(terminal.seed) ||
        !/^[0-9a-f]{64}$/.test(terminal.replayHash)
      ) {
        Logger.error(
          "StreamingDuelScheduler",
          "Rejected mismatched atomic competitive terminal receipt",
        );
        this.abortCycleToIdle("damage_terminal_receipt_invalid");
        return;
      }
      this.handleResolution(attackerId, targetId, "kill", {
        terminalAt: terminal.terminalAt,
        seed: terminal.seed,
        replayHash: terminal.replayHash,
        persisted: true,
      });
    }
  }

  private handleEntityHealed(payload: unknown): void {
    if (!this.currentCycle || this.currentCycle.phase !== "FIGHTING") return;

    const data = payload as {
      entityId?: string;
      healAmount?: number;
      newHealth?: number;
    };
    const entityId = data.entityId;
    const healAmount = Number(data.healAmount);
    const newHealth = Number(data.newHealth);
    if (
      !entityId ||
      !Number.isFinite(healAmount) ||
      healAmount <= 0 ||
      !Number.isFinite(newHealth)
    ) {
      return;
    }

    const contestant =
      this.currentCycle.agent1?.characterId === entityId
        ? this.currentCycle.agent1
        : this.currentCycle.agent2?.characterId === entityId
          ? this.currentCycle.agent2
          : null;
    if (!contestant) return;

    contestant.currentHp = clampNumber(newHealth, 0, contestant.maxHp);
    contestant.healsUsed++;
  }

  private handleEntityDeath(payload: unknown): void {
    const data = payload as {
      entityId?: string;
      killedBy?: string;
    };

    const now = Date.now();
    if (data.killedBy) {
      this.camera.markAgentInteresting(data.killedBy, 4.2, now);
    }
    if (data.entityId) {
      this.camera.markAgentInteresting(data.entityId, 1.2, now);
      // An on-deck preparation is private and pre-market. Death therefore
      // cancels it as unavailable rather than manufacturing a sporting result.
      // The current-cycle path below still runs when this agent is also an
      // active contestant.
      this.cancelUnavailableOnDeckContestant(data.entityId);
    }

    // Handle deaths during both FIGHTING and COUNTDOWN phases (Fix F).
    if (
      !this.currentCycle ||
      (this.currentCycle.phase !== "FIGHTING" &&
        this.currentCycle.phase !== "COUNTDOWN")
    ) {
      return;
    }

    if (!data.entityId) return;

    const cycleId = this.currentCycle.cycleId;
    const entityId = data.entityId;

    // PlayerSystem emits ENTITY_DEATH synchronously inside damage application,
    // before CombatSystem emits COMBAT_DAMAGE_DEALT for the killing hit. Resolve
    // in a microtask so terminal damage/attack statistics land first and all
    // same-tick projectiles are visible to simultaneous-death adjudication.
    globalThis.queueMicrotask(() => {
      this.resolveAuthoritativeEntityDeath(cycleId, entityId);
    });
  }

  private resolveAuthoritativeEntityDeath(
    cycleId: string,
    entityId: string,
  ): void {
    if (
      !this.currentCycle ||
      this.currentCycle.cycleId !== cycleId ||
      (this.currentCycle.phase !== "FIGHTING" &&
        this.currentCycle.phase !== "COUNTDOWN")
    ) {
      return;
    }

    // Check if one of our contestants died
    if (
      entityId === this.currentCycle.agent1?.characterId ||
      entityId === this.currentCycle.agent2?.characterId
    ) {
      // ENTITY_DEATH has no cycle identifier, so a late event from the previous
      // fight can arrive after cleanup has already revived the same contestant.
      // The entity's authoritative health is the final validity check: never
      // settle a current cycle from a stale event against a living entity.
      const allegedLoserEntity = this.world.entities.get(entityId);
      const allegedLoserHealth = allegedLoserEntity
        ? Number((allegedLoserEntity.data as { health?: number }).health)
        : Number.NaN;
      if (Number.isFinite(allegedLoserHealth) && allegedLoserHealth > 0) {
        return;
      }

      const loserId = entityId;
      const winnerId =
        loserId === this.currentCycle.agent1?.characterId
          ? this.currentCycle.agent2?.characterId
          : this.currentCycle.agent1?.characterId;

      if (winnerId) {
        // Check for simultaneous death (#13): if the "winner" is also dead,
        // resolve by damage comparison or coin flip instead of declaring a kill.
        const winnerEntity = this.world.entities.get(winnerId);
        const winnerHp = winnerEntity
          ? ((winnerEntity.data as { health?: number }).health ?? 0)
          : 0;

        if (winnerHp <= 0) {
          // Both dead — resolve by damage advantage
          const { agent1, agent2 } = this.currentCycle;
          const dmg1 = agent1?.damageDealtThisFight ?? 0;
          const dmg2 = agent2?.damageDealtThisFight ?? 0;

          if (dmg1 !== dmg2) {
            const actualWinner =
              dmg1 > dmg2 ? agent1?.characterId : agent2?.characterId;
            const actualLoser =
              actualWinner === agent1?.characterId
                ? agent2?.characterId
                : agent1?.characterId;
            if (actualWinner && actualLoser) {
              this.orchestrator.startResolution(
                actualWinner,
                actualLoser,
                "damage_advantage",
              );
            }
          } else {
            // Simultaneous death with equal damage is a true draw. Never
            // coin-flip an outcome that can flow into betting settlement.
            this.orchestrator.startResolution(null, null, "draw");
          }
        } else {
          this.orchestrator.startResolution(winnerId, loserId, "kill");
        }
      }
    }
  }

  // ============================================================================
  // State Broadcasting
  // ============================================================================

  private startStateBroadcast(): void {
    // Emit immediately so spectators get a valid first camera target without
    // waiting for the first interval tick.
    this.broadcastState();

    // Broadcast state every second (skip during FIGHTING when fast broadcast is active)
    this.broadcastInterval = setInterval(() => {
      // Skip if fast fight broadcast is handling updates at 200ms (#11)
      if (
        this.fightBroadcastInterval &&
        this.currentCycle?.phase === "FIGHTING"
      )
        return;
      // Ensure HP is fresh before broadcasting (catches food/regen changes
      // that don't fire damage events).
      this.orchestrator.updateContestantHp();
      this.broadcastState();
    }, STREAMING_TIMING.STATE_BROADCAST_INTERVAL);
  }

  /** Start fast 200ms broadcast during FIGHTING phase (#11) */
  private startFightBroadcast(): void {
    this.stopFightBroadcast();
    this.fightBroadcastInterval = setInterval(() => {
      this.orchestrator.updateContestantHp();
      this.broadcastState();
    }, STREAMING_TIMING.FIGHT_BROADCAST_INTERVAL);
  }

  /** Stop fast fight broadcast */
  private stopFightBroadcast(): void {
    if (this.fightBroadcastInterval) {
      clearInterval(this.fightBroadcastInterval);
      this.fightBroadcastInterval = null;
    }
  }

  private broadcastState(): void {
    const state = this.getStreamingState();
    // The scheduler retains raw cancellation reasons for persistence and
    // operator telemetry. Spectator sockets receive the same viewer-safe
    // vocabulary as public REST/SSE so every rendered channel agrees.
    const publicState = sanitizePublicStreamingState(state);
    // Broadcast streaming state only to spectator sockets (interest management).
    // Regular gameplay clients don't need streaming duel updates every second.
    const network = this.world.network as NetworkWithSend | undefined;
    const contestantIds = [
      state.cycle.agent1?.id,
      state.cycle.agent2?.id,
    ].filter((id): id is string => typeof id === "string" && id.length > 0);
    const contestantSyncKey = contestantIds.join("\u0000");
    if (contestantSyncKey !== this._lastStreamingContestantSyncKey) {
      // Entity snapshots must precede the overlay/camera state that references
      // them. Otherwise a long-lived viewer can receive teleports and combat
      // packets for a contestant that was outside its initial focused snapshot.
      network?.syncStreamingContestants?.(contestantIds);
      this._lastStreamingContestantSyncKey = contestantSyncKey;
    }
    if (network?.sendToSpectators) {
      network.sendToSpectators("streamingState", publicState);
    } else if (network?.send) {
      // Fallback: broadcast to all if sendToSpectators not available
      network.send("streamingState", publicState);
    }
  }

  /**
   * Get current streaming state for broadcast.
   * MEMORY OPTIMIZATION: Reuses pre-allocated objects to avoid GC pressure.
   * Only creates new contestant objects when agents change.
   */
  getStreamingState(): StreamingStateUpdate {
    const now = Date.now();
    const leaderboard = this.matchmaking.getLeaderboard();

    if (this._terminalNotice && now >= this._terminalNotice.expiresAt) {
      this._terminalNotice = null;
    }

    if (!this.currentCycle) {
      // IDLE state - use pre-allocated idle cycle object
      const previewPair = this.camera.getIdlePreviewPairSnapshot();
      let previewAgent1Id = previewPair?.agent1Id ?? null;
      let previewAgent2Id = previewPair?.agent2Id ?? null;

      if (!previewAgent1Id || !previewAgent2Id) {
        // Collect fallback IDs without allocating if possible
        let fallbackCount = 0;
        let fallback1: string | null = null;
        let fallback2: string | null = null;
        for (const agentId of this.matchmaking.availableAgents) {
          if (!this.camera.isAgentValidCameraCandidate(agentId)) {
            continue;
          }
          if (fallbackCount === 0) {
            fallback1 = agentId;
          } else if (fallbackCount === 1) {
            fallback2 = agentId;
          }
          fallbackCount++;
          if (fallbackCount >= config.minAgents) {
            break;
          }
        }
        previewAgent1Id = previewAgent1Id ?? fallback1;
        previewAgent2Id = previewAgent2Id ?? fallback2;
      }

      // Refresh even when the same pair repeats. These public objects are also
      // used for terminal fight frames, so an ID-only refresh gate can leak a
      // completed duel's HP and damage into the next "Up Next" presentation.
      this._cachedAgent1 = this.refreshIdlePreviewAgentInPlace(
        previewAgent1Id,
        previewAgent2Id,
        this._cachedAgent1,
      );
      this._cachedAgent2 = this.refreshIdlePreviewAgentInPlace(
        previewAgent2Id,
        previewAgent1Id,
        this._cachedAgent2,
      );

      // Update idle cycle object in place (zero allocation)
      this._idleCycleObject.cycleStartTime = now;
      this._idleCycleObject.phaseStartTime = now;
      this._idleCycleObject.phaseVersion = 0;
      this._idleCycleObject.agent1 = this._cachedAgent1;
      this._idleCycleObject.agent2 = this._cachedAgent2;

      // Build camera IDs without allocation if possible
      const cameraId1 = this._cachedAgent1
        ? ((this._cachedAgent1 as { id?: string }).id ?? null)
        : null;
      const cameraId2 = this._cachedAgent2
        ? ((this._cachedAgent2 as { id?: string }).id ?? null)
        : null;

      // Use inline array to avoid allocation when possible
      const preferredCameraIds: string[] = [];
      if (cameraId1) preferredCameraIds.push(cameraId1);
      if (cameraId2) preferredCameraIds.push(cameraId2);

      const idleCameraTarget =
        this.camera.getIdleCameraTargetSnapshot(preferredCameraIds);

      const publicPreparation = this.getPublicPreparationSummary(
        now,
        cameraId1,
        cameraId2,
      );
      const preparationDeadline = publicPreparation?.expiresAt ?? now;
      this._idleCycleObject.phaseEndTime = preparationDeadline;
      this._idleCycleObject.timeRemaining = Math.max(
        0,
        preparationDeadline - now,
      );

      // Update return object in place
      this._streamingStateObject.cycle = this._idleCycleObject;
      this._streamingStateObject.leaderboard = leaderboard;
      this._streamingStateObject.cameraTarget = idleCameraTarget;
      this._streamingStateObject.terminalNotice = this._terminalNotice;
      this._streamingStateObject.preparation = publicPreparation;

      return this._streamingStateObject;
    }

    // ACTIVE CYCLE - use pre-allocated active cycle object
    const { agent1, agent2 } = this.currentCycle;
    const phaseEndTime = this.getPhaseEndTime();
    const timeRemaining = Math.max(0, phaseEndTime - now);
    const cameraTarget = this.getCycleCameraTargetSnapshot();

    // Check if we need to update agent objects (only when agent changes or health changes)
    const currentCycleId = this.currentCycle.cycleId;
    const cycleChanged = this._lastStreamingStateCycleId !== currentCycleId;

    if (cycleChanged || this._cachedAgent1 === null) {
      this._cachedAgent1 = this.toStreamingCycleAgentInPlace(
        agent1,
        this._cachedAgent1,
      );
    } else if (agent1) {
      // Update HP in place (most common change during fight)
      this.updateAgentHpInPlace(this._cachedAgent1, agent1);
    }

    if (cycleChanged || this._cachedAgent2 === null) {
      this._cachedAgent2 = this.toStreamingCycleAgentInPlace(
        agent2,
        this._cachedAgent2,
      );
    } else if (agent2) {
      // Update HP in place (most common change during fight)
      this.updateAgentHpInPlace(this._cachedAgent2, agent2);
    }

    this._lastStreamingStateCycleId = currentCycleId;

    // Update active cycle object in place
    this._activeCycleObject.cycleId = currentCycleId;
    this._activeCycleObject.phase = this.currentCycle.phase;
    this._activeCycleObject.cycleStartTime = this.currentCycle.cycleStartTime;
    this._activeCycleObject.phaseStartTime = this.currentCycle.phaseStartTime;
    this._activeCycleObject.phaseEndTime = phaseEndTime;
    this._activeCycleObject.phaseVersion = this.currentCycle.phaseVersion;
    this._activeCycleObject.timeRemaining = timeRemaining;
    this._activeCycleObject.agent1 = this._cachedAgent1;
    this._activeCycleObject.agent2 = this._cachedAgent2;
    this._activeCycleObject.duelId = this.currentCycle.duelId;
    this._activeCycleObject.duelKeyHex = this.currentCycle.duelKeyHex;
    this._activeCycleObject.competitiveSnapshotVersion =
      this.currentCycle.competitiveSnapshotVersion;
    this._activeCycleObject.competitiveSnapshotDigest =
      this.currentCycle.competitiveSnapshotDigest;
    this._activeCycleObject.competitiveSnapshot =
      this.currentCycle.competitiveSnapshot;
    this._activeCycleObject.betOpenTime = this.currentCycle.betOpenTime;
    this._activeCycleObject.betCloseTime = this.currentCycle.betCloseTime;
    this._activeCycleObject.countdown = this.currentCycle.countdownValue;
    this._activeCycleObject.fightStartTime =
      this.currentCycle.fightStartTime ?? null;
    this._activeCycleObject.firstHitAt = this.currentCycle.firstHitAt ?? null;
    this._activeCycleObject.duelEndTime = this.currentCycle.duelEndTime ?? null;
    this._activeCycleObject.arenaPositions =
      this.currentCycle.arenaPositions ?? null;
    this._activeCycleObject.winnerId = this.currentCycle.winnerId;
    this._activeCycleObject.winnerName = this.currentCycle.winnerId
      ? (this.currentCycle.agent1?.characterId === this.currentCycle.winnerId
          ? this.currentCycle.agent1?.name
          : this.currentCycle.agent2?.name) || null
      : null;
    this._activeCycleObject.outcome = this.currentCycle.outcome;
    this._activeCycleObject.winReason = this.currentCycle.winReason;
    this._activeCycleObject.seed = this.currentCycle.seed;
    this._activeCycleObject.replayHash = this.currentCycle.replayHash;
    this._activeCycleObject.actionObservations =
      this.orchestrator.getPublicActionObservations(currentCycleId);

    // Update return object in place
    this._streamingStateObject.cycle = this._activeCycleObject;
    this._streamingStateObject.leaderboard = leaderboard;
    this._streamingStateObject.cameraTarget = cameraTarget;
    this._streamingStateObject.terminalNotice = null;
    this._streamingStateObject.preparation = null;

    return this._streamingStateObject;
  }

  private getPublicPreparationSummary(
    now: number,
    agent1Id: string | null,
    agent2Id: string | null,
  ): StreamingDuelPreparationSummary | null {
    const preparation = this.onDeckPreparation;
    if (
      !preparation ||
      preparation.expiresAt <= now ||
      (preparation.status !== "preparing" && preparation.status !== "ready") ||
      preparation.agent1Id !== agent1Id ||
      preparation.agent2Id !== agent2Id
    ) {
      return null;
    }

    return parseStreamingDuelPreparationSummary({
      schemaVersion: STREAMING_DUEL_PREPARATION_SUMMARY_SCHEMA_VERSION,
      status: preparation.status,
      selectedAt: preparation.selectedAt,
      expiresAt: preparation.expiresAt,
      agent1: {
        id: preparation.agent1Id,
        ready: preparation.agent1ReadyAt !== null,
        activity: this.getPublicPreparationActivity(
          preparation.preparationId,
          preparation.agent1Id,
        ),
        mode: this.getPublicPreparationMode(
          preparation.preparationId,
          preparation.agent1Id,
        ),
        activityTrail: this.getPublicPreparationActivityTrail(
          preparation.preparationId,
          preparation.agent1Id,
        ),
      },
      agent2: {
        id: preparation.agent2Id,
        ready: preparation.agent2ReadyAt !== null,
        activity: this.getPublicPreparationActivity(
          preparation.preparationId,
          preparation.agent2Id,
        ),
        mode: this.getPublicPreparationMode(
          preparation.preparationId,
          preparation.agent2Id,
        ),
        activityTrail: this.getPublicPreparationActivityTrail(
          preparation.preparationId,
          preparation.agent2Id,
        ),
      },
    });
  }

  private getPublicPreparationActivity(
    preparationId: string,
    agentId: string,
  ): StreamingDuelPublicPreparationActivity | null {
    if (this.publicPreparationActivities?.preparationId !== preparationId) {
      return null;
    }
    return (
      this.publicPreparationActivities.agents.get(agentId)?.activity ?? null
    );
  }

  private clearPublicPreparationActivities(preparationId: string): void {
    if (this.publicPreparationActivities?.preparationId === preparationId) {
      this.publicPreparationActivities = null;
      this.camera.clearIdlePreparationActivityCut();
    }
  }

  private getPublicPreparationMode(
    preparationId: string,
    agentId: string,
  ): StreamingDuelPublicPreparationMode | null {
    if (this.publicPreparationActivities?.preparationId !== preparationId) {
      return null;
    }
    return this.publicPreparationActivities.agents.get(agentId)?.mode ?? null;
  }

  private getPublicPreparationActivityTrail(
    preparationId: string,
    agentId: string,
  ): readonly StreamingDuelPublicPreparationActivity[] {
    if (this.publicPreparationActivities?.preparationId !== preparationId) {
      return [];
    }
    return (
      this.publicPreparationActivities.agents.get(agentId)?.activityTrail ?? []
    );
  }

  /**
   * Rebuild the bounded public recap before re-announcing a durable private
   * preparation. Historical replay must not manufacture a fresh camera cut.
   */
  private async hydratePublicPreparationActivities(
    preparation: DuelPreparationSnapshot,
  ): Promise<void> {
    const store = this.preparationStore;
    const records =
      store && typeof store.listRecentPublicActivities === "function"
        ? await store.listRecentPublicActivities(preparation.preparationId)
        : [];
    this.publicPreparationActivities = {
      preparationId: preparation.preparationId,
      agents: new Map(),
    };
    for (const record of records) {
      if (
        record.preparationId !== preparation.preparationId ||
        (record.agentId !== preparation.agent1Id &&
          record.agentId !== preparation.agent2Id)
      ) {
        throw new Error("public_preparation_activity_history_mismatch");
      }
      this.handlePreparationPublicActivity(record, false);
    }
  }

  private handlePreparationPublicActivity(
    payload: unknown,
    considerCameraCut = true,
  ): void {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const data = payload as Record<string, unknown>;
    const keys = Object.keys(data).sort();
    if (
      keys.length !== PUBLIC_PREPARATION_ACTIVITY_EVENT_KEYS.length ||
      !PUBLIC_PREPARATION_ACTIVITY_EVENT_KEYS.every(
        (key, index) => keys[index] === key,
      ) ||
      typeof data.preparationId !== "string" ||
      typeof data.agentId !== "string" ||
      typeof data.activity !== "string" ||
      !PUBLIC_PREPARATION_ACTIVITIES.has(data.activity) ||
      typeof data.mode !== "string" ||
      !PUBLIC_PREPARATION_MODES.has(data.mode) ||
      ((data.activity === "planning" || data.activity === "reassessing") &&
        data.mode !== "working") ||
      !Number.isSafeInteger(data.occurredAt) ||
      Number(data.occurredAt) < 0 ||
      !Number.isSafeInteger(data.revision) ||
      Number(data.revision) < 1
    ) {
      return;
    }
    const preparation = this.onDeckPreparation;
    const activities = this.publicPreparationActivities;
    if (
      !preparation ||
      !activities ||
      activities.preparationId !== preparation.preparationId ||
      data.preparationId !== preparation.preparationId ||
      (data.agentId !== preparation.agent1Id &&
        data.agentId !== preparation.agent2Id)
    ) {
      return;
    }
    const previous = activities.agents.get(data.agentId);
    if (previous && previous.revision >= Number(data.revision)) return;
    const activity = data.activity as StreamingDuelPublicPreparationActivity;
    const mode = data.mode as StreamingDuelPublicPreparationMode;
    const priorTrail = previous?.activityTrail ?? [];
    const isNewActivity = priorTrail.at(-1) !== activity;
    const isNewPresentation = isNewActivity || previous?.mode !== mode;
    const activityTrail = !isNewActivity
      ? priorTrail
      : [...priorTrail, activity].slice(
          -STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITY_TRAIL_LIMIT,
        );
    activities.agents.set(data.agentId, {
      activity,
      mode,
      activityTrail,
      revision: Number(data.revision),
    });
    if (considerCameraCut && isNewPresentation && !this.currentCycle) {
      this.camera.considerIdlePreparationActivityCut(data.agentId, Date.now());
    }
  }

  /**
   * Refresh an IDLE preview from current world state while removing fields that
   * only describe the completed competitive cycle. Equipment and inventory
   * remain visible so spectators can follow real preparation between duels.
   */
  private refreshIdlePreviewAgentInPlace(
    agentId: string | null,
    opponentId: string | null,
    existing: StreamingStateUpdate["cycle"]["agent1"],
  ): StreamingStateUpdate["cycle"]["agent1"] {
    if (!agentId) {
      return null;
    }

    const contestant = this.orchestrator.createContestant(
      agentId,
      opponentId ?? undefined,
    );
    const preview = this.toStreamingCycleAgentInPlace(contestant, existing);
    if (!preview) {
      return null;
    }

    preview.damageDealtThisFight = 0;
    preview.highestHit = 0;
    preview.attacksLanded = 0;
    preview.healsUsed = 0;
    preview.loadoutFingerprint = null;
    preview.availableCombatStyles = [];
    preview.combatLoadouts = {};
    preview.loadoutFrozen = false;
    preview.strategySummary = null;
    return preview;
  }

  private getPublicStrategySummary(
    agentId: string,
  ): StreamingDuelStrategySummary | null {
    return toPublicStrategySummary(
      this.currentCycle?.competitiveSnapshot?.contestants.find(
        (contestant) => contestant.agentId === agentId,
      ),
    );
  }

  /**
   * Convert AgentContestant to streaming format, reusing existing object if possible.
   * MEMORY OPTIMIZATION: Updates properties in place instead of creating new objects.
   */
  private toStreamingCycleAgentInPlace(
    agent: AgentContestant | null,
    existing: StreamingStateUpdate["cycle"]["agent1"],
  ): StreamingStateUpdate["cycle"]["agent1"] {
    if (!agent) {
      return null;
    }

    // Reuse existing object if available
    if (existing) {
      existing.id = agent.characterId;
      existing.name = agent.name;
      existing.provider = agent.provider;
      existing.model = agent.model;
      existing.hp = agent.currentHp;
      existing.maxHp = agent.maxHp;
      existing.combatLevel = agent.combatLevel;
      existing.wins = agent.wins;
      existing.losses = agent.losses;
      existing.damageDealtThisFight = agent.damageDealtThisFight;
      existing.highestHit = agent.highestHit;
      existing.attacksLanded = agent.attacksLanded;
      existing.healsUsed = agent.healsUsed;
      existing.loadoutFingerprint = agent.loadoutFingerprint;
      existing.availableCombatStyles = [...agent.availableCombatStyles];
      existing.combatLoadouts = cloneCombatLoadouts(agent.combatLoadouts);
      existing.loadoutFrozen = agent.loadoutFrozen;
      existing.strategySummary = this.getPublicStrategySummary(
        agent.characterId,
      );
      existing.prayerPointUnits = agent.prayerPointUnits;
      existing.prayerPoints = agent.prayerPoints;
      existing.prayerMaxPoints = agent.prayerMaxPoints;
      existing.rank = agent.rank;
      existing.headToHeadWins = agent.headToHeadWins;
      existing.headToHeadLosses = agent.headToHeadLosses;
      // Equipment: update in place by copying properties
      if (agent.equipment) {
        if (!existing.equipment) {
          existing.equipment = {};
        }
        // Clear existing and copy new (avoids creating new object)
        for (const key of Object.keys(
          existing.equipment as Record<string, unknown>,
        )) {
          delete (existing.equipment as Record<string, unknown>)[key];
        }
        Object.assign(existing.equipment, agent.equipment);
      } else {
        existing.equipment = {};
      }
      // Inventory: we must use the reference since inventory items can change
      // But cap at 28 items to match original
      existing.inventory = Array.isArray(agent.inventory)
        ? agent.inventory.slice(0, 28)
        : [];
      if (!existing.itemIconPaths) {
        existing.itemIconPaths = {};
      }
      for (const key of Object.keys(existing.itemIconPaths)) {
        delete (existing.itemIconPaths as Record<string, unknown>)[key];
      }
      Object.assign(existing.itemIconPaths, agent.itemIconPaths ?? {});
      return existing;
    }

    // Create new object (only when no existing object)
    return this.toStreamingCycleAgent(agent);
  }

  /**
   * Update hot combat fields in place during active fights without reallocating
   * the cached streaming state objects.
   */
  private updateAgentHpInPlace(
    cached: StreamingStateUpdate["cycle"]["agent1"],
    agent: AgentContestant,
  ): void {
    if (!cached) return;
    this.orchestrator.refreshContestantLoadout(agent);
    cached.hp = agent.currentHp;
    cached.maxHp = agent.maxHp;
    cached.damageDealtThisFight = agent.damageDealtThisFight;
    cached.highestHit = agent.highestHit;
    cached.attacksLanded = agent.attacksLanded;
    cached.healsUsed = agent.healsUsed;
    cached.loadoutFingerprint = agent.loadoutFingerprint;
    cached.availableCombatStyles = [...agent.availableCombatStyles];
    cached.combatLoadouts = cloneCombatLoadouts(agent.combatLoadouts);
    cached.loadoutFrozen = agent.loadoutFrozen;
    cached.prayerPointUnits = agent.prayerPointUnits;
    cached.prayerPoints = agent.prayerPoints;
    cached.prayerMaxPoints = agent.prayerMaxPoints;
    cached.wins = agent.wins;
    cached.losses = agent.losses;
    if (!cached.equipment) {
      cached.equipment = {};
    }
    for (const key of Object.keys(
      cached.equipment as Record<string, unknown>,
    )) {
      delete (cached.equipment as Record<string, unknown>)[key];
    }
    Object.assign(cached.equipment, agent.equipment);
    cached.inventory = Array.isArray(agent.inventory)
      ? agent.inventory.slice(0, 28)
      : [];
    if (!cached.itemIconPaths) {
      cached.itemIconPaths = {};
    }
    for (const key of Object.keys(cached.itemIconPaths)) {
      delete (cached.itemIconPaths as Record<string, unknown>)[key];
    }
    Object.assign(cached.itemIconPaths, agent.itemIconPaths ?? {});
  }

  // ============================================================================
  // Helper Methods (owned by facade)
  // ============================================================================

  private getPhaseEndTime(): number {
    if (!this.currentCycle) return Date.now();

    const { phase, phaseStartTime } = this.currentCycle;

    switch (phase) {
      case "ANNOUNCEMENT":
        return (
          this.currentCycle.betCloseTime ??
          phaseStartTime + STREAMING_TIMING.ANNOUNCEMENT_DURATION
        );
      case "COUNTDOWN":
        return (
          this.currentCycle.fightStartTime ??
          phaseStartTime + STREAMING_TIMING.COUNTDOWN_DURATION
        );
      case "FIGHTING":
        return (
          phaseStartTime +
          STREAMING_TIMING.FIGHTING_DURATION +
          STREAMING_TIMING.END_WARNING_DURATION
        );
      case "RESOLUTION":
        return phaseStartTime + STREAMING_TIMING.RESOLUTION_DURATION;
      default:
        return Date.now();
    }
  }

  private toStreamingCycleAgent(
    agent: AgentContestant | null,
  ): StreamingStateUpdate["cycle"]["agent1"] {
    if (!agent) {
      return null;
    }

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
      highestHit: agent.highestHit,
      attacksLanded: agent.attacksLanded,
      healsUsed: agent.healsUsed,
      equipment: { ...(agent.equipment ?? {}) },
      inventory: Array.isArray(agent.inventory)
        ? agent.inventory.slice(0, 28)
        : [],
      itemIconPaths: { ...(agent.itemIconPaths ?? {}) },
      loadoutFingerprint: agent.loadoutFingerprint,
      availableCombatStyles: [...agent.availableCombatStyles],
      combatLoadouts: cloneCombatLoadouts(agent.combatLoadouts),
      loadoutFrozen: agent.loadoutFrozen,
      strategySummary: this.getPublicStrategySummary(agent.characterId),
      prayerPointUnits: agent.prayerPointUnits,
      prayerPoints: agent.prayerPoints,
      prayerMaxPoints: agent.prayerMaxPoints,
      rank: agent.rank,
      headToHeadWins: agent.headToHeadWins,
      headToHeadLosses: agent.headToHeadLosses,
    };
  }

  /**
   * Snapshot-based camera target for broadcast (no side-effects like
   * refreshNextDuelPair). Used by getStreamingState for the active-cycle path.
   */
  private getCycleCameraTargetSnapshot(): string | null {
    if (!this.currentCycle) {
      return null;
    }

    const phase = this.currentCycle.phase ?? "IDLE";
    const contestantIds = this.camera.getCycleContestantIds();
    const nextDuelIds = this.getNextDuelAgentIdsSnapshot(contestantIds);
    const currentTarget = this.camera.cameraTarget;
    if (
      typeof currentTarget === "string" &&
      this.camera.isAgentValidCameraCandidate(currentTarget)
    ) {
      const currentIsContestant = contestantIds.has(currentTarget);
      const currentIsNextDuel = nextDuelIds.has(currentTarget);

      if (phase === "ANNOUNCEMENT" || phase === "COUNTDOWN") {
        if (currentIsContestant) {
          return currentTarget;
        }
      } else if (phase === "FIGHTING") {
        if (currentIsContestant || currentIsNextDuel) {
          return currentTarget;
        }
      } else {
        return currentTarget;
      }
    }

    const preferredIds: string[] = [];

    if (phase === "RESOLUTION" && this.currentCycle.winnerId) {
      preferredIds.push(this.currentCycle.winnerId);
    }

    preferredIds.push(...contestantIds, ...nextDuelIds);

    const seen = new Set<string>();
    for (const agentId of preferredIds) {
      if (seen.has(agentId)) {
        continue;
      }
      seen.add(agentId);
      if (this.camera.isAgentValidCameraCandidate(agentId)) {
        return agentId;
      }
    }

    for (const agentId of this.matchmaking.availableAgents) {
      if (this.camera.isAgentValidCameraCandidate(agentId)) {
        return agentId;
      }
    }

    return null;
  }

  /**
   * Non-mutating snapshot of next-duel agent IDs for broadcast.
   * Unlike CameraDirector.getNextDuelAgentIds, this does NOT refresh the
   * pair if a member is invalid — it just returns what's available.
   */
  private getNextDuelAgentIdsSnapshot(contestantIds: Set<string>): Set<string> {
    const ids = new Set<string>();
    const nextPair = this.matchmaking.nextDuelPair;
    if (!nextPair) {
      return ids;
    }

    const pairIds = [nextPair.agent1Id, nextPair.agent2Id];
    let validPairMembers = 0;
    for (const agentId of pairIds) {
      if (this.camera.isAgentValidCameraCandidate(agentId)) {
        validPairMembers++;
        if (!contestantIds.has(agentId)) {
          ids.add(agentId);
        }
      }
    }

    if (validPairMembers < config.minAgents) {
      return new Set<string>();
    }

    return ids;
  }

  /** Get scheduler state for monitoring/debugging */
  getSchedulerState(): {
    state: "IDLE" | "WAITING_FOR_AGENTS" | "ACTIVE";
    availableAgents: number;
    requiredAgents: number;
    insufficientWarnings: number;
    currentPhase: StreamingPhase | null;
  } {
    return {
      state: this.schedulerState,
      availableAgents: this.matchmaking.availableAgents.size,
      requiredAgents: config.minAgents,
      insufficientWarnings: this.matchmaking.insufficientAgentWarningCount,
      currentPhase: this.currentCycle?.phase ?? null,
    };
  }

  /**
   * Ensure users + characters rows exist for a freshly spawned embedded sparbot.
   */
  private async ensureEmbeddedCharacterRowForSparbot(
    characterId: string,
    accountId: string,
    name: string,
  ): Promise<void> {
    const db = this.getDatabase();
    if (!db) {
      return;
    }
    const { users, characters } = await import("../../database/schema.js");
    const { eq } = await import("drizzle-orm");

    const existingRows = await db
      .select({ id: characters.id })
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      return;
    }

    const existingUsers = (await db
      .select()
      .from(users)
      .where(eq(users.id, accountId))) as Array<{ id: string }>;

    if (existingUsers.length === 0) {
      await db.insert(users).values({
        id: accountId,
        name,
        roles: "player",
        createdAt: new Date().toISOString(),
      });
    }

    await db.insert(characters).values({
      id: characterId,
      accountId,
      name,
      isAgent: 1,
      createdAt: Date.now(),
    });
  }

  /**
   * Director/debug: spawn (or reuse) an opponent and pin the next duel pair.
   */
  async queueDebugMatchup(params: {
    targetCharacterId: string;
    opponentCharacterId?: string;
    opponentName?: string;
    spawnOpponent: boolean;
    sparbotCombatStyle?: "auto" | "melee" | "ranged" | "mage" | "prayer";
  }): Promise<{
    mode: "spawned" | "existing";
    opponent: { characterId: string; name: string };
  }> {
    assertLocalDiagnosticContestantAuthority(process.env);
    const targetEntity = this.world.entities.get(params.targetCharacterId);
    if (!targetEntity) {
      throw new Error(`Target ${params.targetCharacterId} is not in the world`);
    }

    const { getAgentManager } = await import("../../eliza/index.js");
    const agentManager = getAgentManager();
    if (!agentManager) {
      throw new Error("Agent system not initialized");
    }

    let opponentId: string;
    let opponentName: string;

    if (params.spawnOpponent) {
      const diagnosticAvatarUrl = resolveStreamingDuelDiagnosticAvatarUrl(
        process.env,
      );
      opponentId = `sparbot-${uuidv4()}`;
      const accountId = `sparbot-account-${opponentId.slice(-24)}`;
      opponentName =
        params.opponentName?.trim() || `Sparbot ${opponentId.slice(-6)}`;

      await this.ensureEmbeddedCharacterRowForSparbot(
        opponentId,
        accountId,
        opponentName,
      );

      await agentManager.createAgent({
        characterId: opponentId,
        accountId,
        name: opponentName,
        scriptedRole: "combat",
        enableLlm: false,
        characterConfig: {
          name: opponentName,
          settings: {
            avatar: diagnosticAvatarUrl,
          },
        },
        autoStart: true,
      });

      this.debugSparbotSpawnIds.add(opponentId);

      if (
        params.sparbotCombatStyle === "melee" ||
        params.sparbotCombatStyle === "ranged" ||
        params.sparbotCombatStyle === "mage" ||
        params.sparbotCombatStyle === "prayer"
      ) {
        this.orchestrator.setDebugCombatRoleOverride(
          opponentId,
          params.sparbotCombatStyle,
        );
      }
    } else {
      if (!params.opponentCharacterId) {
        throw new Error(
          "opponentCharacterId is required when reusing an agent",
        );
      }
      opponentId = params.opponentCharacterId;
      const oppEntity = this.world.entities.get(opponentId);
      if (!oppEntity) {
        throw new Error(`Opponent ${opponentId} is not in the world`);
      }
      const data = oppEntity.data as { name?: string };
      opponentName = data.name ?? opponentId;
    }

    this.registerDiagnosticAgent(params.targetCharacterId);
    this.registerDiagnosticAgent(opponentId);

    this.matchmaking.nextDuelPair = {
      agent1Id: params.targetCharacterId,
      agent2Id: opponentId,
      selectedAt: Date.now(),
    };
    this.notifyOnDeckAgents();

    return {
      mode: params.spawnOpponent ? "spawned" : "existing",
      opponent: { characterId: opponentId, name: opponentName },
    };
  }

  // ============================================================================
  // Standalone Sparbot Management
  // ============================================================================

  private static readonly SPARBOT_NAME_POOL: readonly string[] = [
    "Ashthorn",
    "Bolvarg",
    "Cragfist",
    "Duskmantle",
    "Emberveil",
    "Frostknuckle",
    "Grimshaw",
    "Hollowbane",
    "Ironpelt",
    "Jadecut",
    "Kniveholt",
    "Lordshard",
    "Mireborn",
    "Nightbloom",
    "Oakhaven",
    "Pebblebrow",
    "Quickslag",
    "Ravenmere",
    "Stonescar",
    "Thistlevein",
    "Umbercleft",
    "Vaultbreaker",
    "Whetmark",
    "Xendral",
    "Yarrowcrest",
    "Zinderfall",
    "Axethane",
    "Blazewind",
    "Coppergrip",
    "Dreadclaw",
    "Edgeborn",
    "Flintmoss",
    "Gravelstep",
    "Harrowgate",
    "Ironveil",
    "Jaggrath",
    "Keldrath",
    "Lochfang",
    "Mossback",
    "Needlebrook",
    "Obsidius",
    "Pyrebrand",
    "Quakeshield",
    "Rustmantle",
    "Steelroot",
    "Thornvast",
    "Umbralux",
    "Voidshard",
    "Wraithcroft",
    "Yewmere",
  ];

  private pickSparbotName(): string {
    const used = new Set(
      [...this.standaloneSparbotMeta.values()].map((m) => m.name),
    );
    const available = StreamingDuelScheduler.SPARBOT_NAME_POOL.filter(
      (n) => !used.has(n),
    );
    const pool =
      available.length > 0
        ? available
        : StreamingDuelScheduler.SPARBOT_NAME_POOL;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * Generate skill levels for a standalone sparbot based on style and tier.
   * Adds variance (±5) so bots of the same tier feel distinct.
   */
  private static sparbotSkills(
    style: "melee" | "ranged" | "mage" | "prayer",
    tier: "novice" | "adept" | "expert",
    profileSeed?: number,
    multiStyle = false,
  ): {
    attackLevel: number;
    strengthLevel: number;
    defenseLevel: number;
    constitutionLevel: number;
    rangedLevel: number;
    magicLevel: number;
    prayerLevel: number;
    combatLevel: number;
  } {
    const base = tier === "novice" ? 35 : tier === "adept" ? 60 : 85;
    if (
      profileSeed != null &&
      (!Number.isSafeInteger(profileSeed) ||
        profileSeed < 0 ||
        profileSeed > 0xffffffff)
    ) {
      throw new Error(
        "Sparbot profile seed must be an unsigned 32-bit integer",
      );
    }
    let randomState = profileSeed == null ? null : profileSeed >>> 0;
    const random = () => {
      if (randomState == null) return Math.random();
      randomState = (randomState + 0x6d2b79f5) >>> 0;
      let value = randomState;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
    };
    const jitter = () => Math.floor(random() * 10) - 5; // ±5

    let atk = 1,
      str = 1,
      def = 1,
      con = 10,
      rng = 1,
      mag = 1,
      pry = 1;

    switch (style) {
      case "melee":
        atk = base + jitter();
        str = base + 5 + jitter();
        def = Math.floor(base * 0.7) + jitter();
        con = base + jitter();
        rng = 1;
        mag = 1;
        pry = Math.floor(base * 0.2);
        break;
      case "ranged":
        rng = base + 5 + jitter();
        def = Math.floor(base * 0.6) + jitter();
        con = base + jitter();
        atk = 1;
        str = 1;
        mag = 1;
        pry = Math.floor(base * 0.2);
        break;
      case "mage":
        mag = base + 5 + jitter();
        def = Math.floor(base * 0.7) + jitter();
        con = base + jitter();
        atk = 1;
        str = 1;
        rng = 1;
        pry = Math.floor(base * 0.75) + jitter();
        break;
      case "prayer":
        pry = base + 5 + jitter();
        str = base + jitter();
        atk = Math.floor(base * 0.8) + jitter();
        def = Math.floor(base * 0.8) + jitter();
        con = base + jitter();
        rng = 1;
        mag = 1;
        break;
    }

    // The explicit local multi-style lane exists to exercise real tactical
    // switching, not to make a specialist fight at level-one proficiency in
    // two thirds of its frozen loadouts. Give these diagnostic contestants a
    // balanced authored profile so each committed role remains viable. Public
    // contestants still use their persisted, trained skills unchanged.
    if (multiStyle) {
      atk = base + jitter();
      str = base + 5 + jitter();
      rng = base + 5 + jitter();
      mag = base + 5 + jitter();
      def = Math.floor(base * 0.7) + jitter();
      con = base + jitter();
      pry = Math.floor(base * 0.75) + jitter();
    }

    const clamp = (v: number, min = 1, max = 99) =>
      Math.max(min, Math.min(max, v));
    atk = clamp(atk);
    str = clamp(str);
    def = clamp(def);
    con = clamp(con, 10);
    rng = clamp(rng);
    mag = clamp(mag);
    pry = clamp(pry);

    const combatLevel = calculateCombatLevel({
      attack: atk,
      strength: str,
      defense: def,
      hitpoints: con,
      ranged: rng,
      magic: mag,
      prayer: pry,
    });
    return {
      attackLevel: atk,
      strengthLevel: str,
      defenseLevel: def,
      constitutionLevel: con,
      rangedLevel: rng,
      magicLevel: mag,
      prayerLevel: pry,
      combatLevel,
    };
  }

  /** Upsert skill stats into the characters table for a standalone sparbot. */
  private async seedSparbotStats(
    characterId: string,
    skills: ReturnType<typeof StreamingDuelScheduler.sparbotSkills>,
  ): Promise<void> {
    const db = this.getDatabase();
    if (!db) return;
    const { characters } = await import("../../database/schema.js");
    const { eq } = await import("drizzle-orm");
    const pp = Math.min(99, Math.max(1, skills.prayerLevel * 10));
    await db
      .update(characters)
      .set({
        combatLevel: skills.combatLevel,
        attackLevel: skills.attackLevel,
        strengthLevel: skills.strengthLevel,
        defenseLevel: skills.defenseLevel,
        constitutionLevel: skills.constitutionLevel,
        rangedLevel: skills.rangedLevel,
        magicLevel: skills.magicLevel,
        prayerLevel: skills.prayerLevel,
        attackXp: sparbotSkillXpForLevel(skills.attackLevel),
        strengthXp: sparbotSkillXpForLevel(skills.strengthLevel),
        defenseXp: sparbotSkillXpForLevel(skills.defenseLevel),
        constitutionXp: sparbotSkillXpForLevel(skills.constitutionLevel),
        rangedXp: sparbotSkillXpForLevel(skills.rangedLevel),
        magicXp: sparbotSkillXpForLevel(skills.magicLevel),
        prayerXp: sparbotSkillXpForLevel(skills.prayerLevel),
        health: skills.constitutionLevel,
        maxHealth: skills.constitutionLevel,
        prayerPoints: pp,
        prayerPointUnits: pp * 1_000_000,
        prayerMaxPoints: pp,
        activePrayers: [],
      })
      .where(eq(characters.id, characterId));
  }

  /**
   * Apply a generated sparbot profile to the already-spawned world entity.
   *
   * Streaming agents normally use a DB-free spawn path so capture startup is
   * not coupled to persistence latency. Standalone sparbots already have their
   * generated profile in memory, so relying on a second DB read here would both
   * waste work and silently leave the live fighter at the level-1/10-HP
   * fallback. Keep the entity, health component, observers, and persisted row
   * on the same generated profile before the bot enters matchmaking.
   */
  private applySparbotStatsToWorldEntity(
    characterId: string,
    skills: ReturnType<typeof StreamingDuelScheduler.sparbotSkills>,
  ): void {
    const entity = this.world.entities.get(characterId) as
      | {
          data?: {
            skills?: Record<string, { level: number; xp: number }>;
            health?: number;
            maxHealth?: number;
            combatLevel?: number;
            level?: number;
          };
          setHealthAndMaxHealth?: (health: number, maxHealth: number) => void;
          getComponent?: (name: string) => {
            data?: Record<string, unknown>;
          } | null;
          updateFromPlayerData?: (player: {
            skills: Record<string, { level: number; xp: number }>;
          }) => void;
          markNetworkDirty?: () => void;
        }
      | undefined;
    const data = entity?.data;
    if (!entity || !data) {
      throw new Error(
        `Standalone sparbot ${characterId} did not produce a world entity`,
      );
    }

    const previousSkills = data.skills ?? {};
    const nonCombatSkillNames = [
      "woodcutting",
      "mining",
      "fishing",
      "firemaking",
      "cooking",
      "smithing",
      "agility",
      "crafting",
      "fletching",
      "runecrafting",
    ] as const;
    const nextSkills: Record<string, { level: number; xp: number }> = {};
    for (const skillName of nonCombatSkillNames) {
      nextSkills[skillName] = previousSkills[skillName] ?? {
        level: 1,
        xp: 0,
      };
    }
    const levels = {
      attack: skills.attackLevel,
      strength: skills.strengthLevel,
      defense: skills.defenseLevel,
      constitution: skills.constitutionLevel,
      ranged: skills.rangedLevel,
      magic: skills.magicLevel,
      prayer: skills.prayerLevel,
    } as const;
    for (const [skillName, level] of Object.entries(levels)) {
      nextSkills[skillName] = {
        level,
        xp: sparbotSkillXpForLevel(level),
      };
    }

    data.skills = nextSkills;
    data.combatLevel = skills.combatLevel;
    data.level = skills.combatLevel;
    entity.updateFromPlayerData?.({ skills: nextSkills });

    const statsComponent = entity.getComponent?.("stats");
    if (statsComponent?.data) {
      for (const [skillName, skill] of Object.entries(nextSkills)) {
        const existing = statsComponent.data[skillName];
        statsComponent.data[skillName] = {
          ...(typeof existing === "object" && existing !== null
            ? existing
            : {}),
          ...skill,
        };
      }
      statsComponent.data.combatLevel = skills.combatLevel;
      statsComponent.data.level = skills.combatLevel;
      statsComponent.data.totalLevel = Object.values(nextSkills).reduce(
        (total, skill) => total + skill.level,
        0,
      );
      statsComponent.data.health = {
        current: skills.constitutionLevel,
        max: skills.constitutionLevel,
      };
      const hitpoints = statsComponent.data.hitpoints;
      statsComponent.data.hitpoints = {
        ...(typeof hitpoints === "object" && hitpoints !== null
          ? hitpoints
          : {}),
        level: skills.constitutionLevel,
        xp: nextSkills.constitution.xp,
        current: skills.constitutionLevel,
        max: skills.constitutionLevel,
      };
    }

    if (entity.setHealthAndMaxHealth) {
      entity.setHealthAndMaxHealth(
        skills.constitutionLevel,
        skills.constitutionLevel,
      );
    } else {
      data.health = skills.constitutionLevel;
      data.maxHealth = skills.constitutionLevel;
      const healthComponent = entity.getComponent?.("health");
      if (healthComponent?.data) {
        healthComponent.data.current = skills.constitutionLevel;
        healthComponent.data.max = skills.constitutionLevel;
        healthComponent.data.isDead = false;
      }
    }

    entity.markNetworkDirty?.();
    this.world.emit(EventType.SKILLS_UPDATED, {
      playerId: characterId,
      skills: nextSkills,
    });
    this.world.emit(EventType.ENTITY_MODIFIED, {
      id: characterId,
      changes: {
        skills: nextSkills,
        health: skills.constitutionLevel,
        maxHealth: skills.constitutionLevel,
        combatLevel: skills.combatLevel,
        level: skills.combatLevel,
      },
    });
  }

  /** Spawn standalone sparbots and add them to the matchmaking pool. */
  async spawnStandaloneSparbots(
    count: number,
    style: "melee" | "ranged" | "mage" | "prayer",
    tier: "novice" | "adept" | "expert" = "adept",
    customNames?: string[],
    multiStyle = false,
    profileSeed?: number,
  ): Promise<Array<{ characterId: string; name: string; tier: string }>> {
    assertLocalDiagnosticContestantAuthority(process.env);
    const { getAgentManager } = await import("../../eliza/index.js");
    const agentManager = getAgentManager();
    if (!agentManager) {
      throw new Error("Agent system not initialized");
    }
    if (
      multiStyle &&
      (style === "prayer" || !isLocalDiagnosticDuelRuntime(process.env))
    ) {
      throw new Error(
        "Multi-style sparbots require a melee/ranged/mage opening inside the explicit loopback no-money diagnostic boundary",
      );
    }
    if (
      profileSeed != null &&
      (!Number.isSafeInteger(profileSeed) ||
        profileSeed < 0 ||
        profileSeed > 0xffffffff ||
        !isLocalDiagnosticDuelRuntime(process.env))
    ) {
      throw new Error(
        "A sparbot profile seed requires an unsigned 32-bit value inside the explicit loopback no-money diagnostic boundary",
      );
    }
    const diagnosticAvatarUrl = resolveStreamingDuelDiagnosticAvatarUrl(
      process.env,
    );

    const spawned: Array<{ characterId: string; name: string; tier: string }> =
      [];

    for (let i = 0; i < count; i++) {
      const characterId = multiStyle
        ? `sparbot-standalone-multi-${uuidv4()}`
        : `sparbot-standalone-${uuidv4()}`;
      const accountId = `sparbot-account-${characterId.slice(-24)}`;
      const name =
        customNames?.[i]?.trim() ||
        `${this.pickSparbotName()} ${style.charAt(0).toUpperCase() + style.slice(1)}`;

      await this.ensureEmbeddedCharacterRowForSparbot(
        characterId,
        accountId,
        name,
      );

      const skills = StreamingDuelScheduler.sparbotSkills(
        style,
        tier,
        profileSeed,
        multiStyle,
      );
      await this.seedSparbotStats(characterId, skills);

      await agentManager.createAgent({
        characterId,
        accountId,
        name,
        scriptedRole: "combat",
        enableLlm: false,
        characterConfig: {
          name,
          settings: { avatar: diagnosticAvatarUrl },
        },
        autoStart: true,
      });

      this.applySparbotStatsToWorldEntity(characterId, skills);

      // Pool sparbots exist only to participate in scheduled arena fights.
      // Keep the general quest/exploration behavior bridge dormant between
      // cycles; DuelCombatAI owns them during a fight and the orchestrator
      // restores this disabled baseline afterward.
      agentManager
        .getAgentService(characterId)
        ?.setAutonomousBehaviorEnabled(false);

      this.orchestrator.setDebugCombatRoleOverride(characterId, style);
      this.orchestrator.setDiagnosticMultiStyleAllowed(characterId, multiStyle);
      this.standaloneSparbotIds.add(characterId);
      this.standaloneSparbotMeta.set(characterId, {
        name,
        style,
        tier,
        multiStyle,
      });

      this.registerDiagnosticAgent(characterId);

      spawned.push({ characterId, name, tier });
    }

    return spawned;
  }

  /**
   * Start a production-shaped, two-agent harpoon preparation scene for the
   * supervised stream. This deliberately uses the real inventory, resource,
   * skill, terrain, replication, and camera paths. It is unavailable unless
   * the server is inside the explicit loopback/no-money diagnostic boundary
   * and operator maintenance is holding the duel scheduler.
   */
  private async ensureDiagnosticPreparationSession(
    characterIds: readonly [string, string],
  ): Promise<DuelPreparationSnapshot> {
    const store = this.preparationStore;
    const fencingToken = this.preparationFencingToken;
    if (!store || !fencingToken || this.preparationDurationMs === null) {
      throw new Error(
        "Harpoon preparation diagnostics require durable preparation authority; configure STREAMING_DUEL_PREPARATION_MS and the fenced PostgreSQL scheduler",
      );
    }

    if (!this.competitiveRecoveryChecked) {
      const recovery = await this.recoverFrozenCompetitiveSnapshot(Date.now());
      if (recovery !== "none") {
        throw new Error(
          `Harpoon preparation diagnostics cannot supersede competitive recovery (${recovery})`,
        );
      }
      this.competitiveRecoveryChecked = true;
    }

    const expired = await store.expire();
    if (
      this.onDeckPreparation &&
      expired.some(
        (entry) =>
          entry.preparationId === this.onDeckPreparation?.preparationId,
      )
    ) {
      const expiredId = this.onDeckPreparation.preparationId;
      this.onDeckPreparation = null;
      this.onDeckPreparationPairKey = null;
      this.clearPublicPreparationActivities(expiredId);
      this.world.emit("duel:preparation:expired", {
        preparationId: expiredId,
        occurredAt: Date.now(),
      });
    }

    let active = this.onDeckPreparation ?? (await store.getActive());
    if (active) {
      const requested = new Set(characterIds);
      const samePair =
        requested.size === 2 &&
        requested.has(active.agent1Id) &&
        requested.has(active.agent2Id);
      if (!samePair) {
        throw new Error(
          "Harpoon preparation diagnostics cannot supersede another active preparation",
        );
      }
      this.matchmaking.nextDuelPair = {
        agent1Id: active.agent1Id,
        agent2Id: active.agent2Id,
        selectedAt: active.selectedAt,
      };
      this.onDeckPreparation = active;
      this.onDeckPreparationPairKey = `${active.agent1Id}\u0000${active.agent2Id}`;
      if (
        this.publicPreparationActivities?.preparationId !== active.preparationId
      ) {
        active = await this.emitOnDeckPreparationSelected(active);
        this.onDeckPreparation = active;
      }
      return active;
    }

    const pair = {
      agent1Id: characterIds[0],
      agent2Id: characterIds[1],
      selectedAt: Date.now(),
    };
    this.matchmaking.nextDuelPair = pair;
    await this.beginOnDeckPreparation(pair);
    active = this.onDeckPreparation;
    if (
      !active ||
      active.agent1Id !== pair.agent1Id ||
      active.agent2Id !== pair.agent2Id ||
      (active.status !== "preparing" && active.status !== "ready")
    ) {
      throw new Error(
        "Harpoon preparation diagnostics could not establish the authoritative preparation session",
      );
    }
    return active;
  }

  private publishDiagnosticPreparationActivity(
    preparationId: string,
    agentId: string,
    activity: StreamingDuelPublicPreparationActivity,
    mode: StreamingDuelPublicPreparationMode = "working",
  ): void {
    const preparation = this.onDeckPreparation;
    const activities = this.publicPreparationActivities;
    if (
      !preparation ||
      preparation.preparationId !== preparationId ||
      (preparation.agent1Id !== agentId && preparation.agent2Id !== agentId) ||
      !activities ||
      activities.preparationId !== preparationId
    ) {
      throw new Error(
        "Harpoon preparation activity lost its authoritative preparation session",
      );
    }
    const revision = (activities.agents.get(agentId)?.revision ?? 0) + 1;
    const payload = {
      preparationId,
      agentId,
      activity,
      mode,
      occurredAt: Date.now(),
      revision,
    };
    // Accept through the same strict validator synchronously before notifying
    // other server consumers. The scheduler's ordinary world listener sees the
    // duplicate revision and ignores it, so publication is deterministic even
    // when a test harness or shutdown boundary has no listener installed.
    this.handlePreparationPublicActivity(payload);
    this.world.emit("duel:preparation:public_activity", payload);
    const published = activities.agents.get(agentId);
    if (
      published?.revision !== revision ||
      published.activity !== activity ||
      published.mode !== mode
    ) {
      throw new Error(
        "Harpoon preparation activity was not accepted by the revision-fenced public contract",
      );
    }
  }

  async startDiagnosticHarpoonPreparation(
    requestedCharacterIds?: string[],
  ): Promise<{
    publicPreparation: StreamingDuelPreparationSummary;
    resource: {
      id: string;
      variant: "fishing_spot_harpoon";
      position: DiagnosticPreparationPosition;
    };
    agents: Array<{
      characterId: string;
      position: DiagnosticPreparationPosition;
      fishingLevel: number;
      harpoonQuantity: number;
      gatheringToolPresentation: unknown;
      fishingInteractionPresentation: unknown;
    }>;
  }> {
    if (!isLocalDiagnosticDuelRuntime(process.env)) {
      throw new Error(
        "Harpoon preparation diagnostics require the explicit loopback no-money boundary",
      );
    }
    if (process.env.STREAMING_DUEL_MAINTENANCE_MODE !== "true") {
      throw new Error(
        "Harpoon preparation diagnostics require operator-held duel maintenance",
      );
    }
    if (this.currentCycle) {
      throw new Error(
        "Harpoon preparation diagnostics cannot start during an active duel cycle",
      );
    }

    const characterIds =
      requestedCharacterIds == null
        ? [...this.standaloneSparbotIds].slice(0, 2)
        : requestedCharacterIds.map((id) => id.trim()).filter(Boolean);
    if (characterIds.length !== 2 || new Set(characterIds).size !== 2) {
      throw new Error(
        "Harpoon preparation diagnostics require exactly two distinct sparbots",
      );
    }
    for (const characterId of characterIds) {
      if (!this.standaloneSparbotIds.has(characterId)) {
        throw new Error(
          `Harpoon preparation contestant is not a standalone sparbot: ${characterId}`,
        );
      }
    }

    const resourceSystem = this.world.getSystem("resource") as {
      getAvailableResourceByVariant?: (variant: string) =>
        | {
            id: string;
            position: { x: number; y: number; z: number };
          }
        | undefined;
    } | null;
    const resource = resourceSystem?.getAvailableResourceByVariant?.(
      "fishing_spot_harpoon",
    );
    const resourcePosition = this.orchestrator.normalizePosition(
      resource?.position,
    );
    if (!resource || !resourcePosition) {
      throw new Error(
        "No available live fishing_spot_harpoon resource is registered",
      );
    }

    const terrain = this.world.getSystem(
      "terrain",
    ) as DiagnosticPreparationTerrain | null;
    if (!terrain) {
      throw new Error("Harpoon preparation requires the terrain system");
    }
    const positions = selectDiagnosticHarpoonPreparationPositions(
      resourcePosition,
      terrain,
    );
    const inventorySystem = this.world.getSystem("inventory") as {
      getInventory?: (playerId: string) => {
        items?: Array<{ itemId?: string; quantity?: number }>;
      };
      addItemDirect?: (
        playerId: string,
        item: { itemId: string; quantity: number },
      ) => Promise<boolean>;
    } | null;
    if (
      typeof inventorySystem?.getInventory !== "function" ||
      typeof inventorySystem.addItemDirect !== "function"
    ) {
      throw new Error("Harpoon preparation requires inventory authority");
    }

    const diagnosticPreparation = await this.ensureDiagnosticPreparationSession(
      characterIds as [string, string],
    );
    const resultAgents: Array<{
      characterId: string;
      position: DiagnosticPreparationPosition;
      fishingLevel: number;
      harpoonQuantity: number;
      gatheringToolPresentation: unknown;
      fishingInteractionPresentation: unknown;
    }> = [];
    try {
      for (let index = 0; index < characterIds.length; index += 1) {
        const characterId = characterIds[index];
        const position = positions[index];
        if (!characterId || !position) continue;
        const entity = this.world.entities.get(characterId) as {
          data?: {
            skills?: Record<string, { level: number; xp: number }>;
            gatheringToolPresentation?: unknown;
            fishingInteractionPresentation?: unknown;
          };
          getComponent?: (name: string) => {
            data?: Record<string, unknown>;
          } | null;
          updateFromPlayerData?: (player: {
            skills: Record<string, { level: number; xp: number }>;
          }) => void;
          markNetworkDirty?: () => void;
        } | null;
        if (!entity?.data) {
          throw new Error(
            `Harpoon preparation contestant has no live entity: ${characterId}`,
          );
        }

        const nextSkills = {
          ...(entity.data.skills ?? {}),
          fishing: {
            level: 50,
            xp: Math.max(entity.data.skills?.fishing?.xp ?? 0, 101_333),
          },
        };
        entity.data.skills = nextSkills;
        entity.updateFromPlayerData?.({ skills: nextSkills });
        const statsComponent = entity.getComponent?.("stats");
        if (statsComponent?.data) {
          const existingFishing = statsComponent.data.fishing;
          statsComponent.data.fishing = {
            ...(typeof existingFishing === "object" && existingFishing !== null
              ? existingFishing
              : {}),
            ...nextSkills.fishing,
          };
        }
        entity.markNetworkDirty?.();
        this.world.emit(EventType.SKILLS_UPDATED, {
          playerId: characterId,
          skills: nextSkills,
        });
        this.world.emit(EventType.ENTITY_MODIFIED, {
          id: characterId,
          changes: { skills: nextSkills },
        });

        const inventoryBefore = inventorySystem.getInventory(characterId);
        const existingHarpoonQuantity = (inventoryBefore?.items ?? []).reduce(
          (total, item) =>
            item.itemId === "harpoon" ? total + (item.quantity ?? 0) : total,
          0,
        );
        if (existingHarpoonQuantity < 1) {
          const added = await inventorySystem.addItemDirect(characterId, {
            itemId: "harpoon",
            quantity: 1,
          });
          if (!added) {
            throw new Error(
              `Could not provision the diagnostic harpoon for ${characterId}`,
            );
          }
        }

        this.orchestrator.teleportPlayer(
          characterId,
          position,
          resourcePosition,
          true,
        );
        this.world.emit(EventType.RESOURCE_GATHER, {
          playerId: characterId,
          resourceId: resource.id,
          playerPosition: {
            x: position[0],
            y: position[1],
            z: position[2],
          },
        });

        const inventoryAfter = inventorySystem.getInventory(characterId);
        const harpoonQuantity = (inventoryAfter?.items ?? []).reduce(
          (total, item) =>
            item.itemId === "harpoon" ? total + (item.quantity ?? 0) : total,
          0,
        );
        if (
          entity.data.gatheringToolPresentation == null ||
          entity.data.fishingInteractionPresentation == null
        ) {
          throw new Error(
            `Live resource authority did not publish harpoon preparation for ${characterId}`,
          );
        }
        this.publishDiagnosticPreparationActivity(
          diagnosticPreparation.preparationId,
          characterId,
          "gathering",
        );
        resultAgents.push({
          characterId,
          position,
          fishingLevel: nextSkills.fishing.level,
          harpoonQuantity,
          gatheringToolPresentation: entity.data.gatheringToolPresentation,
          fishingInteractionPresentation:
            entity.data.fishingInteractionPresentation,
        });
      }
    } catch (error) {
      await this.cancelOnDeckPreparation("diagnostic_preparation_failed");
      throw error;
    }

    const publicPreparation = this.getPublicPreparationSummary(
      Date.now(),
      diagnosticPreparation.agent1Id,
      diagnosticPreparation.agent2Id,
    );
    if (!publicPreparation) {
      await this.cancelOnDeckPreparation("diagnostic_preparation_failed");
      throw new Error(
        "Harpoon preparation diagnostics did not publish the authoritative public preparation summary",
      );
    }
    this.broadcastState();
    return {
      publicPreparation,
      resource: {
        id: resource.id,
        variant: "fishing_spot_harpoon",
        position: resourcePosition,
      },
      agents: resultAgents,
    };
  }

  /** Live bounded diagnostics for the authoritative arena combat controllers. */
  getCombatAIDiagnostics() {
    return this.orchestrator.getCombatAIDiagnostics();
  }

  /** List active standalone sparbots. */
  listStandaloneSparbots(): Array<{
    characterId: string;
    name: string;
    style: string;
    tier: string;
    multiStyle: boolean;
  }> {
    return [...this.standaloneSparbotIds].map((id) => {
      const meta = this.standaloneSparbotMeta.get(id);
      return {
        characterId: id,
        name: meta?.name ?? id,
        style: meta?.style ?? "melee",
        tier: meta?.tier ?? "adept",
        multiStyle: meta?.multiStyle ?? false,
      };
    });
  }

  /** Remove standalone sparbots (all if ids omitted). Returns count removed. */
  async removeStandaloneSparbots(ids?: string[]): Promise<number> {
    const { getAgentManager } = await import("../../eliza/index.js");
    const agentManager = getAgentManager();
    const targets = ids
      ? ids.filter((id) => this.standaloneSparbotIds.has(id))
      : [...this.standaloneSparbotIds];

    let removed = 0;
    for (const id of targets) {
      try {
        const cycle = this.currentCycle;
        const waitForAnnouncementCancellation =
          cycle?.phase === "ANNOUNCEMENT" &&
          (cycle.agent1?.characterId === id ||
            cycle.agent2?.characterId === id);

        // Notify the scheduler before tearing down the entity. In particular,
        // this lets an ANNOUNCEMENT cancellation restore its frozen loadout
        // without racing EquipmentSystem cleanup.
        this.matchmaking.unregisterAgent(id);
        if (waitForAnnouncementCancellation) {
          await this.pendingTerminalTransition;
          await this.pendingCycleCleanup;
        }
        if (agentManager) {
          await agentManager.removeAgent(id);
        }
        this.orchestrator.clearDebugCombatRoleOverride(id);
        this.standaloneSparbotIds.delete(id);
        this.standaloneSparbotMeta.delete(id);
        removed++;
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `removeStandaloneSparbots(${id}): ${errMsg(err)}`,
        );
      }
    }
    return removed;
  }

  /** Remove embedded spar bots spawned via queueDebugMatchup (spawn mode). */
  async cleanupDebugSpawnedSparbots(): Promise<number> {
    const { getAgentManager } = await import("../../eliza/index.js");
    const agentManager = getAgentManager();
    let removed = 0;
    for (const id of [...this.debugSparbotSpawnIds]) {
      try {
        if (agentManager) {
          await agentManager.removeAgent(id);
        }
        this.matchmaking.unregisterAgent(id);
        removed++;
      } catch (err) {
        Logger.warn(
          "StreamingDuelScheduler",
          `cleanupDebugSpawnedSparbots(${id}): ${errMsg(err)}`,
        );
      }
    }
    this.debugSparbotSpawnIds.clear();
    return removed;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

let streamingSchedulerInstance: StreamingDuelScheduler | null = null;

/** Initialize the streaming duel scheduler */
export async function initStreamingDuelScheduler(
  world: World,
  options: { fencingToken?: string } = {},
): Promise<StreamingDuelScheduler> {
  if (streamingSchedulerInstance) {
    await destroyStreamingDuelScheduler("scheduler_replaced");
  }

  const scheduler = new StreamingDuelScheduler(world, options);
  streamingSchedulerInstance = scheduler;
  try {
    await scheduler.primeCompetitiveRecoveryCustodyHolds();
    scheduler.init();
  } catch (error) {
    if (streamingSchedulerInstance === scheduler) {
      streamingSchedulerInstance = null;
    }
    scheduler.destroy("scheduler_start_failed");
    await scheduler.waitForShutdownCleanup();
    throw error;
  }

  return scheduler;
}

/** Get the streaming duel scheduler instance */
export function getStreamingDuelScheduler(): StreamingDuelScheduler | null {
  return streamingSchedulerInstance;
}

/** Destroy and clear the singleton so health/read paths cannot see a stopped scheduler. */
export async function destroyStreamingDuelScheduler(
  cancellationReason = "scheduler_shutdown",
): Promise<void> {
  const scheduler = streamingSchedulerInstance;
  scheduler?.destroy(cancellationReason);
  await scheduler?.waitForShutdownCleanup();
  // Keep the stopped instance reachable until its durable terminal barrier has
  // emitted. Internal betting listeners need that exact cycle snapshot to
  // publish the cancellation before shutdown tears down their SSE clients.
  if (streamingSchedulerInstance === scheduler) {
    streamingSchedulerInstance = null;
  }
}
