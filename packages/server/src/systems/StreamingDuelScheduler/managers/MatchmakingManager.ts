/**
 * MatchmakingManager - Agent registration, stats, pair selection, and leaderboard logic
 *
 * Extracted from StreamingDuelScheduler to isolate matchmaking concerns.
 */

import {
  calculateCombatLevel,
  parseStreamingDuelActionObservation,
  type World,
} from "@hyperforge/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Logger } from "../../ServerNetwork/services/index.js";
import { MAX_DUEL_PREPARATION_OPPONENT_HISTORY } from "../types.js";
import type { CompetitiveSnapshot } from "../competitive-snapshot.js";
import { normalizePersistedCompetitiveOutcome } from "../competitive-outcome.js";
import type {
  DuelPreparationOpponentHistoryEntry,
  LeaderboardEntry,
  RecentDuelEntry,
  SwitchableStreamingCombatRole,
} from "../types.js";

// ============================================================================
// Types
// ============================================================================

export type NextDuelPair = {
  agent1Id: string;
  agent2Id: string;
  selectedAt: number;
};

export type AgentStatsEntry = {
  characterId: string;
  name: string;
  provider: string;
  model: string;
  wins: number;
  losses: number;
  draws: number;
  combatLevel: number;
  currentStreak: number;
};

type MatchmakingConfig = {
  minAgents: number;
  maxRecentDuels: number;
  persistStatsToDatabase: boolean;
  maxAgentStats: number;
  insufficientAgentsRetryInterval: number;
  maxInsufficientAgentWarnings: number;
};

type PersistedDuelHistoryRow = Record<string, unknown>;
export { normalizePersistedCompetitiveOutcome } from "../competitive-outcome.js";

const STREAMING_DUEL_WIN_REASONS = new Set([
  "kill",
  "forfeit",
  "hp_advantage",
  "damage_advantage",
]);

const STREAMING_COMBAT_ROLES = new Set<SwitchableStreamingCombatRole>([
  "melee",
  "ranged",
  "mage",
]);

const nullableString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const damageValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const nullableDamageValue = (value: unknown): number | null =>
  value == null ? null : damageValue(value);

const nullableCombatRole = (
  value: unknown,
): SwitchableStreamingCombatRole | null =>
  STREAMING_COMBAT_ROLES.has(value as SwitchableStreamingCombatRole)
    ? (value as SwitchableStreamingCombatRole)
    : null;

/**
 * Convert a database row into the strict API history contract.
 *
 * Rows written before draw support did not carry an outcome, so a missing
 * outcome is treated as the legacy `win` shape. Malformed or unknown terminal
 * records are rejected instead of being exposed through the public/admin APIs.
 */
export function normalizePersistedRecentDuel(
  value: unknown,
): RecentDuelEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as PersistedDuelHistoryRow;
  const cycleId = nullableString(row.cycleId);
  const finishedAt = row.finishedAt;
  const rawOutcome = row.outcome == null ? "win" : row.outcome;

  if (
    !cycleId ||
    typeof finishedAt !== "number" ||
    !Number.isFinite(finishedAt) ||
    finishedAt < 0 ||
    (rawOutcome !== "win" &&
      rawOutcome !== "draw" &&
      rawOutcome !== "cancelled")
  ) {
    return null;
  }

  const duelId = nullableString(row.duelId);
  const storedAgent1Id = nullableString(row.agent1Id);
  const storedAgent2Id = nullableString(row.agent2Id);

  if (rawOutcome === "cancelled") {
    const cancellationReason = nullableString(row.cancellationReason);
    if (!cancellationReason) return null;
    return {
      cycleId,
      duelId,
      finishedAt,
      outcome: "cancelled",
      agent1Id: storedAgent1Id,
      agent1Name: nullableString(row.agent1Name),
      agent1OpeningStyle: nullableCombatRole(row.agent1OpeningStyle),
      agent2Id: storedAgent2Id,
      agent2Name: nullableString(row.agent2Name),
      agent2OpeningStyle: nullableCombatRole(row.agent2OpeningStyle),
      winnerId: null,
      winnerName: null,
      loserId: null,
      loserName: null,
      winReason: null,
      cancellationReason,
      damageAgent1: damageValue(row.damageAgent1),
      damageAgent2: damageValue(row.damageAgent2),
      damageWinner: null,
      damageLoser: null,
    };
  }

  if (rawOutcome === "draw") {
    if (!storedAgent1Id || !storedAgent2Id) return null;
    return {
      cycleId,
      duelId,
      finishedAt,
      outcome: "draw",
      agent1Id: storedAgent1Id,
      agent1Name: nullableString(row.agent1Name) ?? storedAgent1Id,
      agent1OpeningStyle: nullableCombatRole(row.agent1OpeningStyle),
      agent2Id: storedAgent2Id,
      agent2Name: nullableString(row.agent2Name) ?? storedAgent2Id,
      agent2OpeningStyle: nullableCombatRole(row.agent2OpeningStyle),
      winnerId: null,
      winnerName: null,
      loserId: null,
      loserName: null,
      winReason: "draw",
      cancellationReason: null,
      damageAgent1: damageValue(row.damageAgent1),
      damageAgent2: damageValue(row.damageAgent2),
      damageWinner: null,
      damageLoser: null,
    };
  }

  const winnerId = nullableString(row.winnerId);
  const loserId = nullableString(row.loserId);
  const winReason = nullableString(row.winReason);
  // A rolled-back pre-0055 binary still writes the original winner/loser-only
  // shape after the additive migration. Preserve read compatibility by using
  // those columns as the historical participant ordering when needed.
  const agent1Id = storedAgent1Id ?? winnerId;
  const agent2Id = storedAgent2Id ?? loserId;
  if (
    !winnerId ||
    !loserId ||
    !agent1Id ||
    !agent2Id ||
    !winReason ||
    !STREAMING_DUEL_WIN_REASONS.has(winReason)
  ) {
    return null;
  }

  return {
    cycleId,
    duelId,
    finishedAt,
    outcome: "win",
    agent1Id,
    agent1Name:
      nullableString(row.agent1Name) ??
      (agent1Id === winnerId ? nullableString(row.winnerName) : null) ??
      agent1Id,
    agent1OpeningStyle: nullableCombatRole(row.agent1OpeningStyle),
    agent2Id,
    agent2Name:
      nullableString(row.agent2Name) ??
      (agent2Id === loserId ? nullableString(row.loserName) : null) ??
      agent2Id,
    agent2OpeningStyle: nullableCombatRole(row.agent2OpeningStyle),
    winnerId,
    winnerName: nullableString(row.winnerName) ?? winnerId,
    loserId,
    loserName: nullableString(row.loserName) ?? loserId,
    winReason: winReason as RecentDuelEntry["winReason"],
    cancellationReason: null,
    damageAgent1:
      storedAgent1Id == null
        ? damageValue(row.damageWinner)
        : damageValue(row.damageAgent1),
    damageAgent2:
      storedAgent2Id == null
        ? damageValue(row.damageLoser)
        : damageValue(row.damageAgent2),
    damageWinner: nullableDamageValue(row.damageWinner),
    damageLoser: nullableDamageValue(row.damageLoser),
  };
}

