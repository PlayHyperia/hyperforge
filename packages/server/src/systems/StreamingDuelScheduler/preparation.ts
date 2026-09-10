import type pg from "pg";
import {
  DUEL_PREPARATION_ROLE_POLICY_VERSION,
  EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
  STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITY_TRAIL_LIMIT,
  STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITIES,
  STREAMING_DUEL_PUBLIC_PREPARATION_MODES,
  normalizeExternalDuelPreparationOpponentHistorySummary,
  normalizeExternalDuelPreparationPublicName,
  normalizeExternalDuelPreparationPublicProfile,
  type ExternalDuelPreparationOpponentHistorySummary,
  type ExternalDuelPreparationPublicProfile,
  type StreamingDuelPublicPreparationActivity,
  type StreamingDuelPublicPreparationMode,
} from "@hyperforge/shared";
import type {
  CompetitivePreparationEvidence,
  CompetitiveSnapshot,
  CompetitiveSnapshotDraft,
  CompetitiveSnapshotTimingInput,
} from "./competitive-snapshot.js";
import {
  assertValidCompetitiveSnapshot,
  canonicalCompetitiveSnapshotJson,
  digestCompetitiveSnapshot,
  finalizeCompetitiveSnapshot,
} from "./competitive-snapshot.js";
import { normalizeCompetitiveTacticalStrategy } from "./competitive-tactical-strategy.js";
import { buildCompetitiveTerminalStatUpdates } from "./competitive-terminal-stats.js";
import type { SwitchableStreamingCombatRole } from "./types.js";
import { lockAndAssertPersistedStreamingDuelParticipation } from "../../database/streaming-duel-participation.js";
import {
  MAX_DUEL_PREPARATION_HOST_LEASE_MS,
  MIN_DUEL_PREPARATION_HOST_LEASE_MS,
} from "./preparation-host-lease.js";

export type DuelPreparationStatus =
  "preparing" | "ready" | "frozen" | "cancelled" | "expired";

export type DuelPreparationBankAction =
  "open" | "deposit" | "withdraw" | "deposit_all";

export const DUEL_PREPARATION_BANK_ACTIONS = [
  "open",
  "deposit",
  "withdraw",
  "deposit_all",
] as const satisfies readonly DuelPreparationBankAction[];

/** Internal fail-closed signal that revokes process-local preparation authority. */
export const DUEL_PREPARATION_LOCAL_REVOCATION_EVENT =
  "duel:preparation:local_revoked" as const;

export type DuelPreparationSnapshot = {
  preparationId: string;
  fencingToken: string;
  agent1Id: string;
  agent2Id: string;
  allowedBankActions: DuelPreparationBankAction[];
  status: DuelPreparationStatus;
  selectedAt: number;
  expiresAt: number;
  agent1ReadyAt: number | null;
  agent2ReadyAt: number | null;
  agent1PlanEvidence: CompetitivePreparationEvidence | null;
  agent2PlanEvidence: CompetitivePreparationEvidence | null;
  frozenAt: number | null;
  cancelledAt: number | null;
  cancellationReason: string | null;
  version: number;
};

export type DuelPreparationBankAccessFailure =
  | "preparation_not_found"
  | "preparation_not_active"
  | "preparation_expired"
  | "preparation_agent_mismatch"
  | "preparation_agent_ready"
  | "preparation_action_not_allowed";

export type DuelPreparationBankAccessDecision =
  | { ok: true; preparation: DuelPreparationSnapshot }
  | { ok: false; reason: DuelPreparationBankAccessFailure };

export const DUEL_PREPARATION_CONTESTANT_UNAVAILABILITY_REASON =
  "agent_unavailable" as const;

export type DuelPreparationContestantUnavailabilityReport = {
  preparationId: string;
  agentId: string;
  reason: typeof DUEL_PREPARATION_CONTESTANT_UNAVAILABILITY_REASON;
  reportedAt: number;
};

export type DuelPreparationAgentHostLease = {
  preparationId: string;
  agentId: string;
  ownerId: string;
  executableBuildId: string | null;
  claimedAt: number;
  heartbeatAt: number;
  expiresAt: number;
};

export type DuelPreparationPublicActivityRecord = {
  preparationId: string;
  agentId: string;
  activity: StreamingDuelPublicPreparationActivity;
  mode: StreamingDuelPublicPreparationMode;
  occurredAt: number;
  revision: number;
};

export type DuelPreparationStrategyContext = {
  preparationId: string;
  agentId: string;
  hostOwnerId: string;
  policyVersion: typeof DUEL_PREPARATION_ROLE_POLICY_VERSION;
  protocolVersion: typeof EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION;
  agentName: string;
  opponentName: string;
  ownPublicProfile: ExternalDuelPreparationPublicProfile | null;
  opponentPublicProfile: ExternalDuelPreparationPublicProfile | null;
  opponentHistorySummary: ExternalDuelPreparationOpponentHistorySummary;
  boundAt: number;
};

type PreparationRow = {
  preparationId: string;
  fencingToken: string | number | bigint;
  agent1Id: string;
  agent2Id: string;
  allowedBankActions: DuelPreparationBankAction[];
  status: DuelPreparationStatus;
  selectedAt: string | number;
  expiresAt: string | number;
  agent1ReadyAt: string | number | null;
  agent2ReadyAt: string | number | null;
  agent1PlanEvidence: CompetitivePreparationEvidence | null;
  agent2PlanEvidence: CompetitivePreparationEvidence | null;
  frozenAt: string | number | null;
  cancelledAt: string | number | null;
  cancellationReason: string | null;
  version: string | number;
};

type PreparationAccessRow = PreparationRow & {
  databaseNow: string | number;
  contestantUnavailable?: boolean;
  contestantHostLeaseActive?: boolean;
};

type ContestantUnavailabilityRow = {
  preparationId: string;
  agentId: string;
  reason: string;
  reportedAt: string | number;
};

type AgentHostLeaseRow = {
  preparationId: string;
  agentId: string;
  ownerId: string;
  executableBuildId?: unknown;
  claimedAt: string | number;
  heartbeatAt: string | number;
  expiresAt: string | number;
};

type PublicPreparationActivityRow = {
  preparationId: string;
  agentId: string;
  activity: string;
  mode: string;
  occurredAt: string | number;
  activitySequence: string | number | bigint;
};

type DuelPreparationStrategyContextRow = {
  preparationId: string;
  agentId: string;
  hostOwnerId: string;
  policyVersion: string;
  protocolVersion: string;
  agentName: string;
  opponentName: string;
  ownPublicProfile: unknown;
  opponentPublicProfile: unknown;
  opponentHistorySummary: unknown;
  boundAt: string | number;
};

type CompetitiveSnapshotRow = {
  preparationId: string;
  snapshotVersion: string | number;
  cycleId: string;
  duelId: string;
  duelKey: string;
  snapshotDigest: string;
  snapshot: CompetitiveSnapshot;
  frozenAt: string | number;
  lockedAt: string | number | null;
  duelStartedAt: string | number | null;
  recoveredAt: string | number | null;
  lifecycleStatus: "retired" | "frozen" | "terminal";
  terminalOutcome: "win" | "draw" | "cancelled" | null;
  terminalWinnerId: string | null;
  terminalWinReason: string | null;
  terminalCancellationReason: string | null;
  terminalSeed: string | null;
  terminalReplayHash: string | null;
  terminalAt: string | number | null;
};

export type CompetitiveSnapshotTerminal = {
  outcome: "win" | "draw" | "cancelled";
  winnerId: string | null;
  winReason: string | null;
  cancellationReason: string | null;
  seed: string | null;
  replayHash: string | null;
  terminalAt: number;
};

export type PersistedCompetitiveSnapshot = {
  preparation: DuelPreparationSnapshot;
  snapshot: CompetitiveSnapshot;
  digest: string;
  lockedAt: number | null;
  duelStartedAt: number | null;
  recoveredAt: number | null;
  lifecycleStatus: "retired" | "frozen" | "terminal";
  terminal: CompetitiveSnapshotTerminal | null;
};

/**
 * A process-start custody fence for contestants whose immutable competitive
 * snapshot still needs to be recovered or retired by the active authority.
 */
export type CompetitiveRecoveryCustodyHold = {
  preparationId: string;
  agent1Id: string;
  agent2Id: string;
};

export const DUEL_COMPETITIVE_RECOVERY_CUSTODY_HOLD_EVENT =
  "duel:competitive:recovery_custody_hold";

export const DUEL_TRANSITION_EVENT_TYPES = [
  "preparation_selected",
  "contestant_ready",
  "preparation_frozen",
  "competitive_snapshot_frozen",
  "authority_claimed",
  "market_locked",
  "duel_started",
  "terminal_committed",
  "recovery_committed",
  "preparation_cancelled",
  "preparation_expired",
] as const;

export type DuelTransitionEventType =
  (typeof DUEL_TRANSITION_EVENT_TYPES)[number];

export type DuelTransitionEvent = {
  eventSequence: string;
  eventKey: string;
  eventSource: "runtime" | "migration_backfill";
  eventType: DuelTransitionEventType;
  preparationId: string;
  occurredAt: number;
  fencingToken: string | null;
  preparationVersion: number | null;
  agent1Id: string;
  agent2Id: string;
  actorAgentId: string | null;
  cycleId: string | null;
  duelId: string | null;
  snapshotDigest: string | null;
  terminalOutcome: "win" | "draw" | "cancelled" | null;
  winnerId: string | null;
  winReason: string | null;
  reason: string | null;
  terminalSeed: string | null;
  replayHash: string | null;
};

type DuelTransitionEventRow = Omit<
  DuelTransitionEvent,
  "eventSequence" | "occurredAt" | "fencingToken" | "preparationVersion"
> & {
  eventSequence: string | number | bigint;
  occurredAt: string | number;
  fencingToken: string | number | bigint | null;
  preparationVersion: string | number | null;
};

type QueryablePool = Pick<pg.Pool, "query" | "connect">;
type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type CompetitiveDamageAggregateRow = {
  actorId: string;
  totalDamage: string | number;
};

/**
 * Commit leaderboard and model-history aggregates inside the same transaction
 * as immutable terminal truth. The terminal row is the idempotency boundary:
 * this helper is reached only for the first successful frozen -> terminal
 * transition, so a lost COMMIT response or process restart cannot double count.
 *
 * Frozen wins/losses are a lower-bound repair anchor for deployments that may
 * have lost an older best-effort aggregate write. GREATEST never rolls back a
 * newer aggregate maintained by another duel surface.
 */
