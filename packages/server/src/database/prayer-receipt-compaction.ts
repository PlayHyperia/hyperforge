import { randomUUID } from "node:crypto";
import { parseStreamingDuelActionObservation } from "@hyperforge/shared";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { parseStoredPrayerStateOperation } from "./prayer-operation-receipt";
import type { StoredPrayerStateOperation } from "./prayer-operation-receipt";

const RETENTION_APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export type PrayerReceiptCompactionMode = "audit" | "execute";

export type PrayerReceiptCompactionRequest = Readonly<{
  mode: PrayerReceiptCompactionMode;
  cutoffBeforeMs: number;
  batchLimit: number;
  statementTimeoutMs: number;
  retentionApprovalId?: string;
  nowMs?: number;
  compactionBatchId?: string;
}>;

export type PrayerReceiptCompactionResult = Readonly<{
  schemaVersion: 1;
  mode: PrayerReceiptCompactionMode;
  cutoffBeforeMs: number;
  batchLimit: number;
  eligibleCount: number;
  selectedCount: number;
  compactedCount: number;
  selectedOperationStateBytes: number;
  oldestSelectedCompletedAt: number | null;
  newestSelectedCompletedAt: number | null;
  retentionApprovalId: string | null;
  compactionBatchId: string | null;
  semanticIdentityRetained: true;
  publicObservationsRetained: true;
}>;

type CandidateRow = QueryResultRow & {
  operationId: string;
  playerId: string;
  operationState: unknown;
  operationTimestamp: string | number;
  completedAt: string | number;
  operationStateBytes: string | number;
};

type CountRow = QueryResultRow & { count: string | number };
type ObservationRow = QueryResultRow & { observation: unknown };

function requireSafePositiveInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function normalizeRequest(request: PrayerReceiptCompactionRequest): Required<
  Omit<PrayerReceiptCompactionRequest, "retentionApprovalId">
> & {
  retentionApprovalId: string | null;
} {
  const nowMs = requireSafePositiveInteger(
    request.nowMs ?? Date.now(),
    "prayer_receipt_compaction_now",
    Number.MAX_SAFE_INTEGER,
  );
  const cutoffBeforeMs = requireSafePositiveInteger(
    request.cutoffBeforeMs,
    "prayer_receipt_compaction_cutoff",
    nowMs,
  );
  if (cutoffBeforeMs >= nowMs) {
    throw new Error("prayer_receipt_compaction_cutoff_invalid");
  }
  const batchLimit = requireSafePositiveInteger(
    request.batchLimit,
    "prayer_receipt_compaction_batch_limit",
    10_000,
  );
  const statementTimeoutMs = requireSafePositiveInteger(
    request.statementTimeoutMs,
    "prayer_receipt_compaction_statement_timeout",
    300_000,
  );
  if (statementTimeoutMs < 100) {
    throw new Error("prayer_receipt_compaction_statement_timeout_invalid");
  }
  if (request.mode !== "audit" && request.mode !== "execute") {
    throw new Error("prayer_receipt_compaction_mode_invalid");
  }
  const retentionApprovalId =
    request.retentionApprovalId === undefined
      ? null
      : String(request.retentionApprovalId).trim();
  if (
    request.mode === "execute" &&
    (!retentionApprovalId ||
      !RETENTION_APPROVAL_ID_PATTERN.test(retentionApprovalId))
  ) {
    throw new Error("prayer_receipt_compaction_approval_required");
  }
  if (
    request.mode === "audit" &&
    retentionApprovalId !== null &&
    !RETENTION_APPROVAL_ID_PATTERN.test(retentionApprovalId)
  ) {
    throw new Error("prayer_receipt_compaction_approval_invalid");
  }
  const compactionBatchId = request.compactionBatchId ?? randomUUID();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      compactionBatchId,
    )
  ) {
    throw new Error("prayer_receipt_compaction_batch_id_invalid");
  }
  return {
    mode: request.mode,
    cutoffBeforeMs,
    batchLimit,
    statementTimeoutMs,
    retentionApprovalId,
    nowMs,
    compactionBatchId,
  };
}