/**
 * Callback interface for the scheduler to provide context-dependent data
 * and handle side effects that live outside the matchmaking domain.
 */
type MatchmakingCallbacks = {
  /** Returns the set of contestant IDs for the current active cycle */
  getCycleContestantIds: () => Set<string>;
  /** Returns the current cycle's agent data for damage stats during persistence */
  getCurrentCycleAgentDamage: (
    characterId: string,
  ) => { damageDealtThisFight: number } | null;
  /** Called when an agent registers so the scheduler can initialize camera activity */
  onAgentRegistered?: (agentId: string, now: number) => void;
  /** Called when an agent unregisters so the scheduler can handle forfeit logic */
  onAgentUnregistered?: (agentId: string) => void;
  /** Called when the pre-selected next duel pair changes (new pair or cleared) */
  onNextDuelPairChanged?: (pair: NextDuelPair | null) => void;
};

// ============================================================================
// MatchmakingManager
// ============================================================================

export class MatchmakingManager {
  /** Available agents for dueling */
  availableAgents: Set<string> = new Set();

  /**
   * Agent IDs opted out of streaming duels (DB `streaming_duel_enabled = false`).
   * Enforced by registerAgent until trusted persisted/API authority clears it.
   */
  private streamingDuelOptOut: Set<string> = new Set();

  /** Agent stats for leaderboard */
  agentStats: Map<string, AgentStatsEntry> = new Map();

  /** Last-seen timestamps for agent stat pruning */
  agentStatsLastSeenAt: Map<string, number> = new Map();

  /**
   * A competitive snapshot must never advertise the zero-value registration
   * placeholder while its persisted record is still loading. Successful
   * hydrations are memoized; failures remain retryable and fail the private
   * preparation gate closed.
   */
  private hydratedAgentStats: Set<string> = new Set();
  private pendingAgentStatsHydrations: Map<string, Promise<void>> = new Map();
  private agentStatsHydrationGeneration = 0;

  /** Recent completed duel history (newest first) */
  recentDuels: RecentDuelEntry[] = [];

  /** Invalidates an in-flight database hydration when reset or superseded. */
  private recentDuelHydrationGeneration = 0;

  /** Cached leaderboard — only recomputed when stats change */
  cachedLeaderboard: LeaderboardEntry[] = [];
  leaderboardDirty = true;

  /** Preselected pair for the upcoming cycle */
  nextDuelPair: NextDuelPair | null = null;

  /**
   * Temporary retry boundary for agents whose selected-contestant preparation
   * failed. Agents stay registered and become eligible again at the stored
   * wall-clock deadline; reconnecting clears stale process-local deferral.
   */
  private preparationRetryAfterByAgent: Map<string, number> = new Map();

  /** Track insufficient agent warnings for auto-recovery */
  insufficientAgentWarningCount: number = 0;

  /** Last time we logged insufficient agents warning */
  lastInsufficientAgentsLog: number = 0;

  private callbacks: MatchmakingCallbacks | null = null;

  constructor(
    private readonly world: World,
    private readonly getDatabase: () => NodePgDatabase | null,
    private readonly config: MatchmakingConfig,
  ) {}

  /**
   * Set callback hooks for scheduler integration.
   * Must be called before using methods that depend on scheduler state.
   */
  setCallbacks(callbacks: MatchmakingCallbacks): void {
    this.callbacks = callbacks;
  }

  // ==========================================================================
  // Agent Registration
  // ==========================================================================

  /**
   * Persisted opt-out from streaming duel matchmaking, or clear opt-out before re-registering.
   */
  markStreamingDuelOptOut(agentId: string, optedOut: boolean): void {
    if (optedOut) {
      this.streamingDuelOptOut.add(agentId);
      this.unregisterAgent(agentId);
    } else {
      this.streamingDuelOptOut.delete(agentId);
    }
  }