const persistCompetitiveTerminalStats = async (
  queryable: Queryable,
  snapshot: CompetitiveSnapshot,
  terminal: CompetitiveSnapshotTerminal,
): Promise<void> => {
  if (terminal.outcome === "cancelled") return;

  const damageResult = await queryable.query<CompetitiveDamageAggregateRow>(
    `
      SELECT "actorId", SUM((observation->>'amount')::numeric)::text AS "totalDamage"
      FROM streaming_duel_action_observations
      WHERE "cycleId" = $1
        AND "duelId" = $2
        AND action = 'damage'
      GROUP BY "actorId"
    `,
    [snapshot.cycleId, snapshot.duelId],
  );
  const damageByAgent = new Map<string, number>();
  for (const row of damageResult.rows) {
    const totalDamage = Number(row.totalDamage);
    if (!Number.isSafeInteger(totalDamage) || totalDamage < 0) {
      throw new Error("competitive_terminal_stats_damage_invalid");
    }
    damageByAgent.set(row.actorId, totalDamage);
  }

  const updates = buildCompetitiveTerminalStatUpdates(
    snapshot,
    terminal,
    damageByAgent,
  );
  for (const update of updates) {
    await queryable.query(
      `
        INSERT INTO player_combat_stats (
          "playerId", "totalDuelWins", "totalDuelLosses", "updatedAt"
        ) VALUES ($1, $2, $3, $4::bigint)
        ON CONFLICT ("playerId") DO UPDATE SET
          "totalDuelWins" = GREATEST(
            player_combat_stats."totalDuelWins" + $5,
            $2
          ),
          "totalDuelLosses" = GREATEST(
            player_combat_stats."totalDuelLosses" + $6,
            $3
          ),
          "updatedAt" = GREATEST(
            player_combat_stats."updatedAt",
            $4::bigint
          )
      `,
      [
        update.agentId,
        update.anchoredWins,
        update.anchoredLosses,
        terminal.terminalAt,
        update.winDelta,
        update.lossDelta,
      ],
    );

    await queryable.query(
      `
        INSERT INTO agent_duel_stats (
          "characterId", "agentName", provider, model, wins, losses, draws,
          "totalDamageDealt", "totalDamageTaken", "killStreak",
          "currentStreak", "lastDuelAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          CASE WHEN $10 = 'win' THEN 1 ELSE 0 END,
          CASE WHEN $10 = 'win' THEN 1 ELSE 0 END,
          $11::bigint, $11::bigint
        )
        ON CONFLICT ("characterId") DO UPDATE SET
          "agentName" = EXCLUDED."agentName",
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          wins = GREATEST(agent_duel_stats.wins + $12, $5),
          losses = GREATEST(agent_duel_stats.losses + $13, $6),
          draws = agent_duel_stats.draws + $7,
          "totalDamageDealt" = agent_duel_stats."totalDamageDealt" + $8,
          "totalDamageTaken" = agent_duel_stats."totalDamageTaken" + $9,
          "killStreak" = CASE
            WHEN $10 = 'win' THEN GREATEST(
              agent_duel_stats."killStreak",
              agent_duel_stats."currentStreak" + 1
            )
            ELSE agent_duel_stats."killStreak"
          END,
          "currentStreak" = CASE
            WHEN $10 = 'win' THEN agent_duel_stats."currentStreak" + 1
            WHEN $10 = 'loss' THEN 0
            ELSE agent_duel_stats."currentStreak"
          END,
          "lastDuelAt" = GREATEST(
            COALESCE(agent_duel_stats."lastDuelAt", 0),
            $11::bigint
          ),
          "updatedAt" = GREATEST(
            agent_duel_stats."updatedAt",
            $11::bigint
          )
      `,
      [
        update.agentId,
        update.name,
        update.provider,
        update.model,
        update.anchoredWins,
        update.anchoredLosses,
        update.drawDelta,
        update.damageDealt,
        update.damageTaken,
        update.result,
        terminal.terminalAt,
        update.winDelta,
        update.lossDelta,
      ],
    );
  }
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXECUTABLE_BUILD_ID_PATTERN = /^[0-9a-f]{64}$/;
const CANCELLATION_REASON_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
const COMPETITIVE_WIN_REASONS = new Set([
  "kill",
  "forfeit",
  "hp_advantage",
  "damage_advantage",
]);
const UINT64_MAX = 18_446_744_073_709_551_615n;

const finiteTimestamp = (value: string | number | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const mapCompetitiveSnapshot = (
  row: CompetitiveSnapshotRow | undefined,
): Omit<PersistedCompetitiveSnapshot, "preparation"> | null => {
  if (!row) return null;
  const frozenAt = finiteTimestamp(row.frozenAt);
  const lockedAt = finiteTimestamp(row.lockedAt);
  const duelStartedAt = finiteTimestamp(row.duelStartedAt);
  const recoveredAt = finiteTimestamp(row.recoveredAt);
  const terminalAt = finiteTimestamp(row.terminalAt);
  const lifecycleStatus = row.lifecycleStatus;
  assertValidCompetitiveSnapshot(row.snapshot);
  const terminal =
    (lifecycleStatus === "terminal" || lifecycleStatus === "retired") &&
    terminalAt !== null
      ? {
          outcome: row.terminalOutcome!,
          winnerId: row.terminalWinnerId,
          winReason: row.terminalWinReason,
          cancellationReason: row.terminalCancellationReason,
          seed: row.terminalSeed,
          replayHash: row.terminalReplayHash,
          terminalAt,
        }
      : null;
  if (
    frozenAt === null ||
    Number(row.snapshotVersion) !== row.snapshot.snapshotVersion ||
    row.preparationId !== row.snapshot.preparationId ||
    row.cycleId !== row.snapshot.cycleId ||
    row.duelId !== row.snapshot.duelId ||
    row.duelKey !== row.snapshot.duelKey ||
    frozenAt !== row.snapshot.frozenAt ||
    !/^[0-9a-f]{64}$/.test(row.snapshotDigest) ||
    digestCompetitiveSnapshot(row.snapshot) !== row.snapshotDigest ||
    !["retired", "frozen", "terminal"].includes(lifecycleStatus) ||
    (lockedAt !== null && lockedAt < frozenAt) ||
    (duelStartedAt !== null &&
      (lockedAt === null || duelStartedAt < lockedAt)) ||
    (terminal !== null &&
      duelStartedAt !== null &&
      terminal.terminalAt < duelStartedAt) ||
    (lifecycleStatus === "frozen" &&
      (terminal !== null || recoveredAt !== null)) ||
    (lifecycleStatus === "terminal" &&
      (terminal === null || recoveredAt !== null)) ||
    (lifecycleStatus === "retired" &&
      !(
        (terminal !== null &&
          recoveredAt !== null &&
          recoveredAt >= terminal.terminalAt) ||
        (terminal === null &&
          lockedAt === null &&
          duelStartedAt === null &&
          recoveredAt === null)
      )) ||
    (terminal !== null &&
      !isValidCompetitiveSnapshotTerminal(terminal, row.snapshot))
  ) {
    throw new Error("Invalid persisted competitive snapshot row");
  }
  return {
    snapshot: row.snapshot,
    digest: row.snapshotDigest,
    lockedAt,
    duelStartedAt,
    recoveredAt,
    lifecycleStatus,
    terminal,
  };
};

const isValidCompetitiveSnapshotTerminal = (
  terminal: CompetitiveSnapshotTerminal,
  snapshot?: CompetitiveSnapshot,
): boolean => {
  if (
    !["win", "draw", "cancelled"].includes(terminal.outcome) ||
    !Number.isSafeInteger(terminal.terminalAt) ||
    terminal.terminalAt <= 0 ||
    (snapshot !== undefined && terminal.terminalAt < snapshot.frozenAt)
  ) {
    return false;
  }
  const validSeed = (seed: string | null): seed is string => {
    if (!seed || !/^(0|[1-9][0-9]{0,19})$/.test(seed)) return false;
    try {
      return BigInt(seed) <= UINT64_MAX;
    } catch {
      return false;
    }
  };
  if (terminal.outcome === "win") {
    return Boolean(
      terminal.winnerId &&
      (snapshot === undefined ||
        snapshot.contestants.some(
          (contestant) => contestant.agentId === terminal.winnerId,
        )) &&
      terminal.winReason &&
      COMPETITIVE_WIN_REASONS.has(terminal.winReason) &&
      !terminal.cancellationReason &&
      validSeed(terminal.seed) &&
      terminal.replayHash &&
      SHA256_HEX.test(terminal.replayHash),
    );
  }
  if (terminal.outcome === "draw") {
    return Boolean(
      terminal.winnerId === null &&
      terminal.winReason === "draw" &&
      terminal.cancellationReason === "draw" &&
      validSeed(terminal.seed) &&
      terminal.replayHash &&
      SHA256_HEX.test(terminal.replayHash),
    );
  }
  return (
    terminal.winnerId === null &&
    terminal.winReason === null &&
    terminal.cancellationReason !== null &&
    CANCELLATION_REASON_PATTERN.test(terminal.cancellationReason) &&
    terminal.seed === null &&
    terminal.replayHash === null
  );
};

const canonicalCompetitiveTerminal = (
  terminal: CompetitiveSnapshotTerminal | null,
): string =>
  JSON.stringify(
    terminal
      ? {
          outcome: terminal.outcome,
          winnerId: terminal.winnerId,
          winReason: terminal.winReason,
          cancellationReason: terminal.cancellationReason,
          seed: terminal.seed,
          replayHash: terminal.replayHash,
          terminalAt: terminal.terminalAt,
        }
      : null,
  );

const mapTransitionEvent = (
  row: DuelTransitionEventRow | undefined,
): DuelTransitionEvent | null => {
  if (!row) return null;
  let eventSequence: bigint;
  try {
    eventSequence = BigInt(row.eventSequence);
  } catch {
    throw new Error("Invalid persisted duel transition event sequence");
  }
  const occurredAt = finiteTimestamp(row.occurredAt);
  const fencingToken =
    row.fencingToken === null ? null : String(row.fencingToken);
  const preparationVersion =
    row.preparationVersion === null ? null : Number(row.preparationVersion);
  const snapshotFields = [row.cycleId, row.duelId, row.snapshotDigest];
  const hasSnapshot = snapshotFields.every((value) => value !== null);
  const hasPartialSnapshot = snapshotFields.some((value) => value !== null);
  const competitiveEvent = [
    "competitive_snapshot_frozen",
    "authority_claimed",
    "market_locked",
    "duel_started",
    "terminal_committed",
    "recovery_committed",
  ].includes(row.eventType);
  const terminal =
    row.eventType === "terminal_committed" && row.terminalOutcome !== null
      ? {
          outcome: row.terminalOutcome,
          winnerId: row.winnerId,
          winReason: row.winReason,
          cancellationReason: row.reason,
          seed: row.terminalSeed,
          replayHash: row.replayHash,
          terminalAt: occurredAt ?? -1,
        }
      : null;
  if (
    eventSequence <= 0n ||
    occurredAt === null ||
    !DUEL_TRANSITION_EVENT_TYPES.includes(row.eventType) ||
    !["runtime", "migration_backfill"].includes(row.eventSource) ||
    !row.eventKey ||
    !row.preparationId ||
    !row.agent1Id ||
    !row.agent2Id ||
    row.agent1Id === row.agent2Id ||
    (row.eventSource === "runtime" &&
      (fencingToken === null ||
        !/^[1-9][0-9]*$/.test(fencingToken) ||
        preparationVersion === null ||
        !Number.isSafeInteger(preparationVersion) ||
        preparationVersion < 1)) ||
    (row.eventSource === "migration_backfill" &&
      (fencingToken !== null || preparationVersion !== null)) ||
    (row.eventType === "contestant_ready") !== (row.actorAgentId !== null) ||
    (row.actorAgentId !== null &&
      row.actorAgentId !== row.agent1Id &&
      row.actorAgentId !== row.agent2Id) ||
    hasPartialSnapshot !== hasSnapshot ||
    competitiveEvent !== hasSnapshot ||
    (row.snapshotDigest !== null && !SHA256_HEX.test(row.snapshotDigest)) ||
    (row.eventType === "terminal_committed") !== (terminal !== null) ||
    (terminal !== null &&
      (!isValidCompetitiveSnapshotTerminal(terminal) ||
        (terminal.winnerId !== null &&
          terminal.winnerId !== row.agent1Id &&
          terminal.winnerId !== row.agent2Id))) ||
    (terminal === null &&
      (row.terminalOutcome !== null ||
        row.winnerId !== null ||
        row.winReason !== null ||
        row.terminalSeed !== null ||
        row.replayHash !== null ||
        (row.eventType === "preparation_cancelled"
          ? row.reason === null || !CANCELLATION_REASON_PATTERN.test(row.reason)
          : row.reason !== null)))
  ) {
    throw new Error("Invalid persisted duel transition event row");
  }
  return {
    ...row,
    eventSequence: eventSequence.toString(),
    occurredAt,
    fencingToken,
    preparationVersion,
  };
};

type RuntimeTransitionInput = {
  eventType: DuelTransitionEventType;
  preparation: DuelPreparationSnapshot;
  occurredAt: number;
  actorAgentId?: string;
  competitive?: { snapshot: CompetitiveSnapshot; digest: string };
  terminal?: CompetitiveSnapshotTerminal;
  reason?: string;
};

const transitionEventKey = (input: RuntimeTransitionInput): string => {
  const qualifier =
    input.eventType === "contestant_ready"
      ? input.actorAgentId
      : input.eventType === "authority_claimed"
        ? input.preparation.fencingToken
        : null;
  return `${input.preparation.preparationId}:${input.eventType}${qualifier ? `:${qualifier}` : ""}`;
};

const withoutEventSequence = (
  event: DuelTransitionEvent,
): Omit<DuelTransitionEvent, "eventSequence"> => {
  const { eventSequence: _eventSequence, ...rest } = event;
  return rest;
};

const insertRuntimeTransitionEvent = async (
  queryable: Queryable,
  input: RuntimeTransitionInput,
): Promise<void> => {
  const competitive = input.competitive;
  const terminal = input.terminal;
  const expected: Omit<DuelTransitionEvent, "eventSequence"> = {
    eventKey: transitionEventKey(input),
    eventSource: "runtime",
    eventType: input.eventType,
    preparationId: input.preparation.preparationId,
    occurredAt: input.occurredAt,
    fencingToken: input.preparation.fencingToken,
    preparationVersion: input.preparation.version,
    agent1Id: input.preparation.agent1Id,
    agent2Id: input.preparation.agent2Id,
    actorAgentId: input.actorAgentId ?? null,
    cycleId: competitive?.snapshot.cycleId ?? null,
    duelId: competitive?.snapshot.duelId ?? null,
    snapshotDigest: competitive?.digest ?? null,
    terminalOutcome: terminal?.outcome ?? null,
    winnerId: terminal?.winnerId ?? null,
    winReason: terminal?.winReason ?? null,
    reason: terminal?.cancellationReason ?? input.reason ?? null,
    terminalSeed: terminal?.seed ?? null,
    replayHash: terminal?.replayHash ?? null,
  };
  const inserted = await queryable.query<DuelTransitionEventRow>(
    `
      INSERT INTO streaming_duel_transition_events (
        "eventKey", "eventSource", "eventType", "preparationId",
        "occurredAt", "fencingToken", "preparationVersion",
        "agent1Id", "agent2Id", "actorAgentId", "cycleId", "duelId",
        "snapshotDigest", "terminalOutcome", "winnerId", "winReason",
        reason, "terminalSeed", "replayHash"
      ) VALUES (
        $1, 'runtime', $2, $3, $4::bigint, $5::bigint, $6,
        $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
      )
      ON CONFLICT ("eventKey") DO NOTHING
      RETURNING *
    `,
    [
      expected.eventKey,
      expected.eventType,
      expected.preparationId,
      expected.occurredAt,
      expected.fencingToken,
      expected.preparationVersion,
      expected.agent1Id,
      expected.agent2Id,
      expected.actorAgentId,
      expected.cycleId,
      expected.duelId,
      expected.snapshotDigest,
      expected.terminalOutcome,
      expected.winnerId,
      expected.winReason,
      expected.reason,
      expected.terminalSeed,
      expected.replayHash,
    ],
  );
  const existingResult = inserted.rows[0]
    ? inserted
    : await queryable.query<DuelTransitionEventRow>(
        `SELECT * FROM streaming_duel_transition_events WHERE "eventKey" = $1`,
        [expected.eventKey],
      );
  const persisted = mapTransitionEvent(existingResult.rows[0]);
  if (
    !persisted ||
    canonicalCompetitiveSnapshotJson(withoutEventSequence(persisted)) !==
      canonicalCompetitiveSnapshotJson(expected)
  ) {
    throw new Error("duel_transition_event_conflict");
  }
};

const mapPreparation = (
  row: PreparationRow | undefined,
): DuelPreparationSnapshot | null => {
  if (!row) return null;
  const selectedAt = finiteTimestamp(row.selectedAt);
  const expiresAt = finiteTimestamp(row.expiresAt);
  const version = Number(row.version);
  if (
    selectedAt === null ||
    expiresAt === null ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new Error("Invalid persisted duel preparation row");
  }
  return {
    preparationId: row.preparationId,
    fencingToken: String(row.fencingToken),
    agent1Id: row.agent1Id,
    agent2Id: row.agent2Id,
    allowedBankActions: [...row.allowedBankActions],
    status: row.status,
    selectedAt,
    expiresAt,
    agent1ReadyAt: finiteTimestamp(row.agent1ReadyAt),
    agent2ReadyAt: finiteTimestamp(row.agent2ReadyAt),
    agent1PlanEvidence: row.agent1PlanEvidence
      ? normalizeCompetitivePreparationEvidence(row.agent1PlanEvidence)
      : null,
    agent2PlanEvidence: row.agent2PlanEvidence
      ? normalizeCompetitivePreparationEvidence(row.agent2PlanEvidence)
      : null,
    frozenAt: finiteTimestamp(row.frozenAt),
    cancelledAt: finiteTimestamp(row.cancelledAt),
    cancellationReason: row.cancellationReason,
    version,
  };
};

const mapContestantUnavailability = (
  row: ContestantUnavailabilityRow | undefined,
): DuelPreparationContestantUnavailabilityReport | null => {
  if (!row) return null;
  const reportedAt = finiteTimestamp(row.reportedAt);
  if (
    reportedAt === null ||
    row.reason !== DUEL_PREPARATION_CONTESTANT_UNAVAILABILITY_REASON ||
    !row.preparationId ||
    !row.agentId
  ) {
    throw new Error("invalid duel preparation unavailability report");
  }
  return {
    preparationId: row.preparationId,
    agentId: row.agentId,
    reason: DUEL_PREPARATION_CONTESTANT_UNAVAILABILITY_REASON,
    reportedAt,
  };
};

const mapAgentHostLease = (
  row: AgentHostLeaseRow | undefined,
): DuelPreparationAgentHostLease | null => {
  if (!row) return null;
  const claimedAt = finiteTimestamp(row.claimedAt);
  const heartbeatAt = finiteTimestamp(row.heartbeatAt);
  const expiresAt = finiteTimestamp(row.expiresAt);
  const executableBuildId = row.executableBuildId ?? null;
  if (
    !row.preparationId ||
    !row.agentId ||
    !UUID_PATTERN.test(row.ownerId) ||
    !(
      executableBuildId === null ||
      (typeof executableBuildId === "string" &&
        EXECUTABLE_BUILD_ID_PATTERN.test(executableBuildId))
    ) ||
    claimedAt === null ||
    heartbeatAt === null ||
    expiresAt === null ||
    heartbeatAt < claimedAt ||
    expiresAt <= heartbeatAt
  ) {
    throw new Error("invalid duel preparation agent host lease");
  }
  return {
    preparationId: row.preparationId,
    agentId: row.agentId,
    ownerId: row.ownerId,
    executableBuildId,
    claimedAt,
    heartbeatAt,
    expiresAt,
  };
};

const PUBLIC_PREPARATION_ACTIVITIES = new Set<string>(
  STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITIES,
);
const PUBLIC_PREPARATION_MODES = new Set<string>(
  STREAMING_DUEL_PUBLIC_PREPARATION_MODES,
);

const mapPublicPreparationActivity = (
  row: PublicPreparationActivityRow | undefined,
): DuelPreparationPublicActivityRecord | null => {
  if (!row) return null;
  const occurredAt = finiteTimestamp(row.occurredAt);
  const revision = Number(row.activitySequence);
  if (
    !row.preparationId ||
    !row.agentId ||
    occurredAt === null ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !PUBLIC_PREPARATION_ACTIVITIES.has(row.activity) ||
    !PUBLIC_PREPARATION_MODES.has(row.mode) ||
    ((row.activity === "planning" || row.activity === "reassessing") &&
      row.mode !== "working")
  ) {
    throw new Error("invalid durable public preparation activity");
  }
  return Object.freeze({
    preparationId: row.preparationId,
    agentId: row.agentId,
    activity: row.activity as StreamingDuelPublicPreparationActivity,
    mode: row.mode as StreamingDuelPublicPreparationMode,
    occurredAt,
    revision,
  });
};

const normalizeExactStrategyPublicProfile = (
  value: unknown,
): ExternalDuelPreparationPublicProfile | null | undefined => {
  if (value === null) return null;
  const normalized = normalizeExternalDuelPreparationPublicProfile(value);
  if (
    !normalized ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "narrative" ||
    keys[1] !== "pillars" ||
    record.narrative !== normalized.narrative ||
    !Array.isArray(record.pillars) ||
    record.pillars.length !== normalized.pillars.length ||
    record.pillars.some((pillar, index) => pillar !== normalized.pillars[index])
  ) {
    return undefined;
  }
  return {
    narrative: normalized.narrative,
    pillars: [...normalized.pillars],
  };
};

const normalizeExactOpponentHistorySummary = (
  value: unknown,
): ExternalDuelPreparationOpponentHistorySummary | undefined => {
  const normalized =
    normalizeExternalDuelPreparationOpponentHistorySummary(value);
  if (
    !normalized ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("|") !==
      "observedOpponentOpeningStyleFocus|recent|sampleSize" ||
    !Array.isArray(record.recent) ||
    record.recent.length !== normalized.recent.length ||
    record.recent.some((candidate, index) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        return true;
      }
      const row = candidate as Record<string, unknown>;
      const expected = normalized.recent[index]!;
      return (
        Object.keys(row).sort().join("|") !==
          "opponentOpeningStyle|ownOpeningStyle|result|winReason" ||
        row.result !== expected.result ||
        row.ownOpeningStyle !== expected.ownOpeningStyle ||
        row.opponentOpeningStyle !== expected.opponentOpeningStyle ||
        row.winReason !== expected.winReason
      );
    })
  ) {
    return undefined;
  }
  return {
    sampleSize: normalized.sampleSize,
    observedOpponentOpeningStyleFocus:
      normalized.observedOpponentOpeningStyleFocus,
    recent: normalized.recent.map((entry) => ({ ...entry })),
  };
};