async function countEligible(
  client: PoolClient,
  cutoffBeforeMs: number,
): Promise<number> {
  const result = await client.query<CountRow>(
    `SELECT COUNT(*)::text AS count
       FROM operations_log
      WHERE "operationType" = 'prayer_state_transition'
        AND completed IS TRUE
        AND "completedAt" IS NOT NULL
        AND "completedAt" < $1`,
    [cutoffBeforeMs],
  );
  const count = Number(result.rows[0]?.count ?? Number.NaN);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("prayer_receipt_compaction_count_invalid");
  }
  return count;
}

async function selectCandidates(
  client: PoolClient,
  cutoffBeforeMs: number,
  batchLimit: number,
  lockRows: boolean,
): Promise<CandidateRow[]> {
  const result = await client.query<CandidateRow>(
    `SELECT
       operation.id AS "operationId",
       operation."playerId" AS "playerId",
       operation."operationState" AS "operationState",
       operation.timestamp AS "operationTimestamp",
       operation."completedAt" AS "completedAt",
       pg_column_size(operation."operationState")::text AS "operationStateBytes"
     FROM operations_log AS operation
     WHERE operation."operationType" = 'prayer_state_transition'
       AND operation.completed IS TRUE
       AND operation."completedAt" IS NOT NULL
       AND operation."completedAt" < $1
     ORDER BY operation."completedAt", operation.id
     LIMIT $2
     ${lockRows ? "FOR UPDATE OF operation SKIP LOCKED" : ""}`,
    [cutoffBeforeMs, batchLimit],
  );
  return result.rows;
}

function summarizeCandidates(rows: CandidateRow[]): {
  bytes: number;
  oldest: number | null;
  newest: number | null;
} {
  let bytes = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const row of rows) {
    const rowBytes = Number(row.operationStateBytes);
    const completedAt = Number(row.completedAt);
    if (
      !Number.isSafeInteger(rowBytes) ||
      rowBytes <= 0 ||
      !Number.isSafeInteger(completedAt) ||
      completedAt <= 0
    ) {
      throw new Error("prayer_receipt_compaction_row_invalid");
    }
    bytes += rowBytes;
    if (!Number.isSafeInteger(bytes)) {
      throw new Error("prayer_receipt_compaction_size_invalid");
    }
    oldest = oldest === null ? completedAt : Math.min(oldest, completedAt);
    newest = newest === null ? completedAt : Math.max(newest, completedAt);
  }
  return { bytes, oldest, newest };
}

async function validateCandidate(
  client: PoolClient,
  row: CandidateRow,
  request: ReturnType<typeof normalizeRequest>,
): Promise<{
  operationId: string;
  playerId: string;
  operationTimestamp: number;
  completedAt: number;
  state: StoredPrayerStateOperation;
  publicObservationOperationId: string | null;
}> {
  const operationId = String(row.operationId ?? "").trim();
  const playerId = String(row.playerId ?? "").trim();
  const operationTimestamp = Number(row.operationTimestamp);
  const completedAt = Number(row.completedAt);
  if (
    !operationId ||
    operationId.length > 256 ||
    !playerId ||
    playerId.length > 128 ||
    !Number.isSafeInteger(operationTimestamp) ||
    operationTimestamp <= 0 ||
    !Number.isSafeInteger(completedAt) ||
    completedAt < operationTimestamp ||
    completedAt >= request.cutoffBeforeMs ||
    request.nowMs < completedAt
  ) {
    throw new Error("prayer_receipt_compaction_row_invalid");
  }

  const state = parseStoredPrayerStateOperation(
    row.operationState,
    playerId,
    operationId,
  );
  const publicObservationOperationId =
    state.publicActionObservation?.operationId ?? null;
  if (publicObservationOperationId) {
    const observationRows = await client.query<ObservationRow>(
      `SELECT observation
         FROM streaming_duel_action_observations
        WHERE "operationId" = $1`,
      [publicObservationOperationId],
    );
    const observation = parseStreamingDuelActionObservation(
      observationRows.rows[0]?.observation,
    );
    const expected = state.publicActionObservation;
    if (
      observationRows.rows.length !== 1 ||
      !observation ||
      observation.action !== "prayer" ||
      !expected ||
      observation.tick !== expected.tick ||
      observation.observedAt !== expected.observedAt ||
      observation.cycleId !== expected.cycleId ||
      observation.duelId !== expected.duelId ||
      observation.actorId !== expected.actorId ||
      observation.opponentId !== expected.opponentId ||
      observation.phase !== expected.phase ||
      observation.combatRole !== expected.combatRole ||
      observation.tacticalMacro !== expected.tacticalMacro ||
      observation.outcome !== "committed" ||
      observation.value !== expected.prayer ||
      observation.amount !== null
    ) {
      throw new Error("prayer_receipt_compaction_observation_mismatch");
    }
  }
  return {
    operationId,
    playerId,
    operationTimestamp,
    completedAt,
    state,
    publicObservationOperationId,
  };
}