  /**
   * Register an agent for duel scheduling
   */
  registerAgent(agentId: string): void {
    if (this.streamingDuelOptOut.has(agentId)) {
      return;
    }
    const now = Date.now();
    this.availableAgents.add(agentId);
    this.agentStatsLastSeenAt.set(agentId, now);
    this.callbacks?.onAgentRegistered?.(agentId, now);

    // Get agent info from entity
    const entity = this.world.entities.get(agentId);
    if (entity) {
      const data = entity.data as {
        name?: string;
        skills?: Record<string, { level: number }>;
      };

      // Calculate combat level
      const skills = data.skills || {};
      const attack = skills.attack?.level || 1;
      const strength = skills.strength?.level || 1;
      const defense = skills.defense?.level || 1;
      const constitution = skills.constitution?.level || 10;
      const combatLevel = calculateCombatLevel({
        attack,
        strength,
        defense,
        hitpoints: constitution,
        ranged: skills.ranged?.level || 1,
        magic: skills.magic?.level || 1,
        prayer: skills.prayer?.level || 1,
      });

      // Parse provider and model from agent ID (or use character name)
      // Try to get from character data first
      const characterData = data as {
        name?: string;
        agentProvider?: string;
        agentModel?: string;
      };

      let provider = characterData.agentProvider || "unknown";
      let model = characterData.agentModel || "unknown";

      // Fallback: try to parse from agent ID if format is agent-{provider}-{model}
      if (provider === "unknown" && agentId.startsWith("agent-")) {
        const parts = agentId.split("-");
        provider = parts[1] || "unknown";
        model = parts.slice(2).join("-") || "unknown";
      }

      // Initialize stats if not exists
      if (!this.agentStats.has(agentId)) {
        this.agentStats.set(agentId, {
          characterId: agentId,
          name: data.name || agentId,
          provider,
          model,
          wins: 0,
          losses: 0,
          draws: 0,
          combatLevel,
          currentStreak: 0,
        });
        this.leaderboardDirty = true;

        // Warm the persisted record without blocking world registration. The
        // private preparation gate awaits the same singleflight before it can
        // freeze or disclose a competitive matchup.
        this.ensureAgentStatsHydrated(agentId).catch((err) => {
          Logger.warn(
            "StreamingDuelScheduler",
            `Failed to load stats for ${agentId}: ${err}`,
          );
        });
      }

      this.pruneInactiveAgentStats(now);

      Logger.info(
        "StreamingDuelScheduler",
        `Agent registered: ${data.name || agentId}`,
      );
    }

    // Registration may be a socket reconnect for a contestant whose exact
    // private pair is already durable. A newly available third contestant is
    // likewise not authority to rewrite an announced on-deck matchup.
    if (
      this.availableAgents.size >= this.config.minAgents &&
      !this.nextDuelPair
    ) {
      this.refreshNextDuelPair(now);
    }
  }

  /**
   * Load persisted stats from database for an agent
   */
  private async loadStatsFromDatabase(
    agentId: string,
    generation: number,
  ): Promise<void> {
    const db = this.getDatabase();
    if (!db) {
      throw new Error("stats_database_unavailable");
    }

    const { agentDuelStats, playerCombatStats } =
      await import("../../../database/schema.js");
    const { eq } = await import("drizzle-orm");

    const [combatResult, agentResult] = await Promise.all([
      db
        .select({
          totalDuelWins: playerCombatStats.totalDuelWins,
          totalDuelLosses: playerCombatStats.totalDuelLosses,
        })
        .from(playerCombatStats)
        .where(eq(playerCombatStats.playerId, agentId))
        .limit(1),
      db
        .select({
          wins: agentDuelStats.wins,
          losses: agentDuelStats.losses,
          draws: agentDuelStats.draws,
          currentStreak: agentDuelStats.currentStreak,
        })
        .from(agentDuelStats)
        .where(eq(agentDuelStats.characterId, agentId))
        .limit(1),
    ]);

    if (generation !== this.agentStatsHydrationGeneration) return;
    const stats = this.agentStats.get(agentId);
    if (stats && (combatResult.length > 0 || agentResult.length > 0)) {
      if (combatResult.length > 0) {
        stats.wins = combatResult[0].totalDuelWins;
        stats.losses = combatResult[0].totalDuelLosses;
      } else if (agentResult.length > 0) {
        stats.wins = agentResult[0].wins;
        stats.losses = agentResult[0].losses;
      }
      if (agentResult.length > 0) {
        stats.draws = agentResult[0].draws;
        stats.currentStreak = agentResult[0].currentStreak;
      }
      this.leaderboardDirty = true;
      Logger.info(
        "StreamingDuelScheduler",
        `Loaded persisted stats for ${agentId}: ${stats.wins}W ${stats.draws}D ${stats.losses}L`,
      );
    }
  }

  private ensureAgentStatsHydrated(agentId: string): Promise<void> {
    // A missing adapter means this scheduler is running in its supported
    // non-persistent/local mode. A configured adapter that rejects a query is
    // different: that error propagates and keeps the competitive gate closed.
    if (!this.config.persistStatsToDatabase || !this.getDatabase()) {
      this.hydratedAgentStats.add(agentId);
      return Promise.resolve();
    }
    if (this.hydratedAgentStats.has(agentId)) return Promise.resolve();
    const pending = this.pendingAgentStatsHydrations.get(agentId);
    if (pending) return pending;

    const generation = this.agentStatsHydrationGeneration;
    const hydration = this.loadStatsFromDatabase(agentId, generation)
      .then(() => {
        if (
          generation === this.agentStatsHydrationGeneration &&
          this.agentStats.has(agentId)
        ) {
          this.hydratedAgentStats.add(agentId);
        }
      })
      .finally(() => {
        if (this.pendingAgentStatsHydrations.get(agentId) === hydration) {
          this.pendingAgentStatsHydrations.delete(agentId);
        }
      });
    this.pendingAgentStatsHydrations.set(agentId, hydration);
    return hydration;
  }