const mapDuelPreparationStrategyContext = (
  row: DuelPreparationStrategyContextRow | undefined,
): DuelPreparationStrategyContext | null => {
  if (!row) return null;
  const boundAt = finiteTimestamp(row.boundAt);
  const agentName = normalizeExternalDuelPreparationPublicName(row.agentName);
  const opponentName = normalizeExternalDuelPreparationPublicName(
    row.opponentName,
  );
  const ownPublicProfile = normalizeExactStrategyPublicProfile(
    row.ownPublicProfile,
  );
  const opponentPublicProfile = normalizeExactStrategyPublicProfile(
    row.opponentPublicProfile,
  );
  const opponentHistorySummary = normalizeExactOpponentHistorySummary(
    row.opponentHistorySummary,
  );
  if (
    !UUID_PATTERN.test(row.preparationId) ||
    !row.agentId ||
    row.agentId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(row.agentId) ||
    !UUID_PATTERN.test(row.hostOwnerId) ||
    row.policyVersion !== DUEL_PREPARATION_ROLE_POLICY_VERSION ||
    row.protocolVersion !==
      EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION ||
    !agentName ||
    agentName !== row.agentName ||
    !opponentName ||
    opponentName !== row.opponentName ||
    ownPublicProfile === undefined ||
    opponentPublicProfile === undefined ||
    opponentHistorySummary === undefined ||
    boundAt === null
  ) {
    throw new Error("invalid durable duel preparation strategy context");
  }
  return Object.freeze({
    preparationId: row.preparationId,
    agentId: row.agentId,
    hostOwnerId: row.hostOwnerId,
    policyVersion: DUEL_PREPARATION_ROLE_POLICY_VERSION,
    protocolVersion: EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
    agentName,
    opponentName,
    ownPublicProfile,
    opponentPublicProfile,
    opponentHistorySummary,
    boundAt,
  });
};

const equalStrategyPublicProfiles = (
  left: ExternalDuelPreparationPublicProfile | null,
  right: ExternalDuelPreparationPublicProfile | null,
): boolean =>
  left === null || right === null
    ? left === right
    : left.narrative === right.narrative &&
      left.pillars.length === right.pillars.length &&
      left.pillars.every((pillar, index) => pillar === right.pillars[index]);

const sameDuelPreparationStrategyContext = (
  persisted: DuelPreparationStrategyContext,
  input: Omit<DuelPreparationStrategyContext, "boundAt">,
): boolean =>
  persisted.preparationId === input.preparationId &&
  persisted.agentId === input.agentId &&
  persisted.hostOwnerId === input.hostOwnerId &&
  persisted.policyVersion === input.policyVersion &&
  persisted.protocolVersion === input.protocolVersion &&
  persisted.agentName === input.agentName &&
  persisted.opponentName === input.opponentName &&
  equalStrategyPublicProfiles(
    persisted.ownPublicProfile,
    input.ownPublicProfile,
  ) &&
  equalStrategyPublicProfiles(
    persisted.opponentPublicProfile,
    input.opponentPublicProfile,
  ) &&
  persisted.opponentHistorySummary.sampleSize ===
    input.opponentHistorySummary.sampleSize &&
  persisted.opponentHistorySummary.observedOpponentOpeningStyleFocus ===
    input.opponentHistorySummary.observedOpponentOpeningStyleFocus &&
  persisted.opponentHistorySummary.recent.length ===
    input.opponentHistorySummary.recent.length &&
  persisted.opponentHistorySummary.recent.every((entry, index) => {
    const other = input.opponentHistorySummary.recent[index];
    return (
      other !== undefined &&
      entry.result === other.result &&
      entry.ownOpeningStyle === other.ownOpeningStyle &&
      entry.opponentOpeningStyle === other.opponentOpeningStyle &&
      entry.winReason === other.winReason
    );
  });

