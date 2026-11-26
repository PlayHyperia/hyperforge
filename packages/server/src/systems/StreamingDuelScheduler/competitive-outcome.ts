import {
  assertValidCompetitiveSnapshot,
  digestCompetitiveSnapshot,
  type CompetitiveSnapshot,
} from "./competitive-snapshot.js";
import type {
  RecentDuelEntry,
  SwitchableStreamingCombatRole,
} from "./types.js";

type PersistedCompetitiveOutcomeRow = Record<string, unknown>;

export type CompetitiveOutcomeNormalizationOptions = Readonly<{
  /**
   * Diagnostic snapshots are excluded from production analytics by default.
   * The only intended opt-in consumer is an explicitly classified, local,
   * no-value qualification harness.
   */
  allowDiagnosticSnapshots?: boolean;
}>;

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
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UINT64_TEXT = /^(0|[1-9][0-9]{0,19})$/;
const CANCELLATION_REASON_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;

const nullableString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const nullableCombatRole = (
  value: unknown,
): SwitchableStreamingCombatRole | null =>
  STREAMING_COMBAT_ROLES.has(value as SwitchableStreamingCombatRole)
    ? (value as SwitchableStreamingCombatRole)
    : null;

const safeDamageValue = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

const isUint64Text = (value: string | null): value is string => {
  if (!value || !UINT64_TEXT.test(value)) return false;
  try {
    return BigInt(value) <= UINT64_MAX;
  } catch {
    return false;
  }
};

const exactDatabaseInteger = (value: unknown, expected: number): boolean => {
  if (typeof value === "bigint") return value === BigInt(expected);
  if (typeof value === "number") return value === expected;
  return typeof value === "string" && value === String(expected);
};

/**
 * Recover recent-duel truth directly from one immutable competitive snapshot
 * terminal. Malformed authority is rejected instead of being partially used.
 */
export function normalizePersistedCompetitiveOutcome(
  value: unknown,
  damageAgent1Value: unknown = 0,
  damageAgent2Value: unknown = 0,
  options: CompetitiveOutcomeNormalizationOptions = {},
): RecentDuelEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as PersistedCompetitiveOutcomeRow;
  const snapshot = row.snapshot as CompetitiveSnapshot | undefined;
  try {
    if (!snapshot) return null;
    assertValidCompetitiveSnapshot(snapshot);
  } catch {
    return null;
  }
  const terminalAt = Number(row.terminalAt);
  const duelStartedAt =
    row.duelStartedAt === null ? null : Number(row.duelStartedAt);
  const snapshotDigest = nullableString(row.snapshotDigest);
  const outcome = row.terminalOutcome;
  const damageAgent1 = safeDamageValue(damageAgent1Value);
  const damageAgent2 = safeDamageValue(damageAgent2Value);
  const [agent1, agent2] = snapshot.contestants;
  if (
    !snapshot.persisted ||
    (snapshot.diagnostic && options.allowDiagnosticSnapshots !== true) ||
    (row.lifecycleStatus !== "terminal" && row.lifecycleStatus !== "retired") ||
    !Number.isSafeInteger(terminalAt) ||
    terminalAt < snapshot.frozenAt ||
    (duelStartedAt !== null &&
      (!Number.isSafeInteger(duelStartedAt) || terminalAt < duelStartedAt)) ||
    snapshotDigest === null ||
    !SHA256_HEX.test(snapshotDigest) ||
    digestCompetitiveSnapshot(snapshot) !== snapshotDigest ||
    !exactDatabaseInteger(row.snapshotVersion, snapshot.snapshotVersion) ||
    !exactDatabaseInteger(row.frozenAt, snapshot.frozenAt) ||
    row.preparationId !== snapshot.preparationId ||
    row.cycleId !== snapshot.cycleId ||
    row.duelId !== snapshot.duelId ||
    row.duelKey !== snapshot.duelKey ||
    damageAgent1 === null ||
    damageAgent2 === null ||
    (outcome !== "win" && outcome !== "draw" && outcome !== "cancelled")
  ) {
    return null;
  }

  const winnerId = nullableString(row.terminalWinnerId);
  const winReason = nullableString(row.terminalWinReason);
  const cancellationReason = nullableString(row.terminalCancellationReason);
  const seed = nullableString(row.terminalSeed);
  const replayHash = nullableString(row.terminalReplayHash);
  const validProof = Boolean(
    isUint64Text(seed) && replayHash && SHA256_HEX.test(replayHash),
  );
  const winner = winnerId
    ? ([agent1, agent2].find((contestant) => contestant.agentId === winnerId) ??
      null)
    : null;
  const loser = winner
    ? winner.agentId === agent1.agentId
      ? agent2
      : agent1
    : null;

  if (outcome === "win") {
    if (
      !winner ||
      !loser ||
      !winReason ||
      !STREAMING_DUEL_WIN_REASONS.has(winReason) ||
      cancellationReason !== null ||
      !validProof
    ) {
      return null;
    }
  } else if (outcome === "draw") {
    if (
      winnerId !== null ||
      winReason !== "draw" ||
      cancellationReason !== "draw" ||
      !validProof
    ) {
      return null;
    }
  } else if (
    winnerId !== null ||
    winReason !== null ||
    cancellationReason === null ||
    !CANCELLATION_REASON_PATTERN.test(cancellationReason) ||
    seed !== null ||
    replayHash !== null
  ) {
    return null;
  }

  return {
    cycleId: snapshot.cycleId,
    duelId: snapshot.duelId,
    finishedAt: terminalAt,
    outcome,
    agent1Id: agent1.agentId,
    agent1Name: agent1.name,
    agent1OpeningStyle: nullableCombatRole(agent1.initialCombatStyle),
    agent2Id: agent2.agentId,
    agent2Name: agent2.name,
    agent2OpeningStyle: nullableCombatRole(agent2.initialCombatStyle),
    winnerId: winner?.agentId ?? null,
    winnerName: winner?.name ?? null,
    loserId: loser?.agentId ?? null,
    loserName: loser?.name ?? null,
    winReason:
      outcome === "draw"
        ? "draw"
        : outcome === "win"
          ? (winReason as RecentDuelEntry["winReason"])
          : null,
    cancellationReason,
    damageAgent1,
    damageAgent2,
    damageWinner:
      winner?.agentId === agent1.agentId
        ? damageAgent1
        : winner?.agentId === agent2.agentId
          ? damageAgent2
          : null,
    damageLoser:
      loser?.agentId === agent1.agentId
        ? damageAgent1
        : loser?.agentId === agent2.agentId
          ? damageAgent2
          : null,
  };
}