  /**
   * Await exact persisted records before private selection or market freeze.
   * A transient database error rejects and remains retryable on the next gate
   * pass instead of leaking placeholder records to bettors.
   */
  async waitForAgentStatsHydration(agentIds: readonly string[]): Promise<void> {
    const uniqueAgentIds = [...new Set(agentIds)];
    if (!this.config.persistStatsToDatabase || !this.getDatabase()) return;
    if (
      uniqueAgentIds.some(
        (agentId) => !agentId || !this.agentStats.has(agentId),
      )
    ) {
      throw new Error("competitive_agent_stats_unavailable");
    }
    await Promise.all(
      uniqueAgentIds.map((agentId) => this.ensureAgentStatsHydrated(agentId)),
    );
  }

  /**
   * Unregister an agent from duel scheduling.
   * Returns the agentId so the caller can handle forfeit logic.
   */
  unregisterAgent(agentId: string): void {
    const now = Date.now();
    this.agentStatsLastSeenAt.set(agentId, now);
    this.availableAgents.delete(agentId);
    this.preparationRetryAfterByAgent.delete(agentId);
    if (
      this.nextDuelPair &&
      (this.nextDuelPair.agent1Id === agentId ||
        this.nextDuelPair.agent2Id === agentId)
    ) {
      this.nextDuelPair = null;
      // Cancel the old pair before another selection can supersede its durable
      // preparation without delivering a terminal event to the other agent.
      // The scheduler's next reconciliation tick may select a replacement.
      this.callbacks?.onNextDuelPairChanged?.(null);
    }
    Logger.info("StreamingDuelScheduler", `Agent unregistered: ${agentId}`);

    // Notify the scheduler so it can handle forfeit + camera cleanup
    this.callbacks?.onAgentUnregistered?.(agentId);

    this.pruneInactiveAgentStats(now);
  }

  /**
   * Make an agent unavailable to fresh pair selection while preserving an
   * already-selected private preparation during the socket reconnect grace.
   * The durable contestant-host lease remains the authority that either
   * resumes the exact preparation or terminates it after the host disappears.
   */
  suspendAgentForReconnect(agentId: string): void {
    const now = Date.now();
    this.agentStatsLastSeenAt.set(agentId, now);
    this.availableAgents.delete(agentId);
    Logger.info(
      "StreamingDuelScheduler",
      `Agent suspended for reconnect grace: ${agentId}`,
    );
    this.pruneInactiveAgentStats(now);
  }

  // ==========================================================================
  // Pair Selection
  // ==========================================================================

  /**
   * Keep a failed preparation contestant registered while preventing a tight
   * cancel/reselect loop. A later failure may extend but never shorten the
   * existing deadline.
   */
  deferAgentAfterPreparationFailure(agentId: string, retryAfter: number): void {
    if (
      agentId.length === 0 ||
      !Number.isFinite(retryAfter) ||
      retryAfter < 0
    ) {
      throw new Error("invalid preparation retry deferral");
    }

    const currentRetryAfter = this.preparationRetryAfterByAgent.get(agentId);
    if (currentRetryAfter === undefined || retryAfter > currentRetryAfter) {
      this.preparationRetryAfterByAgent.set(agentId, retryAfter);
    }

    if (
      this.nextDuelPair &&
      (this.nextDuelPair.agent1Id === agentId ||
        this.nextDuelPair.agent2Id === agentId)
    ) {
      this.nextDuelPair = null;
      this.callbacks?.onNextDuelPairChanged?.(null);
    }
  }

  /**
   * Choose a random pair of agents from a pool.
   * Uses Fisher-Yates shuffle for unbiased selection.
   */
  chooseRandomPairFromPool(pool: string[], now: number): NextDuelPair | null {
    if (pool.length < this.config.minAgents) {
      return null;
    }

    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const agent1Id = shuffled[0];
    const agent2Id = shuffled[1];
    if (!agent1Id || !agent2Id || agent1Id === agent2Id) {
      return null;
    }

    return { agent1Id, agent2Id, selectedAt: now };
  }

  /**
   * Consume the preselected duel pair if both agents are still valid.
   * Clears the stored pair regardless.
   */
  consumePreselectedDuelPair(validAgents: string[]): NextDuelPair | null {
    if (!this.nextDuelPair) {
      return null;
    }

    const preselected = this.nextDuelPair;
    this.nextDuelPair = null;

    const validSet = new Set(validAgents);
    if (
      preselected.agent1Id !== preselected.agent2Id &&
      validSet.has(preselected.agent1Id) &&
      validSet.has(preselected.agent2Id)
    ) {
      return preselected;
    }

    return null;
  }

  /**
   * Refresh the next duel pair from available agents,
   * excluding current cycle contestants when possible.
   */
  refreshNextDuelPair(now: number): void {
    const validAgents = Array.from(this.availableAgents).filter((agentId) => {
      const entity = this.world.entities.get(agentId);
      if (!entity) {
        return false;
      }
      const data = entity.data as
        { health?: unknown; alive?: unknown } | undefined;
      const health = Number(data?.health);
      // Matchmaking is allowed to retain a dead agent registration so normal
      // respawn can make it eligible again, but it must never select that
      // agent while its authoritative runtime state is dead or malformed.
      if (data?.alive === false || !Number.isFinite(health) || health <= 0) {
        return false;
      }
      const retryAfter = this.preparationRetryAfterByAgent.get(agentId);
      if (retryAfter === undefined) {
        return true;
      }
      if (retryAfter > now) {
        return false;
      }
      this.preparationRetryAfterByAgent.delete(agentId);
      return true;
    });
    if (validAgents.length < this.config.minAgents) {
      this.nextDuelPair = null;
      return;
    }

    const excluded = this.callbacks?.getCycleContestantIds() ?? new Set();
    let pool = validAgents.filter((agentId) => !excluded.has(agentId));
    if (pool.length < this.config.minAgents) {
      pool = validAgents;
    }

    this.nextDuelPair = this.chooseRandomPairFromPool(pool, now);
    this.callbacks?.onNextDuelPairChanged?.(this.nextDuelPair);
  }