const validateHostLeaseDuration = (leaseDurationMs: number): void => {
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < MIN_DUEL_PREPARATION_HOST_LEASE_MS ||
    leaseDurationMs > MAX_DUEL_PREPARATION_HOST_LEASE_MS
  ) {
    throw new Error(
      `leaseDurationMs must be between ${MIN_DUEL_PREPARATION_HOST_LEASE_MS} and ${MAX_DUEL_PREPARATION_HOST_LEASE_MS}`,
    );
  }
};

const hasContestantUnavailability = async (
  queryable: Queryable,
  preparationId: string,
): Promise<boolean> => {
  const result = await queryable.query<{ unavailable: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM streaming_duel_preparation_unavailability_reports
       WHERE "preparationId" = $1
     ) AS unavailable`,
    [preparationId],
  );
  return result.rows[0]?.unavailable === true;
};

const hasActiveContestantHostLease = async (
  queryable: Queryable,
  preparationId: string,
  agentId: string,
  databaseNow: number,
): Promise<boolean> => {
  const result = await queryable.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM streaming_duel_preparation_agent_host_leases
       WHERE "preparationId" = $1
         AND "agentId" = $2
         AND "expiresAt" > $3::bigint
     ) AS active`,
    [preparationId, agentId, databaseNow],
  );
  return result.rows[0]?.active === true;
};

const haveActiveContestantHostLeases = async (
  queryable: Queryable,
  preparation: DuelPreparationSnapshot,
  databaseNow: number,
): Promise<boolean> => {
  const result = await queryable.query<{ activeCount: string | number }>(
    `SELECT COUNT(*)::integer AS "activeCount"
       FROM streaming_duel_preparation_agent_host_leases
      WHERE "preparationId" = $1
        AND "agentId" = ANY($2::text[])
        AND "expiresAt" > $3::bigint`,
    [
      preparation.preparationId,
      [preparation.agent1Id, preparation.agent2Id],
      databaseNow,
    ],
  );
  return Number(result.rows[0]?.activeCount ?? 0) === 2;
};

const validateFencingToken = (value: string): void => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("fencingToken must be a positive integer string");
  }
};

const normalizeAllowedBankActions = (
  actions: readonly DuelPreparationBankAction[],
): DuelPreparationBankAction[] => {
  const requested = new Set(actions);
  if (
    requested.size !== actions.length ||
    !requested.has("open") ||
    [...requested].some(
      (action) => !DUEL_PREPARATION_BANK_ACTIONS.includes(action),
    )
  ) {
    throw new Error("invalid duel preparation bank action set");
  }
  return DUEL_PREPARATION_BANK_ACTIONS.filter((action) =>
    requested.has(action),
  );
};

const SAFE_POLICY_VALUE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMBAT_STYLES = ["melee", "ranged", "mage", "prayer"] as const;

export function normalizeCompetitivePreparationEvidence(
  input: CompetitivePreparationEvidence,
): CompetitivePreparationEvidence {
  const primaryStyle = input?.primaryStyle;
  const planningSource = input?.planningSource;
  const planningPolicyVersion = input?.planningPolicyVersion?.trim() ?? "";
  const modelProvider = input?.modelProvider?.trim() ?? "";
  const model = input?.model?.trim() ?? "";
  const availableStyles = [...new Set(input?.availableStyles ?? [])].sort();
  const tacticalStrategy =
    input?.tacticalStrategy === undefined
      ? undefined
      : normalizeCompetitiveTacticalStrategy(
          input.tacticalStrategy,
          availableStyles.filter(
            (style): style is SwitchableStreamingCombatRole =>
              style === "melee" || style === "ranged" || style === "mage",
          ),
        );
  if (
    !COMBAT_STYLES.includes(primaryStyle) ||
    !availableStyles.includes(primaryStyle) ||
    availableStyles.length === 0 ||
    availableStyles.some((style) => !COMBAT_STYLES.includes(style)) ||
    !["model", "deterministic", "diagnostic"].includes(planningSource) ||
    !SAFE_POLICY_VALUE.test(planningPolicyVersion) ||
    modelProvider.length === 0 ||
    modelProvider.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(modelProvider) ||
    model.length === 0 ||
    model.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(model) ||
    (planningSource === "diagnostic") !==
      (input.agentPolicyFingerprint === null) ||
    (planningSource !== "diagnostic" &&
      (primaryStyle === "prayer" || availableStyles.includes("prayer"))) ||
    (input.agentPolicyFingerprint !== null &&
      !SHA256_HEX.test(input.agentPolicyFingerprint)) ||
    (input.tacticalStrategy !== undefined && tacticalStrategy === null)
  ) {
    throw new Error("invalid competitive preparation evidence");
  }
  return {
    primaryStyle,
    availableStyles,
    planningSource,
    planningPolicyVersion,
    agentPolicyFingerprint: input.agentPolicyFingerprint,
    modelProvider,
    model,
    ...(tacticalStrategy ? { tacticalStrategy } : {}),
  };
}

/**
 * Durable state boundary for the private on-deck window. All transitions use
 * PostgreSQL time and the scheduler authority's fencing token.
 */
export class PostgresDuelPreparationStore {
  constructor(private readonly pool: QueryablePool) {}

  /**
   * List every contestant whose frozen or terminal competitive snapshot is
   * still eligible for authority recovery. Startup uses this read-only view to
   * fence ordinary autonomy before persisted players are spawned; the normal
   * fenced claim remains the sole authority for lifecycle mutation.
   */
  async listCompetitiveRecoveryCustodyHolds(): Promise<
    CompetitiveRecoveryCustodyHold[]
  > {
    const result = await this.pool.query<{
      preparationId: string;
      agent1Id: string;
      agent2Id: string;
      snapshot: CompetitiveSnapshot;
    }>(
      `
        SELECT snapshot."preparationId",
               preparation."agent1Id",
               preparation."agent2Id",
               snapshot.snapshot
        FROM streaming_duel_competitive_snapshots AS snapshot
        JOIN streaming_duel_preparations AS preparation
          ON preparation."preparationId" = snapshot."preparationId"
        WHERE snapshot."lifecycleStatus" IN ('frozen', 'terminal')
          AND snapshot."recoveredAt" IS NULL
          AND preparation.status = 'frozen'
        ORDER BY snapshot."frozenAt" ASC, snapshot."preparationId" ASC
      `,
    );

    return result.rows.map((row) => {
      assertValidCompetitiveSnapshot(row.snapshot);
      if (
        !UUID_PATTERN.test(row.preparationId) ||
        row.snapshot.preparationId !== row.preparationId ||
        typeof row.agent1Id !== "string" ||
        !row.agent1Id ||
        typeof row.agent2Id !== "string" ||
        !row.agent2Id ||
        row.agent1Id === row.agent2Id ||
        row.snapshot.contestants[0].agentId !== row.agent1Id ||
        row.snapshot.contestants[1].agentId !== row.agent2Id
      ) {
        throw new Error("competitive recovery custody hold is invalid");
      }
      return {
        preparationId: row.preparationId,
        agent1Id: row.agent1Id,
        agent2Id: row.agent2Id,
      };
    });
  }