async function compactCandidate(
  client: PoolClient,
  row: CandidateRow,
  request: ReturnType<typeof normalizeRequest>,
): Promise<void> {
  const operationId = String(row.operationId ?? "").trim();
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('prayer-state-operation:' || $1, 0)
     )`,
    [operationId],
  );
  const validated = await validateCandidate(client, row, request);

  await client.query(
    `INSERT INTO compacted_prayer_state_receipts (
       operation_id,
       player_id,
       request_fingerprint,
       transition,
       public_observation_operation_id,
       retention_approval_id,
       compaction_batch_id,
       operation_timestamp,
       completed_at,
       compacted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      validated.operationId,
      validated.playerId,
      validated.state.requestFingerprint,
      validated.state.transition,
      validated.publicObservationOperationId,
      request.retentionApprovalId,
      request.compactionBatchId,
      validated.operationTimestamp,
      validated.completedAt,
      request.nowMs,
    ],
  );
  const deleted = await client.query(
    `DELETE FROM operations_log
      WHERE id = $1
        AND "operationType" = 'prayer_state_transition'
        AND completed IS TRUE
        AND "completedAt" = $2`,
    [validated.operationId, validated.completedAt],
  );
  if (deleted.rowCount !== 1) {
    throw new Error("prayer_receipt_compaction_delete_conflict");
  }
}

/**
 * Audit or compact one explicit batch. Audit is the default CLI posture;
 * execution requires an externally supplied retention approval identifier.
 * Full prayer WAL bodies may be removed, but their permanent replay identity
 * and append-only public observations are never removed by this operation.
 */
export async function runPrayerReceiptCompaction(
  pool: Pick<Pool, "connect">,
  rawRequest: PrayerReceiptCompactionRequest,
): Promise<PrayerReceiptCompactionResult> {
  const request = normalizeRequest(rawRequest);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
      `${request.statementTimeoutMs}ms`,
    ]);
    if (request.mode === "execute") {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('prayer-receipt-compaction', 0)
         )`,
      );
    }
    const eligibleCount = await countEligible(client, request.cutoffBeforeMs);
    const rows = await selectCandidates(
      client,
      request.cutoffBeforeMs,
      request.batchLimit,
      request.mode === "execute",
    );
    const summary = summarizeCandidates(rows);
    if (request.mode === "execute") {
      for (const row of rows) {
        await compactCandidate(client, row, request);
      }
    } else {
      for (const row of rows) await validateCandidate(client, row, request);
    }
    await client.query("COMMIT");
    return {
      schemaVersion: 1,
      mode: request.mode,
      cutoffBeforeMs: request.cutoffBeforeMs,
      batchLimit: request.batchLimit,
      eligibleCount,
      selectedCount: rows.length,
      compactedCount: request.mode === "execute" ? rows.length : 0,
      selectedOperationStateBytes: summary.bytes,
      oldestSelectedCompletedAt: summary.oldest,
      newestSelectedCompletedAt: summary.newest,
      retentionApprovalId: request.retentionApprovalId,
      compactionBatchId:
        request.mode === "execute" ? request.compactionBatchId : null,
      semanticIdentityRetained: true,
      publicObservationsRetained: true,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