  // ==========================================================================
  // Stats Management
  // ==========================================================================

  /**
   * Prevent unbounded agent stat growth when character IDs churn.
   * Keeps active/current-cycle IDs and evicts oldest inactive records first.
   */
  pruneInactiveAgentStats(now: number): void {
    if (this.agentStats.size <= this.config.maxAgentStats) {
      return;
    }

    const protectedIds = new Set<string>(this.availableAgents);
    const cycleContestants =
      this.callbacks?.getCycleContestantIds() ?? new Set<string>();
    for (const id of cycleContestants) {
      protectedIds.add(id);
    }
    if (this.nextDuelPair?.agent1Id) {
      protectedIds.add(this.nextDuelPair.agent1Id);
    }
    if (this.nextDuelPair?.agent2Id) {
      protectedIds.add(this.nextDuelPair.agent2Id);
    }

    const prunableIds: string[] = [];
    for (const agentId of this.agentStats.keys()) {
      if (!protectedIds.has(agentId)) {
        prunableIds.push(agentId);
      }
    }
    if (prunableIds.length === 0) {
      return;
    }

    prunableIds.sort((a, b) => {
      const aSeen = this.agentStatsLastSeenAt.get(a) ?? now;
      const bSeen = this.agentStatsLastSeenAt.get(b) ?? now;
      return aSeen - bSeen;
    });

    const targetRemovals = Math.min(
      prunableIds.length,
      this.agentStats.size - this.config.maxAgentStats,
    );
    if (targetRemovals <= 0) {
      return;
    }

    for (let i = 0; i < targetRemovals; i++) {
      const agentId = prunableIds[i];
      if (!agentId) continue;
      this.agentStats.delete(agentId);
      this.agentStatsLastSeenAt.delete(agentId);
      this.hydratedAgentStats.delete(agentId);
      this.pendingAgentStatsHydrations.delete(agentId);
    }

    this.leaderboardDirty = true;
    Logger.info(
      "StreamingDuelScheduler",
      `Pruned ${targetRemovals} inactive agent stat record(s); retained ${this.agentStats.size} total`,
    );
  }

  /**
   * Update win/loss stats for a completed duel.
   * Marks leaderboard as dirty and optionally persists to database.
   */
  updateStats(
    winnerId: string,
    loserId: string,
    options?: { persistToDatabase?: boolean },
  ): void {
    const winnerStats = this.agentStats.get(winnerId);
    const loserStats = this.agentStats.get(loserId);

    if (winnerStats) {
      winnerStats.wins++;
      winnerStats.currentStreak++;
    }

    if (loserStats) {
      loserStats.losses++;
      loserStats.currentStreak = 0;
    }

    this.leaderboardDirty = true;

    if (
      !this.config.persistStatsToDatabase ||
      options?.persistToDatabase === false
    ) {
      return;
    }

    // Persist to database asynchronously
    this.persistStatsToDatabase(winnerId, loserId).catch((err) => {
      Logger.warn(
        "StreamingDuelScheduler",
        `Failed to persist stats to database: ${err}`,
      );
    });
  }