  async create(input: {
    preparationId: string;
    fencingToken: string;
    agent1Id: string;
    agent2Id: string;
    diagnostic: boolean;
    durationMs: number;
    allowedBankActions: readonly DuelPreparationBankAction[];
  }): Promise<DuelPreparationSnapshot> {
    if (!UUID_PATTERN.test(input.preparationId)) {
      throw new Error("preparationId must be a UUID");
    }
    validateFencingToken(input.fencingToken);
    if (
      !input.agent1Id ||
      !input.agent2Id ||
      input.agent1Id === input.agent2Id
    ) {
      throw new Error("duel preparation requires two distinct agents");
    }
    if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
      throw new Error("durationMs must be a positive safe integer");
    }
    const allowedBankActions = normalizeAllowedBankActions(
      input.allowedBankActions,
    );

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize selection cluster-wide. A data-modifying CTE is insufficient
      // because sibling statements share one snapshot and the partial unique
      // index still sees the previous active row until statement completion.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('streaming-duel-preparation', 0))",
      );
      if (!input.diagnostic) {
        await lockAndAssertPersistedStreamingDuelParticipation(client, [
          input.agent1Id,
          input.agent2Id,
        ]);
      }
      const existingResult = await client.query<PreparationRow>(
        `SELECT * FROM streaming_duel_preparations
         WHERE "preparationId" = $1 FOR UPDATE`,
        [input.preparationId],
      );
      const existing = mapPreparation(existingResult.rows[0]);
      if (existing) {
        if (
          existing.fencingToken !== input.fencingToken ||
          existing.agent1Id !== input.agent1Id ||
          existing.agent2Id !== input.agent2Id ||
          existing.allowedBankActions.join(",") !== allowedBankActions.join(",")
        ) {
          throw new Error("preparation_id_conflict");
        }
        await client.query("COMMIT");
        return existing;
      }

      const supersededResult = await client.query<PreparationRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          UPDATE streaming_duel_preparations AS preparation
          SET
            status = 'cancelled',
            "cancelledAt" = clock.now_ms,
            "cancellationReason" = 'superseded',
            version = preparation.version + 1
          FROM clock
          WHERE preparation.status IN ('preparing', 'ready')
          RETURNING preparation.*
        `,
      );
      for (const row of supersededResult.rows) {
        const superseded = mapPreparation(row);
        if (!superseded || superseded.cancelledAt === null) {
          throw new Error("invalid superseded duel preparation");
        }
        await insertRuntimeTransitionEvent(client, {
          eventType: "preparation_cancelled",
          preparation: superseded,
          occurredAt: superseded.cancelledAt,
          reason: "superseded",
        });
      }
      const result = await client.query<PreparationRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          INSERT INTO streaming_duel_preparations (
            "preparationId",
            "fencingToken",
            "agent1Id",
            "agent2Id",
            "allowedBankActions",
            status,
            "selectedAt",
            "expiresAt"
          )
          SELECT $1, $2::bigint, $3, $4, $6::text[], 'preparing', now_ms,
                 now_ms + $5::bigint
          FROM clock
          RETURNING *
        `,
        [
          input.preparationId,
          input.fencingToken,
          input.agent1Id,
          input.agent2Id,
          input.durationMs,
          allowedBankActions,
        ],
      );
      const preparation = mapPreparation(result.rows[0]);
      if (!preparation) {
        throw new Error("duel preparation insert returned no row");
      }
      await insertRuntimeTransitionEvent(client, {
        eventType: "preparation_selected",
        preparation,
        occurredAt: preparation.selectedAt,
      });
      await client.query("COMMIT");
      return preparation;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transition failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async get(preparationId: string): Promise<DuelPreparationSnapshot | null> {
    const result = await this.pool.query<PreparationRow>(
      `SELECT * FROM streaming_duel_preparations
       WHERE "preparationId" = $1`,
      [preparationId],
    );
    return mapPreparation(result.rows[0]);
  }

  async getActive(): Promise<DuelPreparationSnapshot | null> {
    const result = await this.pool.query<PreparationRow>(
      `SELECT * FROM streaming_duel_preparations
       WHERE status IN ('preparing', 'ready')
       ORDER BY "selectedAt" DESC
       LIMIT 1`,
    );
    return mapPreparation(result.rows[0]);
  }

  /**
   * Insert or replay the one immutable public context an authenticated
   * external contestant may receive during this preparation. PostgreSQL's
   * trigger binds the write to the exact live host owner and database clock.
   */
  async bindStrategyContext(
    input: Omit<DuelPreparationStrategyContext, "boundAt">,
  ): Promise<DuelPreparationStrategyContext> {
    const agentName = normalizeExternalDuelPreparationPublicName(
      input.agentName,
    );
    const opponentName = normalizeExternalDuelPreparationPublicName(
      input.opponentName,
    );
    const ownPublicProfile = normalizeExactStrategyPublicProfile(
      input.ownPublicProfile,
    );
    const opponentPublicProfile = normalizeExactStrategyPublicProfile(
      input.opponentPublicProfile,
    );
    const opponentHistorySummary = normalizeExactOpponentHistorySummary(
      input.opponentHistorySummary,
    );
    if (
      !UUID_PATTERN.test(input.preparationId) ||
      !input.agentId ||
      input.agentId.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(input.agentId) ||
      !UUID_PATTERN.test(input.hostOwnerId) ||
      input.policyVersion !== DUEL_PREPARATION_ROLE_POLICY_VERSION ||
      input.protocolVersion !==
        EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION ||
      !agentName ||
      agentName !== input.agentName ||
      !opponentName ||
      opponentName !== input.opponentName ||
      ownPublicProfile === undefined ||
      opponentPublicProfile === undefined ||
      opponentHistorySummary === undefined
    ) {
      throw new Error("invalid duel preparation strategy context input");
    }

    const expected: Omit<DuelPreparationStrategyContext, "boundAt"> = {
      preparationId: input.preparationId,
      agentId: input.agentId,
      hostOwnerId: input.hostOwnerId,
      policyVersion: DUEL_PREPARATION_ROLE_POLICY_VERSION,
      protocolVersion: EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
      agentName,
      opponentName,
      ownPublicProfile,
      opponentPublicProfile,
      opponentHistorySummary,
    };
    const fields = `
      "preparationId", "agentId", "hostOwnerId", "policyVersion",
      "protocolVersion", "agentName", "opponentName",
      "ownPublicProfile", "opponentPublicProfile", "opponentHistorySummary",
      "boundAt"`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<DuelPreparationStrategyContextRow>(
        `INSERT INTO streaming_duel_preparation_strategy_contexts (${fields})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, 0)
         ON CONFLICT ("preparationId", "agentId") DO NOTHING
         RETURNING ${fields}`,
        [
          expected.preparationId,
          expected.agentId,
          expected.hostOwnerId,
          expected.policyVersion,
          expected.protocolVersion,
          expected.agentName,
          expected.opponentName,
          JSON.stringify(expected.ownPublicProfile),
          JSON.stringify(expected.opponentPublicProfile),
          JSON.stringify(expected.opponentHistorySummary),
        ],
      );
      const selected = inserted.rows[0]
        ? inserted
        : await client.query<DuelPreparationStrategyContextRow>(
            `SELECT ${fields}
               FROM streaming_duel_preparation_strategy_contexts
              WHERE "preparationId" = $1 AND "agentId" = $2`,
            [expected.preparationId, expected.agentId],
          );
      const persisted = mapDuelPreparationStrategyContext(selected.rows[0]);
      if (!persisted) {
        throw new Error("duel_preparation_strategy_context_insert_lost");
      }
      if (!sameDuelPreparationStrategyContext(persisted, expected)) {
        throw new Error("duel_preparation_strategy_context_conflict");
      }
      await client.query("COMMIT");
      return persisted;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original binding failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Append one privacy-safe public activity only while the exact contestant's
   * database-clock host lease is active. Adjacent identical presentation is
   * an idempotent replay and returns the existing immutable record.
   */
  async appendPublicActivity(input: {
    preparationId: string;
    agentId: string;
    ownerId: string;
    activity: StreamingDuelPublicPreparationActivity;
    mode: StreamingDuelPublicPreparationMode;
  }): Promise<DuelPreparationPublicActivityRecord> {
    if (!UUID_PATTERN.test(input.preparationId)) {
      throw new Error("preparationId must be a UUID");
    }
    if (
      !input.agentId ||
      input.agentId.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(input.agentId) ||
      !UUID_PATTERN.test(input.ownerId) ||
      !PUBLIC_PREPARATION_ACTIVITIES.has(input.activity) ||
      !PUBLIC_PREPARATION_MODES.has(input.mode) ||
      ((input.activity === "planning" || input.activity === "reassessing") &&
        input.mode !== "working")
    ) {
      throw new Error("invalid public preparation activity input");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const authority = await client.query<{
        agent1Id: string;
        agent2Id: string;
        status: DuelPreparationStatus;
        expiresAt: string | number;
        databaseNow: string | number;
        hostLeaseActive: boolean;
      }>(
        `SELECT
           preparation."agent1Id",
           preparation."agent2Id",
           preparation.status,
           preparation."expiresAt",
           (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "databaseNow",
           EXISTS (
             SELECT 1
             FROM streaming_duel_preparation_agent_host_leases AS lease
             WHERE lease."preparationId" = preparation."preparationId"
               AND lease."agentId" = $2
               AND lease."ownerId" = $3
               AND lease."expiresAt" >
                 (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
           ) AS "hostLeaseActive"
         FROM streaming_duel_preparations AS preparation
         WHERE preparation."preparationId" = $1
         FOR UPDATE OF preparation`,
        [input.preparationId, input.agentId, input.ownerId],
      );
      const row = authority.rows[0];
      const databaseNow = finiteTimestamp(row?.databaseNow ?? null);
      const expiresAt = finiteTimestamp(row?.expiresAt ?? null);
      if (
        !row ||
        databaseNow === null ||
        expiresAt === null ||
        (input.agentId !== row.agent1Id && input.agentId !== row.agent2Id) ||
        (row.status !== "preparing" && row.status !== "ready") ||
        expiresAt <= databaseNow ||
        row.hostLeaseActive !== true
      ) {
        throw new Error("duel_preparation_public_activity_not_authorized");
      }

      const previousResult = await client.query<PublicPreparationActivityRow>(
        `SELECT
             "activitySequence", "preparationId", "agentId",
             activity, mode, "occurredAt"
           FROM streaming_duel_preparation_public_activities
           WHERE "preparationId" = $1 AND "agentId" = $2
           ORDER BY "activitySequence" DESC
           LIMIT 1`,
        [input.preparationId, input.agentId],
      );
      const previous = mapPublicPreparationActivity(previousResult.rows[0]);
      if (
        previous?.activity === input.activity &&
        previous.mode === input.mode
      ) {
        await client.query("COMMIT");
        return previous;
      }

      const inserted = await client.query<PublicPreparationActivityRow>(
        `INSERT INTO streaming_duel_preparation_public_activities (
           "preparationId", "agentId", activity, mode, "occurredAt"
         ) VALUES ($1, $2, $3, $4, $5::bigint)
         RETURNING
           "activitySequence", "preparationId", "agentId",
           activity, mode, "occurredAt"`,
        [
          input.preparationId,
          input.agentId,
          input.activity,
          input.mode,
          databaseNow,
        ],
      );
      const activity = mapPublicPreparationActivity(inserted.rows[0]);
      if (!activity) {
        throw new Error("duel_preparation_public_activity_insert_lost");
      }
      await client.query("COMMIT");
      return activity;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original append failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Load only the bounded tail needed to rebuild each contestant's recap. */
  async listRecentPublicActivities(
    preparationId: string,
    perContestantLimit: number = STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITY_TRAIL_LIMIT,
  ): Promise<readonly DuelPreparationPublicActivityRecord[]> {
    if (!UUID_PATTERN.test(preparationId)) {
      throw new Error("preparationId must be a UUID");
    }
    if (
      !Number.isSafeInteger(perContestantLimit) ||
      perContestantLimit < 1 ||
      perContestantLimit >
        STREAMING_DUEL_PUBLIC_PREPARATION_ACTIVITY_TRAIL_LIMIT
    ) {
      throw new Error("invalid public preparation activity limit");
    }
    const result = await this.pool.query<PublicPreparationActivityRow>(
      `WITH recent AS (
         SELECT
           "activitySequence", "preparationId", "agentId",
           activity, mode, "occurredAt",
           row_number() OVER (
             PARTITION BY "agentId"
             ORDER BY "activitySequence" DESC
           ) AS recent_rank
         FROM streaming_duel_preparation_public_activities
         WHERE "preparationId" = $1
       )
       SELECT
         "activitySequence", "preparationId", "agentId",
         activity, mode, "occurredAt"
       FROM recent
       WHERE recent_rank <= $2::integer
       ORDER BY "activitySequence" ASC`,
      [preparationId, perContestantLimit],
    );
    return Object.freeze(
      result.rows.map((row) => {
        const activity = mapPublicPreparationActivity(row);
        if (!activity || activity.preparationId !== preparationId) {
          throw new Error("invalid durable public preparation activity set");
        }
        return activity;
      }),
    );
  }

  /**
   * Claim one immutable contestant-host identity while preparation is private.
   * Exact retry by the same owner returns the existing lease without extending
   * it. A different owner or an expired lease cannot take the session over.
   */
  async claimContestantHostLease(input: {
    preparationId: string;
    agentId: string;
    ownerId: string;
    executableBuildId?: string | null;
    leaseDurationMs: number;
  }): Promise<DuelPreparationAgentHostLease | null> {
    validateHostLeaseDuration(input.leaseDurationMs);
    const executableBuildId = input.executableBuildId ?? null;
    if (
      !UUID_PATTERN.test(input.preparationId) ||
      !UUID_PATTERN.test(input.ownerId) ||
      !(
        executableBuildId === null ||
        EXECUTABLE_BUILD_ID_PATTERN.test(executableBuildId)
      ) ||
      !input.agentId.trim()
    ) {
      return null;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<PreparationAccessRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          SELECT preparation.*, clock.now_ms AS "databaseNow"
          FROM streaming_duel_preparations AS preparation
          CROSS JOIN clock
          WHERE preparation."preparationId" = $1
          FOR UPDATE OF preparation
        `,
        [input.preparationId],
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const databaseNow = finiteTimestamp(row?.databaseNow ?? null);
      if (
        !preparation ||
        databaseNow === null ||
        (preparation.agent1Id !== input.agentId &&
          preparation.agent2Id !== input.agentId) ||
        !["preparing", "ready"].includes(preparation.status) ||
        preparation.expiresAt <= databaseNow ||
        (await hasContestantUnavailability(client, input.preparationId))
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      const existingResult = await client.query<AgentHostLeaseRow>(
        `SELECT *
           FROM streaming_duel_preparation_agent_host_leases
          WHERE "preparationId" = $1 AND "agentId" = $2
          FOR UPDATE`,
        [input.preparationId, input.agentId],
      );
      const existing = mapAgentHostLease(existingResult.rows[0]);
      if (existing) {
        await client.query("COMMIT");
        return existing.ownerId === input.ownerId &&
          existing.executableBuildId === executableBuildId &&
          existing.expiresAt > databaseNow
          ? existing
          : null;
      }

      const insertedResult = await client.query<AgentHostLeaseRow>(
        `INSERT INTO streaming_duel_preparation_agent_host_leases (
           "preparationId", "agentId", "ownerId", "executableBuildId",
           "claimedAt", "heartbeatAt", "expiresAt"
         ) VALUES ($1, $2, $3, $4, 0, 0, $5)
         RETURNING *`,
        [
          input.preparationId,
          input.agentId,
          input.ownerId,
          executableBuildId,
          input.leaseDurationMs,
        ],
      );
      const inserted = mapAgentHostLease(insertedResult.rows[0]);
      if (!inserted) {
        throw new Error("duel_preparation_agent_host_lease_insert_lost");
      }
      await client.query("COMMIT");
      return inserted;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original claim failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Extend one live lease. Neither an expired lease nor another owner wins. */
  async heartbeatContestantHostLease(input: {
    preparationId: string;
    agentId: string;
    ownerId: string;
    executableBuildId?: string | null;
    leaseDurationMs: number;
  }): Promise<DuelPreparationAgentHostLease | null> {
    validateHostLeaseDuration(input.leaseDurationMs);
    const executableBuildId = input.executableBuildId ?? null;
    if (
      !UUID_PATTERN.test(input.preparationId) ||
      !UUID_PATTERN.test(input.ownerId) ||
      !(
        executableBuildId === null ||
        EXECUTABLE_BUILD_ID_PATTERN.test(executableBuildId)
      ) ||
      !input.agentId.trim()
    ) {
      return null;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<PreparationAccessRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          SELECT preparation.*, clock.now_ms AS "databaseNow"
          FROM streaming_duel_preparations AS preparation
          CROSS JOIN clock
          WHERE preparation."preparationId" = $1
          FOR UPDATE OF preparation
        `,
        [input.preparationId],
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const databaseNow = finiteTimestamp(row?.databaseNow ?? null);
      if (
        !preparation ||
        databaseNow === null ||
        (preparation.agent1Id !== input.agentId &&
          preparation.agent2Id !== input.agentId) ||
        !["preparing", "ready"].includes(preparation.status) ||
        preparation.expiresAt <= databaseNow ||
        (await hasContestantUnavailability(client, input.preparationId))
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      const existingResult = await client.query<AgentHostLeaseRow>(
        `SELECT *
           FROM streaming_duel_preparation_agent_host_leases
          WHERE "preparationId" = $1 AND "agentId" = $2
          FOR UPDATE`,
        [input.preparationId, input.agentId],
      );
      const existing = mapAgentHostLease(existingResult.rows[0]);
      if (
        !existing ||
        existing.ownerId !== input.ownerId ||
        existing.executableBuildId !== executableBuildId ||
        existing.expiresAt <= databaseNow
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      const updatedResult = await client.query<AgentHostLeaseRow>(
        `UPDATE streaming_duel_preparation_agent_host_leases
            SET "heartbeatAt" = 0, "expiresAt" = $5
          WHERE "preparationId" = $1
            AND "agentId" = $2
            AND "ownerId" = $3
            AND "executableBuildId" IS NOT DISTINCT FROM $4
          RETURNING *`,
        [
          input.preparationId,
          input.agentId,
          input.ownerId,
          executableBuildId,
          input.leaseDurationMs,
        ],
      );
      const updated = mapAgentHostLease(updatedResult.rows[0]);
      if (!updated) {
        throw new Error("duel_preparation_agent_host_lease_heartbeat_lost");
      }
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original heartbeat failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Promote a missing/expired private host lease into the existing immutable
   * unavailability report while holding the preparation row lock. This wins or
   * loses atomically against a claim/heartbeat and never manufactures a duel
   * result or market terminal.
   */
  async reportExpiredContestantHostLease(input: {
    preparationId: string;
    claimGraceMs: number;
  }): Promise<DuelPreparationContestantUnavailabilityReport | null> {
    if (
      !UUID_PATTERN.test(input.preparationId) ||
      !Number.isSafeInteger(input.claimGraceMs) ||
      input.claimGraceMs < 1_000 ||
      input.claimGraceMs > MAX_DUEL_PREPARATION_HOST_LEASE_MS
    ) {
      return null;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<PreparationAccessRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          SELECT preparation.*, clock.now_ms AS "databaseNow"
          FROM streaming_duel_preparations AS preparation
          CROSS JOIN clock
          WHERE preparation."preparationId" = $1
          FOR UPDATE OF preparation
        `,
        [input.preparationId],
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const databaseNow = finiteTimestamp(row?.databaseNow ?? null);
      if (
        !preparation ||
        databaseNow === null ||
        !["preparing", "ready"].includes(preparation.status) ||
        preparation.expiresAt <= databaseNow
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      const existingReportResult =
        await client.query<ContestantUnavailabilityRow>(
          `SELECT *
             FROM streaming_duel_preparation_unavailability_reports
            WHERE "preparationId" = $1
            ORDER BY "reportedAt" ASC, "agentId" ASC
            LIMIT 1`,
          [input.preparationId],
        );
      const existingReport = mapContestantUnavailability(
        existingReportResult.rows[0],
      );
      if (existingReport) {
        await client.query("COMMIT");
        return existingReport;
      }

      const leaseResult = await client.query<AgentHostLeaseRow>(
        `SELECT *
           FROM streaming_duel_preparation_agent_host_leases
          WHERE "preparationId" = $1
          ORDER BY "agentId" ASC
          FOR UPDATE`,
        [input.preparationId],
      );
      const leases = new Map(
        leaseResult.rows.map((leaseRow) => {
          const lease = mapAgentHostLease(leaseRow)!;
          return [lease.agentId, lease] as const;
        }),
      );
      const missingClaimExpired =
        databaseNow >= preparation.selectedAt + input.claimGraceMs;
      const unavailableAgentId = [
        preparation.agent1Id,
        preparation.agent2Id,
      ].find((agentId) => {
        const lease = leases.get(agentId);
        return lease ? lease.expiresAt <= databaseNow : missingClaimExpired;
      });
      if (!unavailableAgentId) {
        await client.query("COMMIT");
        return null;
      }

      const insertedResult = await client.query<ContestantUnavailabilityRow>(
        `INSERT INTO streaming_duel_preparation_unavailability_reports (
           "preparationId", "agentId", reason
         ) VALUES ($1, $2, $3)
         RETURNING *`,
        [
          input.preparationId,
          unavailableAgentId,
          DUEL_PREPARATION_CONTESTANT_UNAVAILABILITY_REASON,
        ],
      );
      const inserted = mapContestantUnavailability(insertedResult.rows[0]);
      if (!inserted) {
        throw new Error(
          "duel_preparation_expired_host_lease_report_insert_lost",
        );
      }
      await client.query("COMMIT");
      return inserted;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original expiry/report failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Append one database-timestamped contestant-host report while the session is
   * still private. The preparation row lock serializes this boundary against
   * readiness, freeze, expiry, and scheduler cancellation.
   */
  async reportContestantUnavailable(input: {
    preparationId: string;
    agentId: string;
  }): Promise<DuelPreparationContestantUnavailabilityReport | null> {
    if (!UUID_PATTERN.test(input.preparationId) || !input.agentId.trim()) {
      return null;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<PreparationAccessRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          SELECT preparation.*, clock.now_ms AS "databaseNow"
          FROM streaming_duel_preparations AS preparation
          CROSS JOIN clock
          WHERE preparation."preparationId" = $1
          FOR UPDATE OF preparation
        `,
        [input.preparationId],
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const databaseNow = finiteTimestamp(row?.databaseNow ?? null);
      if (!preparation || databaseNow === null) {
        await client.query("ROLLBACK");
        return null;
      }

      const existingResult = await client.query<ContestantUnavailabilityRow>(
        `SELECT *
           FROM streaming_duel_preparation_unavailability_reports
          WHERE "preparationId" = $1 AND "agentId" = $2`,
        [input.preparationId, input.agentId],
      );
      const existing = mapContestantUnavailability(existingResult.rows[0]);
      if (existing) {
        await client.query("COMMIT");
        return existing;
      }
      if (
        (preparation.agent1Id !== input.agentId &&
          preparation.agent2Id !== input.agentId) ||
        !["preparing", "ready"].includes(preparation.status) ||
        preparation.expiresAt <= databaseNow
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      const insertedResult = await client.query<ContestantUnavailabilityRow>(
        `INSERT INTO streaming_duel_preparation_unavailability_reports (
           "preparationId", "agentId", reason
         ) VALUES ($1, $2, $3)
         RETURNING *`,
        [
          input.preparationId,
          input.agentId,
          DUEL_PREPARATION_CONTESTANT_UNAVAILABILITY_REASON,
        ],
      );
      const inserted = mapContestantUnavailability(insertedResult.rows[0]);
      if (!inserted) {
        throw new Error("duel_preparation_unavailability_insert_lost");
      }
      await client.query("COMMIT");
      return inserted;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original report failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getContestantUnavailability(
    preparationId: string,
  ): Promise<DuelPreparationContestantUnavailabilityReport | null> {
    if (!UUID_PATTERN.test(preparationId)) return null;
    const result = await this.pool.query<ContestantUnavailabilityRow>(
      `SELECT *
         FROM streaming_duel_preparation_unavailability_reports
        WHERE "preparationId" = $1
        ORDER BY "reportedAt" ASC, "agentId" ASC
        LIMIT 1`,
      [preparationId],
    );
    return mapContestantUnavailability(result.rows[0]);
  }

  async markReady(input: {
    preparationId: string;
    fencingToken: string;
    agentId: string;
    planEvidence: CompetitivePreparationEvidence;
  }): Promise<DuelPreparationSnapshot | null> {
    validateFencingToken(input.fencingToken);
    const planEvidence = normalizeCompetitivePreparationEvidence(
      input.planEvidence,
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<PreparationAccessRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          SELECT preparation.*, clock.now_ms AS "databaseNow"
          FROM streaming_duel_preparations AS preparation
          CROSS JOIN clock
          WHERE preparation."preparationId" = $1
          FOR UPDATE OF preparation
        `,
        [input.preparationId],
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const databaseNow = finiteTimestamp(row?.databaseNow ?? null);
      if (
        !preparation ||
        databaseNow === null ||
        preparation.fencingToken !== input.fencingToken ||
        (preparation.agent1Id !== input.agentId &&
          preparation.agent2Id !== input.agentId)
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (
        await hasContestantUnavailability(client, preparation.preparationId)
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (
        !(await hasActiveContestantHostLease(
          client,
          preparation.preparationId,
          input.agentId,
          databaseNow,
        ))
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      const isAgent1 = preparation.agent1Id === input.agentId;
      const existingReadyAt = isAgent1
        ? preparation.agent1ReadyAt
        : preparation.agent2ReadyAt;
      const existingEvidence = isAgent1
        ? preparation.agent1PlanEvidence
        : preparation.agent2PlanEvidence;
      if (existingReadyAt !== null) {
        if (
          !existingEvidence ||
          canonicalCompetitiveSnapshotJson(existingEvidence) !==
            canonicalCompetitiveSnapshotJson(planEvidence) ||
          !["preparing", "ready"].includes(preparation.status)
        ) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query("COMMIT");
        return preparation;
      }
      if (
        preparation.status !== "preparing" ||
        preparation.expiresAt <= databaseNow
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      const nextStatus =
        (isAgent1 ? preparation.agent2ReadyAt : preparation.agent1ReadyAt) !==
        null
          ? "ready"
          : "preparing";
      const updatedResult = await client.query<PreparationRow>(
        `
          UPDATE streaming_duel_preparations
          SET
            "${isAgent1 ? "agent1ReadyAt" : "agent2ReadyAt"}" = $3::bigint,
            "${isAgent1 ? "agent1PlanEvidence" : "agent2PlanEvidence"}" = $4::jsonb,
            status = $5,
            version = version + 1
          WHERE "preparationId" = $1
            AND "fencingToken" = $2::bigint
            AND status = 'preparing'
            AND "${isAgent1 ? "agent1ReadyAt" : "agent2ReadyAt"}" IS NULL
          RETURNING *
        `,
        [
          input.preparationId,
          input.fencingToken,
          databaseNow,
          JSON.stringify(planEvidence),
          nextStatus,
        ],
      );
      const updated = mapPreparation(updatedResult.rows[0]);
      if (!updated) throw new Error("duel_preparation_readiness_lost");
      await insertRuntimeTransitionEvent(client, {
        eventType: "contestant_ready",
        preparation: updated,
        occurredAt: databaseNow,
        actorAgentId: input.agentId,
      });
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original readiness transition failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async freeze(input: {
    preparationId: string;
    fencingToken: string;
  }): Promise<DuelPreparationSnapshot | null> {
    validateFencingToken(input.fencingToken);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<PreparationAccessRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          SELECT preparation.*, clock.now_ms AS "databaseNow"
          FROM streaming_duel_preparations AS preparation
          CROSS JOIN clock
          WHERE preparation."preparationId" = $1
          FOR UPDATE OF preparation
        `,
        [input.preparationId],
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const databaseNow = finiteTimestamp(row?.databaseNow ?? null);
      if (
        !preparation ||
        databaseNow === null ||
        preparation.fencingToken !== input.fencingToken
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (
        await hasContestantUnavailability(client, preparation.preparationId)
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (preparation.status === "frozen") {
        await client.query("COMMIT");
        return preparation;
      }
      if (
        !(await haveActiveContestantHostLeases(
          client,
          preparation,
          databaseNow,
        ))
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (
        preparation.status !== "ready" ||
        preparation.agent1ReadyAt === null ||
        preparation.agent2ReadyAt === null ||
        preparation.expiresAt <= databaseNow
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      const updatedResult = await client.query<PreparationRow>(
        `
          UPDATE streaming_duel_preparations
          SET status = 'frozen',
              "frozenAt" = $3::bigint,
              version = version + 1
          WHERE "preparationId" = $1
            AND "fencingToken" = $2::bigint
            AND status = 'ready'
          RETURNING *
        `,
        [input.preparationId, input.fencingToken, databaseNow],
      );
      const updated = mapPreparation(updatedResult.rows[0]);
      if (!updated) throw new Error("duel_preparation_freeze_lost");
      await insertRuntimeTransitionEvent(client, {
        eventType: "preparation_frozen",
        preparation: updated,
        occurredAt: databaseNow,
      });
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original freeze transition failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically freezes the ready preparation and persists the exact public
   * competitive snapshot before any market-open signal can be emitted.
   */
  async freezeWithCompetitiveSnapshot(input: {
    preparationId: string;
    fencingToken: string;
    draft: CompetitiveSnapshotDraft;
    betWindowDurationMs: number;
    timing: CompetitiveSnapshotTimingInput;
  }): Promise<PersistedCompetitiveSnapshot | null> {
    validateFencingToken(input.fencingToken);
    if (
      !Number.isSafeInteger(input.betWindowDurationMs) ||
      input.betWindowDurationMs <= 0
    ) {
      throw new Error("invalid competitive snapshot bet window");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      if (!input.draft.diagnostic) {
        await lockAndAssertPersistedStreamingDuelParticipation(
          client,
          input.draft.contestants.map((contestant) => contestant.agentId),
        );
      }
      const preparationResult = await client.query<PreparationAccessRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          SELECT preparation.*, clock.now_ms AS "databaseNow"
          FROM streaming_duel_preparations AS preparation
          CROSS JOIN clock
          WHERE preparation."preparationId" = $1
            AND preparation."fencingToken" = $2::bigint
          FOR UPDATE OF preparation
        `,
        [input.preparationId, input.fencingToken],
      );
      const preparation = mapPreparation(preparationResult.rows[0]);
      const databaseNow = finiteTimestamp(
        preparationResult.rows[0]?.databaseNow ?? null,
      );
      if (!preparation || databaseNow === null) {
        await client.query("ROLLBACK");
        return null;
      }
      if (
        await hasContestantUnavailability(client, preparation.preparationId)
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (
        !preparation.agent1PlanEvidence ||
        !preparation.agent2PlanEvidence ||
        input.draft.preparationId !== preparation.preparationId ||
        input.draft.contestants[0].agentId !== preparation.agent1Id ||
        input.draft.contestants[1].agentId !== preparation.agent2Id
      ) {
        throw new Error("competitive_snapshot_preparation_mismatch");
      }

      const draft: CompetitiveSnapshotDraft = {
        ...input.draft,
        contestants: [
          {
            ...input.draft.contestants[0],
            preparation: preparation.agent1PlanEvidence,
          },
          {
            ...input.draft.contestants[1],
            preparation: preparation.agent2PlanEvidence,
          },
        ],
      };

      if (preparation.status === "frozen") {
        const existingResult = await client.query<CompetitiveSnapshotRow>(
          `SELECT * FROM streaming_duel_competitive_snapshots
           WHERE "preparationId" = $1`,
          [preparation.preparationId],
        );
        const existing = mapCompetitiveSnapshot(existingResult.rows[0]);
        if (!existing || preparation.frozenAt === null) {
          throw new Error("competitive_snapshot_missing_after_freeze");
        }
        const expected = finalizeCompetitiveSnapshot({
          draft,
          persisted: true,
          frozenAt: preparation.frozenAt,
          betWindowDurationMs: input.betWindowDurationMs,
          timing: input.timing,
        });
        if (expected.digest !== existing.digest) {
          throw new Error("competitive_snapshot_conflict");
        }
        await client.query("COMMIT");
        return { preparation, ...existing };
      }
      if (
        !(await haveActiveContestantHostLeases(
          client,
          preparation,
          databaseNow,
        ))
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (
        preparation.status !== "ready" ||
        preparation.agent1ReadyAt === null ||
        preparation.agent2ReadyAt === null ||
        preparation.expiresAt <= databaseNow
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      const competitive = finalizeCompetitiveSnapshot({
        draft,
        persisted: true,
        frozenAt: databaseNow,
        betWindowDurationMs: input.betWindowDurationMs,
        timing: input.timing,
      });
      const updatedResult = await client.query<PreparationRow>(
        `
          UPDATE streaming_duel_preparations
          SET status = 'frozen',
              "frozenAt" = $3::bigint,
              version = version + 1
          WHERE "preparationId" = $1
            AND "fencingToken" = $2::bigint
            AND status = 'ready'
          RETURNING *
        `,
        [input.preparationId, input.fencingToken, databaseNow],
      );
      const updated = mapPreparation(updatedResult.rows[0]);
      if (!updated) throw new Error("competitive_snapshot_freeze_lost");

      await client.query(
        `
          INSERT INTO streaming_duel_competitive_snapshots (
            "preparationId", "snapshotVersion", "cycleId", "duelId",
            "duelKey", "snapshotDigest", snapshot, "frozenAt",
            "lifecycleStatus"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::bigint, 'frozen')
        `,
        [
          updated.preparationId,
          competitive.snapshot.snapshotVersion,
          competitive.snapshot.cycleId,
          competitive.snapshot.duelId,
          competitive.snapshot.duelKey,
          competitive.digest,
          JSON.stringify(competitive.snapshot),
          competitive.snapshot.frozenAt,
        ],
      );
      await insertRuntimeTransitionEvent(client, {
        eventType: "competitive_snapshot_frozen",
        preparation: updated,
        occurredAt: competitive.snapshot.frozenAt,
        competitive,
      });
      await client.query("COMMIT");
      return {
        preparation: updated,
        ...competitive,
        lockedAt: null,
        duelStartedAt: null,
        recoveredAt: null,
        lifecycleStatus: "frozen",
        terminal: null,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original snapshot transition failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getCompetitiveSnapshot(
    preparationId: string,
  ): Promise<PersistedCompetitiveSnapshot | null> {
    const result = await this.pool.query<
      CompetitiveSnapshotRow & PreparationRow
    >(
      `
        SELECT snapshot.*, preparation.*
        FROM streaming_duel_competitive_snapshots AS snapshot
        JOIN streaming_duel_preparations AS preparation
          ON preparation."preparationId" = snapshot."preparationId"
        WHERE snapshot."preparationId" = $1
      `,
      [preparationId],
    );
    const row = result.rows[0];
    const preparation = mapPreparation(row);
    const competitive = mapCompetitiveSnapshot(row);
    return preparation && competitive ? { preparation, ...competitive } : null;
  }

  /** Return the complete durable transition history in commit order. */
  async getTransitionHistory(
    preparationId: string,
  ): Promise<DuelTransitionEvent[]> {
    if (!UUID_PATTERN.test(preparationId)) return [];
    const result = await this.pool.query<DuelTransitionEventRow>(
      `
        SELECT * FROM streaming_duel_transition_events
        WHERE "preparationId" = $1
        ORDER BY "eventSequence" ASC
      `,
      [preparationId],
    );
    return result.rows.map((row) => mapTransitionEvent(row)!);
  }

  /** Persist the immutable market-lock edge before COUNTDOWN is published. */
  async markCompetitiveSnapshotLocked(input: {
    preparationId: string;
    fencingToken: string;
    snapshotDigest: string;
    lockedAt: number;
  }): Promise<PersistedCompetitiveSnapshot | null> {
    return this.markCompetitiveSnapshotMilestone({
      ...input,
      milestone: "locked",
      occurredAt: input.lockedAt,
    });
  }

  /** Persist the exact fight-start edge before combat authority is released. */
  async markCompetitiveSnapshotDuelStarted(input: {
    preparationId: string;
    fencingToken: string;
    snapshotDigest: string;
    duelStartedAt: number;
  }): Promise<PersistedCompetitiveSnapshot | null> {
    return this.markCompetitiveSnapshotMilestone({
      ...input,
      milestone: "duel",
      occurredAt: input.duelStartedAt,
    });
  }

  private async markCompetitiveSnapshotMilestone(input: {
    preparationId: string;
    fencingToken: string;
    snapshotDigest: string;
    milestone: "locked" | "duel";
    occurredAt: number;
  }): Promise<PersistedCompetitiveSnapshot | null> {
    if (!UUID_PATTERN.test(input.preparationId)) {
      throw new Error("preparationId must be a UUID");
    }
    validateFencingToken(input.fencingToken);
    if (
      !SHA256_HEX.test(input.snapshotDigest) ||
      !Number.isSafeInteger(input.occurredAt) ||
      input.occurredAt <= 0
    ) {
      throw new Error("invalid competitive snapshot lifecycle milestone");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<
        CompetitiveSnapshotRow & PreparationRow
      >(
        `
          SELECT snapshot.*, preparation.*
          FROM streaming_duel_competitive_snapshots AS snapshot
          JOIN streaming_duel_preparations AS preparation
            ON preparation."preparationId" = snapshot."preparationId"
          WHERE snapshot."preparationId" = $1
          FOR UPDATE OF snapshot, preparation
        `,
        [input.preparationId],
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const existing = mapCompetitiveSnapshot(row);
      if (
        !preparation ||
        !existing ||
        preparation.fencingToken !== input.fencingToken ||
        existing.digest !== input.snapshotDigest
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      const currentValue =
        input.milestone === "locked"
          ? existing.lockedAt
          : existing.duelStartedAt;
      if (currentValue !== null) {
        if (currentValue !== input.occurredAt) {
          throw new Error("competitive_snapshot_lifecycle_conflict");
        }
        await client.query("COMMIT");
        return { preparation, ...existing };
      }
      if (existing.lifecycleStatus !== "frozen") {
        throw new Error("competitive_snapshot_lifecycle_terminal");
      }
      if (
        (input.milestone === "locked" &&
          input.occurredAt !== existing.snapshot.betCloseTime) ||
        (input.milestone === "duel" &&
          (existing.lockedAt === null || input.occurredAt < existing.lockedAt))
      ) {
        throw new Error("competitive_snapshot_lifecycle_order_invalid");
      }

      const column =
        input.milestone === "locked" ? "lockedAt" : "duelStartedAt";
      const updated = await client.query<CompetitiveSnapshotRow>(
        `
          UPDATE streaming_duel_competitive_snapshots
          SET "${column}" = $3::bigint
          WHERE "preparationId" = $1
            AND "snapshotDigest" = $2
            AND "lifecycleStatus" = 'frozen'
            AND "${column}" IS NULL
          RETURNING *
        `,
        [input.preparationId, input.snapshotDigest, input.occurredAt],
      );
      const milestone = mapCompetitiveSnapshot(updated.rows[0]);
      if (!milestone) {
        throw new Error("competitive_snapshot_lifecycle_transition_lost");
      }
      await insertRuntimeTransitionEvent(client, {
        eventType:
          input.milestone === "locked" ? "market_locked" : "duel_started",
        preparation,
        occurredAt: input.occurredAt,
        competitive: milestone,
      });
      await client.query("COMMIT");
      return { preparation, ...milestone };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original lifecycle transition failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Transfer the newest frozen or terminal snapshot to the newest scheduler
   * fencing token. Terminal rows are claimed so exact terminal truth can be
   * replayed after a process restart without recomputation.
   * The monotonic comparison prevents an expired scheduler from reclaiming or
   * finalizing a duel after a replacement authority has taken over.
   */
  async claimLatestCompetitiveSnapshotForRecovery(
    fencingToken: string,
  ): Promise<PersistedCompetitiveSnapshot | null> {
    validateFencingToken(fencingToken);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<
        CompetitiveSnapshotRow & PreparationAccessRow
      >(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          SELECT snapshot.*, preparation.*, clock.now_ms AS "databaseNow"
          FROM streaming_duel_competitive_snapshots AS snapshot
          JOIN streaming_duel_preparations AS preparation
            ON preparation."preparationId" = snapshot."preparationId"
          CROSS JOIN clock
          WHERE snapshot."lifecycleStatus" IN ('frozen', 'terminal')
          ORDER BY snapshot."frozenAt" DESC
          LIMIT 1
          FOR UPDATE OF snapshot, preparation
        `,
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const competitive = mapCompetitiveSnapshot(row);
      const databaseNow = finiteTimestamp(row?.databaseNow ?? null);
      if (
        !preparation ||
        !competitive ||
        databaseNow === null ||
        preparation.status !== "frozen"
      ) {
        await client.query("COMMIT");
        return null;
      }
      const currentToken = BigInt(preparation.fencingToken);
      const requestedToken = BigInt(fencingToken);
      if (requestedToken < currentToken) {
        await client.query("ROLLBACK");
        return null;
      }
      if (requestedToken > currentToken) {
        const updated = await client.query<PreparationRow>(
          `
            UPDATE streaming_duel_preparations
            SET "fencingToken" = $2::bigint,
                version = version + 1
            WHERE "preparationId" = $1
              AND "fencingToken" = $3::bigint
              AND status = 'frozen'
            RETURNING *
          `,
          [preparation.preparationId, fencingToken, preparation.fencingToken],
        );
        const claimedPreparation = mapPreparation(updated.rows[0]);
        if (!claimedPreparation) {
          throw new Error("competitive_snapshot_claim_lost");
        }
        await insertRuntimeTransitionEvent(client, {
          eventType: "authority_claimed",
          preparation: claimedPreparation,
          occurredAt: databaseNow,
          competitive,
        });
        await client.query("COMMIT");
        return { preparation: claimedPreparation, ...competitive };
      }
      await client.query("COMMIT");
      return { preparation, ...competitive };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original claim failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Persist exact terminal truth before publishing it to betting consumers. */
  async markCompetitiveSnapshotTerminal(input: {
    preparationId: string;
    fencingToken: string;
    snapshotDigest: string;
    terminal: CompetitiveSnapshotTerminal;
  }): Promise<PersistedCompetitiveSnapshot | null> {
    if (!UUID_PATTERN.test(input.preparationId)) {
      throw new Error("preparationId must be a UUID");
    }
    validateFencingToken(input.fencingToken);
    if (
      !SHA256_HEX.test(input.snapshotDigest) ||
      !isValidCompetitiveSnapshotTerminal(input.terminal)
    ) {
      throw new Error("invalid competitive snapshot terminal");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<
        CompetitiveSnapshotRow & PreparationRow
      >(
        `
          SELECT snapshot.*, preparation.*
          FROM streaming_duel_competitive_snapshots AS snapshot
          JOIN streaming_duel_preparations AS preparation
            ON preparation."preparationId" = snapshot."preparationId"
          WHERE snapshot."preparationId" = $1
          FOR UPDATE OF snapshot, preparation
        `,
        [input.preparationId],
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const existing = mapCompetitiveSnapshot(row);
      if (
        !preparation ||
        !existing ||
        preparation.fencingToken !== input.fencingToken ||
        existing.digest !== input.snapshotDigest
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (
        !isValidCompetitiveSnapshotTerminal(input.terminal, existing.snapshot)
      ) {
        throw new Error("invalid competitive snapshot terminal");
      }
      if (existing.lifecycleStatus === "retired") {
        throw new Error("competitive_snapshot_retired");
      }
      if (existing.lifecycleStatus === "terminal") {
        if (
          canonicalCompetitiveTerminal(existing.terminal) !==
          canonicalCompetitiveTerminal(input.terminal)
        ) {
          throw new Error("competitive_snapshot_terminal_conflict");
        }
        await client.query("COMMIT");
        return { preparation, ...existing };
      }

      const updated = await client.query<CompetitiveSnapshotRow>(
        `
          UPDATE streaming_duel_competitive_snapshots
          SET "lifecycleStatus" = 'terminal',
              "terminalOutcome" = $3,
              "terminalWinnerId" = $4,
              "terminalWinReason" = $5,
              "terminalCancellationReason" = $6,
              "terminalSeed" = $7,
              "terminalReplayHash" = $8,
              "terminalAt" = $9::bigint
          WHERE "preparationId" = $1
            AND "snapshotDigest" = $2
            AND "lifecycleStatus" = 'frozen'
          RETURNING *
        `,
        [
          input.preparationId,
          input.snapshotDigest,
          input.terminal.outcome,
          input.terminal.winnerId,
          input.terminal.winReason,
          input.terminal.cancellationReason,
          input.terminal.seed,
          input.terminal.replayHash,
          input.terminal.terminalAt,
        ],
      );
      const terminal = mapCompetitiveSnapshot(updated.rows[0]);
      if (!terminal) throw new Error("competitive_snapshot_terminal_lost");
      await persistCompetitiveTerminalStats(
        client,
        terminal.snapshot,
        input.terminal,
      );
      await insertRuntimeTransitionEvent(client, {
        eventType: "terminal_committed",
        preparation,
        occurredAt: input.terminal.terminalAt,
        competitive: terminal,
        terminal: input.terminal,
      });
      await client.query("COMMIT");
      return { preparation, ...terminal };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original terminal transition failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retire a terminal snapshot only after contestant custody and world state
   * have been recovered. Retired rows retain immutable terminal evidence but
   * are excluded from scheduler restart replay.
   */
  async markCompetitiveSnapshotRecovered(input: {
    preparationId: string;
    fencingToken: string;
    snapshotDigest: string;
    recoveredAt: number;
  }): Promise<PersistedCompetitiveSnapshot | null> {
    if (!UUID_PATTERN.test(input.preparationId)) {
      throw new Error("preparationId must be a UUID");
    }
    validateFencingToken(input.fencingToken);
    if (
      !SHA256_HEX.test(input.snapshotDigest) ||
      !Number.isSafeInteger(input.recoveredAt) ||
      input.recoveredAt <= 0
    ) {
      throw new Error("invalid competitive snapshot recovery");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<
        CompetitiveSnapshotRow & PreparationRow
      >(
        `
          SELECT snapshot.*, preparation.*
          FROM streaming_duel_competitive_snapshots AS snapshot
          JOIN streaming_duel_preparations AS preparation
            ON preparation."preparationId" = snapshot."preparationId"
          WHERE snapshot."preparationId" = $1
          FOR UPDATE OF snapshot, preparation
        `,
        [input.preparationId],
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const existing = mapCompetitiveSnapshot(row);
      if (
        !preparation ||
        !existing ||
        preparation.fencingToken !== input.fencingToken ||
        existing.digest !== input.snapshotDigest
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (existing.lifecycleStatus === "retired") {
        if (
          existing.terminal === null ||
          existing.recoveredAt !== input.recoveredAt
        ) {
          throw new Error("competitive_snapshot_recovery_conflict");
        }
        await client.query("COMMIT");
        return { preparation, ...existing };
      }
      if (
        existing.lifecycleStatus !== "terminal" ||
        !existing.terminal ||
        input.recoveredAt < existing.terminal.terminalAt
      ) {
        throw new Error("competitive_snapshot_recovery_order_invalid");
      }

      const updated = await client.query<CompetitiveSnapshotRow>(
        `
          UPDATE streaming_duel_competitive_snapshots
          SET "lifecycleStatus" = 'retired',
              "recoveredAt" = $3::bigint
          WHERE "preparationId" = $1
            AND "snapshotDigest" = $2
            AND "lifecycleStatus" = 'terminal'
            AND "recoveredAt" IS NULL
          RETURNING *
        `,
        [input.preparationId, input.snapshotDigest, input.recoveredAt],
      );
      const recovered = mapCompetitiveSnapshot(updated.rows[0]);
      if (!recovered) {
        throw new Error("competitive_snapshot_recovery_lost");
      }
      await insertRuntimeTransitionEvent(client, {
        eventType: "recovery_committed",
        preparation,
        occurredAt: input.recoveredAt,
        competitive: recovered,
      });
      await client.query("COMMIT");
      return { preparation, ...recovered };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original recovery transition failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async cancel(input: {
    preparationId: string;
    fencingToken: string;
    reason: string;
  }): Promise<DuelPreparationSnapshot | null> {
    validateFencingToken(input.fencingToken);
    if (!CANCELLATION_REASON_PATTERN.test(input.reason)) {
      throw new Error("invalid duel preparation cancellation reason");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<PreparationAccessRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          SELECT preparation.*, clock.now_ms AS "databaseNow"
          FROM streaming_duel_preparations AS preparation
          CROSS JOIN clock
          WHERE preparation."preparationId" = $1
          FOR UPDATE OF preparation
        `,
        [input.preparationId],
      );
      const row = selected.rows[0];
      const preparation = mapPreparation(row);
      const databaseNow = finiteTimestamp(row?.databaseNow ?? null);
      if (
        !preparation ||
        databaseNow === null ||
        preparation.fencingToken !== input.fencingToken
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (preparation.status === "cancelled") {
        if (preparation.cancellationReason !== input.reason) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query("COMMIT");
        return preparation;
      }
      if (!["preparing", "ready", "frozen"].includes(preparation.status)) {
        await client.query("ROLLBACK");
        return null;
      }
      const updatedResult = await client.query<PreparationRow>(
        `
          UPDATE streaming_duel_preparations
          SET status = 'cancelled',
              "cancelledAt" = $3::bigint,
              "cancellationReason" = $4,
              version = version + 1
          WHERE "preparationId" = $1
            AND "fencingToken" = $2::bigint
            AND status IN ('preparing', 'ready', 'frozen')
          RETURNING *
        `,
        [input.preparationId, input.fencingToken, databaseNow, input.reason],
      );
      const updated = mapPreparation(updatedResult.rows[0]);
      if (!updated) throw new Error("duel_preparation_cancellation_lost");
      await insertRuntimeTransitionEvent(client, {
        eventType: "preparation_cancelled",
        preparation: updated,
        occurredAt: databaseNow,
        reason: input.reason,
      });
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original cancellation transition failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async expire(): Promise<DuelPreparationSnapshot[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await client.query<PreparationRow>(
        `
          WITH clock AS (
            SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
          )
          UPDATE streaming_duel_preparations AS preparation
          SET status = 'expired', version = preparation.version + 1
          FROM clock
          WHERE
            preparation.status IN ('preparing', 'ready')
            AND preparation."expiresAt" <= clock.now_ms
          RETURNING preparation.*
        `,
      );
      const expired = result.rows.map((row) => mapPreparation(row)!);
      for (const preparation of expired) {
        // expiresAt is the authoritative database-time boundary that made the
        // transition eligible, so it remains stable across retries/restarts.
        await insertRuntimeTransitionEvent(client, {
          eventType: "preparation_expired",
          preparation,
          occurredAt: preparation.expiresAt,
        });
      }
      await client.query("COMMIT");
      return expired;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original expiry transition failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async authorizeBankAccess(input: {
    preparationId: string;
    playerId: string;
    action: DuelPreparationBankAction;
  }): Promise<DuelPreparationBankAccessDecision> {
    return authorizeDuelPreparationBankAccess(this.pool, input);
  }
}

/**
 * Validate a private bank capability against durable preparation state. Bank
 * mutations request a row lock so readiness/freeze cannot race the transfer.
 */
export async function authorizeDuelPreparationBankAccess(
  queryable: Queryable,
  input: {
    preparationId: string;
    playerId: string;
    action: DuelPreparationBankAction;
    lockForTransaction?: boolean;
  },
): Promise<DuelPreparationBankAccessDecision> {
  if (!UUID_PATTERN.test(input.preparationId)) {
    return { ok: false, reason: "preparation_not_found" };
  }
  const result = await queryable.query<PreparationAccessRow>(
    `
      WITH clock AS (
        SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
      )
      SELECT preparation.*, clock.now_ms AS "databaseNow"
           , EXISTS (
               SELECT 1
               FROM streaming_duel_preparation_unavailability_reports AS unavailable
               WHERE unavailable."preparationId" = preparation."preparationId"
             ) AS "contestantUnavailable"
           , EXISTS (
               SELECT 1
               FROM streaming_duel_preparation_agent_host_leases AS lease
               WHERE lease."preparationId" = preparation."preparationId"
                 AND lease."agentId" = $2
                 AND lease."expiresAt" > clock.now_ms
             ) AS "contestantHostLeaseActive"
      FROM streaming_duel_preparations AS preparation
      CROSS JOIN clock
      WHERE preparation."preparationId" = $1
      ${input.lockForTransaction ? "FOR SHARE OF preparation" : ""}
    `,
    [input.preparationId, input.playerId],
  );
  const row = result.rows[0];
  if (!row) return { ok: false, reason: "preparation_not_found" };
  const preparation = mapPreparation(row)!;
  const databaseNow = finiteTimestamp(row.databaseNow);
  if (databaseNow === null) {
    throw new Error("Invalid database clock for duel preparation");
  }
  if (preparation.expiresAt <= databaseNow) {
    return { ok: false, reason: "preparation_expired" };
  }
  if (preparation.status !== "preparing") {
    return { ok: false, reason: "preparation_not_active" };
  }
  if (row.contestantUnavailable === true) {
    return { ok: false, reason: "preparation_not_active" };
  }
  if (
    preparation.agent1Id !== input.playerId &&
    preparation.agent2Id !== input.playerId
  ) {
    return { ok: false, reason: "preparation_agent_mismatch" };
  }
  if (row.contestantHostLeaseActive !== true) {
    return { ok: false, reason: "preparation_not_active" };
  }
  const readyAt =
    preparation.agent1Id === input.playerId
      ? preparation.agent1ReadyAt
      : preparation.agent2ReadyAt;
  if (readyAt !== null) {
    return { ok: false, reason: "preparation_agent_ready" };
  }
  if (!preparation.allowedBankActions.includes(input.action)) {
    return { ok: false, reason: "preparation_action_not_allowed" };
  }
  return { ok: true, preparation };
}