  /**
   * Persist duel stats to the database
   */
  private async persistStatsToDatabase(
    winnerId: string,
    loserId: string,
  ): Promise<void> {
    const db = this.getDatabase();
    if (!db) {
      Logger.warn(
        "StreamingDuelScheduler",
        "Database not available for stats persistence",
      );
      return;
    }

    try {
      // Import schema dynamically to avoid circular dependencies
      const { playerCombatStats, agentDuelStats } =
        await import("../../../database/schema.js");
      const { sql } = await import("drizzle-orm");

      const now = Date.now();

      // Update winner stats (playerCombatStats)
      await db
        .insert(playerCombatStats)
        .values({
          playerId: winnerId,
          totalDuelWins: 1,
          totalDuelLosses: 0,
        })
        .onConflictDoUpdate({
          target: playerCombatStats.playerId,
          set: {
            totalDuelWins: sql`${playerCombatStats.totalDuelWins} + 1`,
            updatedAt: sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`,
          },
        });

      // Update loser stats (playerCombatStats)
      await db
        .insert(playerCombatStats)
        .values({
          playerId: loserId,
          totalDuelWins: 0,
          totalDuelLosses: 1,
        })
        .onConflictDoUpdate({
          target: playerCombatStats.playerId,
          set: {
            totalDuelLosses: sql`${playerCombatStats.totalDuelLosses} + 1`,
            updatedAt: sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`,
          },
        });

      // Persist agent-specific stats (agentDuelStats) for AI model tracking
      const winnerAgentStats = this.agentStats.get(winnerId);
      const loserAgentStats = this.agentStats.get(loserId);

      if (winnerAgentStats) {
        const winner = this.callbacks?.getCurrentCycleAgentDamage(winnerId);
        const damageDealt = winner?.damageDealtThisFight ?? 0;

        await db
          .insert(agentDuelStats)
          .values({
            characterId: winnerId,
            agentName: winnerAgentStats.name,
            provider: winnerAgentStats.provider,
            model: winnerAgentStats.model,
            wins: winnerAgentStats.wins,
            losses: winnerAgentStats.losses,
            draws: 0,
            totalDamageDealt: damageDealt,
            totalDamageTaken: 0,
            killStreak: Math.max(winnerAgentStats.currentStreak, 1),
            currentStreak: winnerAgentStats.currentStreak,
            lastDuelAt: now,
          })
          .onConflictDoUpdate({
            target: agentDuelStats.characterId,
            set: {
              wins: sql`${agentDuelStats.wins} + 1`,
              totalDamageDealt: sql`${agentDuelStats.totalDamageDealt} + ${damageDealt}`,
              killStreak: sql`GREATEST(${agentDuelStats.killStreak}, ${agentDuelStats.currentStreak} + 1)`,
              currentStreak: sql`${agentDuelStats.currentStreak} + 1`,
              lastDuelAt: now,
              updatedAt: sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`,
            },
          });
      }

      if (loserAgentStats) {
        const loser = this.callbacks?.getCurrentCycleAgentDamage(loserId);
        const damageDealt = loser?.damageDealtThisFight ?? 0;

        await db
          .insert(agentDuelStats)
          .values({
            characterId: loserId,
            agentName: loserAgentStats.name,
            provider: loserAgentStats.provider,
            model: loserAgentStats.model,
            wins: loserAgentStats.wins,
            losses: loserAgentStats.losses,
            draws: 0,
            totalDamageDealt: damageDealt,
            totalDamageTaken: 0,
            killStreak: 0,
            currentStreak: 0,
            lastDuelAt: now,
          })
          .onConflictDoUpdate({
            target: agentDuelStats.characterId,
            set: {
              losses: sql`${agentDuelStats.losses} + 1`,
              totalDamageDealt: sql`${agentDuelStats.totalDamageDealt} + ${damageDealt}`,
              currentStreak: 0,
              lastDuelAt: now,
              updatedAt: sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`,
            },
          });
      }

      Logger.info(
        "StreamingDuelScheduler",
        `Stats persisted: ${winnerId} won, ${loserId} lost`,
      );
    } catch (err) {
      Logger.warn("StreamingDuelScheduler", `Error persisting stats: ${err}`);
    }
  }

  /**
   * Update stats for a draw outcome (#24).
   * Draws are visible in records but do not affect win/loss counts or streaks.
   */
  updateDrawStats(
    agent1Id: string,
    agent2Id: string,
    options?: { persistToDatabase?: boolean },
  ): void {
    const agent1Stats = this.agentStats.get(agent1Id);
    const agent2Stats = this.agentStats.get(agent2Id);
    if (agent1Stats) agent1Stats.draws++;
    if (agent2Stats) agent2Stats.draws++;
    this.leaderboardDirty = true;

    if (
      !this.config.persistStatsToDatabase ||
      options?.persistToDatabase === false
    ) {
      return;
    }
    this.persistDrawStatsToDatabase(agent1Id, agent2Id).catch((err) => {
      Logger.warn(
        "StreamingDuelScheduler",
        `Failed to persist draw stats to database: ${err}`,
      );
    });
  }

  private async persistDrawStatsToDatabase(
    agent1Id: string,
    agent2Id: string,
  ): Promise<void> {
    const db = this.getDatabase();
    if (!db) return;

    const drawEntries = [agent1Id, agent2Id]
      .filter((agentId, index, ids) => ids.indexOf(agentId) === index)
      .map((agentId) => ({
        agentId,
        stats: this.agentStats.get(agentId),
        damageDealt:
          this.callbacks?.getCurrentCycleAgentDamage(agentId)
            ?.damageDealtThisFight ?? 0,
      }))
      .filter(
        (
          entry,
        ): entry is {
          agentId: string;
          stats: AgentStatsEntry;
          damageDealt: number;
        } => Boolean(entry.stats),
      );

    const { agentDuelStats } = await import("../../../database/schema.js");
    const { sql } = await import("drizzle-orm");
    const now = Date.now();

    for (const { agentId, stats, damageDealt } of drawEntries) {
      await db
        .insert(agentDuelStats)
        .values({
          characterId: agentId,
          agentName: stats.name,
          provider: stats.provider,
          model: stats.model,
          wins: stats.wins,
          losses: stats.losses,
          draws: stats.draws,
          totalDamageDealt: damageDealt,
          totalDamageTaken: 0,
          killStreak: stats.currentStreak,
          currentStreak: stats.currentStreak,
          lastDuelAt: now,
        })
        .onConflictDoUpdate({
          target: agentDuelStats.characterId,
          set: {
            draws: sql`${agentDuelStats.draws} + 1`,
            totalDamageDealt: sql`${agentDuelStats.totalDamageDealt} + ${damageDealt}`,
            lastDuelAt: now,
            updatedAt: sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`,
          },
        });
    }
  }

  // ==========================================================================
  // Recent Duels
  // ==========================================================================

  /**
   * Record a recently completed duel (newest first, capped to maxRecentDuels).
   * If database persistence is enabled, also writes the compatibility history
   * cache. Restart truth comes from the immutable competitive terminal plus
   * exact public damage receipts, never from this best-effort cache write.
   */
  recordRecentDuel(duel: RecentDuelEntry): void {
    this.recentDuels = this.recentDuels.filter(
      (existing) => existing.cycleId !== duel.cycleId,
    );
    this.recentDuels.unshift(duel);
    if (this.recentDuels.length > this.config.maxRecentDuels) {
      this.recentDuels.length = this.config.maxRecentDuels;
    }

    if (this.config.persistStatsToDatabase) {
      this.persistDuelHistory(duel).catch((err) => {
        Logger.warn(
          "StreamingDuelScheduler",
          `Failed to persist duel history: ${err}`,
        );
      });
    }
  }

  private async persistDuelHistory(duel: RecentDuelEntry): Promise<void> {
    const db = this.getDatabase();
    if (!db) return;

    const { streamingDuelHistory } =
      await import("../../../database/schema.js");

    await db.insert(streamingDuelHistory).values({
      cycleId: duel.cycleId,
      duelId: duel.duelId,
      finishedAt: duel.finishedAt,
      outcome: duel.outcome,
      agent1Id: duel.agent1Id,
      agent1Name: duel.agent1Name,
      agent1OpeningStyle: duel.agent1OpeningStyle,
      agent2Id: duel.agent2Id,
      agent2Name: duel.agent2Name,
      agent2OpeningStyle: duel.agent2OpeningStyle,
      winnerId: duel.winnerId,
      winnerName: duel.winnerName,
      loserId: duel.loserId,
      loserName: duel.loserName,
      winReason: duel.winReason,
      cancellationReason: duel.cancellationReason,
      damageAgent1: duel.damageAgent1,
      damageAgent2: duel.damageAgent2,
      damageWinner: duel.damageWinner,
      damageLoser: duel.damageLoser,
    });
  }

  /**
   * Restore bounded recent history after a process restart. Modern persisted
   * duels are reconstructed from their frozen snapshot, terminal, digest, and
   * exact public damage rows. The older history table is fallback-only for
   * cycles with no competitive snapshot; it can never override or mask one.
   *
   * Rows that complete while the query is in flight are retained and win any
   * cycle-ID collision, so hydration cannot overwrite fresher in-memory state.
   */
  async hydrateRecentDuelsFromDatabase(): Promise<number> {
    const db = this.getDatabase();
    if (!db) return 0;

    const generation = ++this.recentDuelHydrationGeneration;
    const {
      streamingDuelActionObservations,
      streamingDuelCompetitiveSnapshots,
      streamingDuelHistory,
    } = await import("../../../database/schema.js");
    const { and, desc, eq, inArray, isNotNull } = await import("drizzle-orm");
    const competitiveRows = await db
      .select()
      .from(streamingDuelCompetitiveSnapshots)
      .where(
        and(
          inArray(streamingDuelCompetitiveSnapshots.lifecycleStatus, [
            "terminal",
            "retired",
          ]),
          isNotNull(streamingDuelCompetitiveSnapshots.terminalAt),
        ),
      )
      .orderBy(
        desc(streamingDuelCompetitiveSnapshots.terminalAt),
        desc(streamingDuelCompetitiveSnapshots.cycleId),
      )
      .limit(this.config.maxRecentDuels);
    const competitiveCycleIds = new Set(
      competitiveRows
        .map((row) => nullableString(row.cycleId))
        .filter((cycleId): cycleId is string => cycleId !== null),
    );
    const competitivePreviews = competitiveRows
      .map((row) => normalizePersistedCompetitiveOutcome(row))
      .filter((duel): duel is RecentDuelEntry => duel !== null);
    const previewByCycle = new Map(
      competitivePreviews.map((duel) => [duel.cycleId, duel]),
    );
    const damageByCycle = new Map<string, Map<string, number>>(
      competitivePreviews.map((duel) => [
        duel.cycleId,
        new Map([
          [duel.agent1Id!, 0],
          [duel.agent2Id!, 0],
        ]),
      ]),
    );
    if (previewByCycle.size > 0) {
      const damageRows = await db
        .select({
          cycleId: streamingDuelActionObservations.cycleId,
          observation: streamingDuelActionObservations.observation,
        })
        .from(streamingDuelActionObservations)
        .where(
          and(
            inArray(streamingDuelActionObservations.cycleId, [
              ...previewByCycle.keys(),
            ]),
            eq(streamingDuelActionObservations.action, "damage"),
          ),
        );
      for (const row of damageRows) {
        const duel = previewByCycle.get(row.cycleId);
        const damage = damageByCycle.get(row.cycleId);
        const observation = parseStreamingDuelActionObservation(
          row.observation,
        );
        if (
          !duel ||
          !damage ||
          !observation ||
          observation.action !== "damage" ||
          observation.cycleId !== duel.cycleId ||
          observation.duelId !== duel.duelId ||
          !damage.has(observation.actorId) ||
          observation.opponentId !==
            (observation.actorId === duel.agent1Id
              ? duel.agent2Id
              : duel.agent1Id) ||
          !Number.isSafeInteger(observation.amount) ||
          Number(observation.amount) <= 0
        ) {
          throw new Error("competitive_outcome_damage_history_invalid");
        }
        const total =
          (damage.get(observation.actorId) ?? 0) + Number(observation.amount);
        if (!Number.isSafeInteger(total)) {
          throw new Error("competitive_outcome_damage_history_invalid");
        }
        damage.set(observation.actorId, total);
      }
    }
    const authoritative = competitiveRows
      .map((row) => {
        const snapshot = row.snapshot as CompetitiveSnapshot | undefined;
        if (!snapshot || !previewByCycle.has(snapshot.cycleId)) return null;
        const damage = damageByCycle.get(snapshot.cycleId);
        return normalizePersistedCompetitiveOutcome(
          row,
          damage?.get(snapshot.contestants[0].agentId) ?? 0,
          damage?.get(snapshot.contestants[1].agentId) ?? 0,
        );
      })
      .filter((duel): duel is RecentDuelEntry => duel !== null);

    const legacyRows = await db
      .select()
      .from(streamingDuelHistory)
      .orderBy(
        desc(streamingDuelHistory.finishedAt),
        desc(streamingDuelHistory.id),
      )
      .limit(this.config.maxRecentDuels);

    if (generation !== this.recentDuelHydrationGeneration) return 0;

    const legacy = legacyRows
      .map(normalizePersistedRecentDuel)
      .filter((duel): duel is RecentDuelEntry => duel !== null);
    const hydratedByCycle = new Map<string, RecentDuelEntry>();
    for (const duel of authoritative) {
      hydratedByCycle.set(duel.cycleId, duel);
    }
    for (const duel of legacy) {
      if (
        !competitiveCycleIds.has(duel.cycleId) &&
        !hydratedByCycle.has(duel.cycleId)
      ) {
        hydratedByCycle.set(duel.cycleId, duel);
      }
    }
    const hydrated = [...hydratedByCycle.values()];
    const merged = new Map<string, RecentDuelEntry>();

    for (const duel of this.recentDuels) merged.set(duel.cycleId, duel);
    for (const duel of hydrated) {
      if (!merged.has(duel.cycleId)) merged.set(duel.cycleId, duel);
    }

    this.recentDuels = [...merged.values()]
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, this.config.maxRecentDuels);
    return hydrated.length;
  }

  // ==========================================================================
  // Leaderboard
  // ==========================================================================

  /**
   * Get leaderboard sorted by win rate, then by total wins.
   * Caches result and only recomputes when stats change.
   */
  getLeaderboard(): LeaderboardEntry[] {
    if (!this.leaderboardDirty) {
      return this.cachedLeaderboard;
    }

    const entries: LeaderboardEntry[] = [];

    for (const [characterId, stats] of this.agentStats) {
      const totalGames = stats.wins + stats.losses;
      const winRate = totalGames > 0 ? stats.wins / totalGames : 0;

      entries.push({
        rank: 0, // Will be set after sorting
        characterId,
        name: stats.name,
        provider: stats.provider,
        model: stats.model,
        wins: stats.wins,
        losses: stats.losses,
        draws: stats.draws,
        winRate,
        combatLevel: stats.combatLevel,
        currentStreak: stats.currentStreak,
      });
    }

    // Sort by win rate, then by total wins
    entries.sort((a, b) => {
      if (b.winRate !== a.winRate) {
        return b.winRate - a.winRate;
      }
      return b.wins - a.wins;
    });

    // Assign ranks
    for (let i = 0; i < entries.length; i++) {
      entries[i].rank = i + 1;
    }

    this.cachedLeaderboard = entries;
    this.leaderboardDirty = false;
    return entries;
  }

  /**
   * Get recent duel history, capped by the provided limit.
   */
  getRecentDuels(limit: number = 30): RecentDuelEntry[] {
    const safeLimit = Math.max(1, Math.min(limit, this.config.maxRecentDuels));
    return this.recentDuels.slice(0, safeLimit);
  }

  /**
   * Return completed head-to-head history from one contestant's perspective.
   * Cancellations and malformed participant records are excluded because they
   * are not evidence about an opponent's combat strategy.
   */
  getOpponentHistory(
    agentId: string,
    opponentId: string,
    limit: number = MAX_DUEL_PREPARATION_OPPONENT_HISTORY,
  ): DuelPreparationOpponentHistoryEntry[] {
    if (!agentId || !opponentId || agentId === opponentId) return [];
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(limit, MAX_DUEL_PREPARATION_OPPONENT_HISTORY))
      : MAX_DUEL_PREPARATION_OPPONENT_HISTORY;
    const history: DuelPreparationOpponentHistoryEntry[] = [];

    for (const duel of this.recentDuels) {
      if (duel.outcome === "cancelled") continue;
      const agentIsFirst = duel.agent1Id === agentId;
      const agentIsSecond = duel.agent2Id === agentId;
      const opponentIsOther = agentIsFirst
        ? duel.agent2Id === opponentId
        : agentIsSecond
          ? duel.agent1Id === opponentId
          : false;
      if (!opponentIsOther) continue;

      const result =
        duel.outcome === "draw"
          ? "draw"
          : duel.winnerId === agentId
            ? "win"
            : duel.loserId === agentId
              ? "loss"
              : null;
      if (!result || !duel.winReason) continue;
      history.push({
        cycleId: duel.cycleId,
        finishedAt: duel.finishedAt,
        result,
        ownOpeningStyle: agentIsFirst
          ? duel.agent1OpeningStyle
          : duel.agent2OpeningStyle,
        opponentOpeningStyle: agentIsFirst
          ? duel.agent2OpeningStyle
          : duel.agent1OpeningStyle,
        ownDamage: agentIsFirst ? duel.damageAgent1 : duel.damageAgent2,
        opponentDamage: agentIsFirst ? duel.damageAgent2 : duel.damageAgent1,
        winReason: duel.winReason,
      });
      if (history.length >= safeLimit) break;
    }
    return history;
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Reset all matchmaking state for destroy/cleanup.
   */
  reset(): void {
    this.recentDuelHydrationGeneration++;
    this.agentStatsHydrationGeneration++;
    this.availableAgents.clear();
    this.streamingDuelOptOut.clear();
    this.agentStats.clear();
    this.agentStatsLastSeenAt.clear();
    this.hydratedAgentStats.clear();
    this.pendingAgentStatsHydrations.clear();
    this.recentDuels = [];
    this.cachedLeaderboard = [];
    this.leaderboardDirty = true;
    this.nextDuelPair = null;
    this.preparationRetryAfterByAgent.clear();
    this.insufficientAgentWarningCount = 0;
    this.lastInsufficientAgentsLog = 0;
    this.callbacks = null;
  }
}
