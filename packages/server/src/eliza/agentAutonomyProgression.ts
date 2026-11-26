import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../database/client.js";
import {
  runInPostgresTransaction,
  type PostgresTransactionPool,
} from "../database/postgres-transaction.js";
import {
  agentAutonomyProgressionEvents,
  agentAutonomyProgressionHeads,
} from "../database/schema.js";
import {
  AGENT_AUTONOMY_ACTION_TYPES,
  AGENT_AUTONOMY_GOAL_TYPES,
  buildAgentAutonomyCheckpointDraft,
  loadAgentAutonomyCheckpoint,
  saveAgentAutonomyCheckpoint,
  type AgentAutonomyActionResult,
  type AgentAutonomyCheckpoint,
  type AgentAutonomyCheckpointDraft,
  type RuntimeAgentActionOutcome,
} from "./agentAutonomyCheckpoint.js";
import type {
  AgentGoal,
  AgentInstance,
  EmbeddedBehaviorAction,
} from "./managers/AgentBehaviorTicker.js";
import {
  recordAgentAutonomyLifecycleStart,
  recordAgentAutonomyLifecycleTerminal,
} from "./agentAutonomyLifecycle.js";

const PHASE = "ordinary_progression" as const;
const NON_IDLE_ACTION_TYPES = new Set<EmbeddedBehaviorAction["type"]>(
  AGENT_AUTONOMY_ACTION_TYPES.filter((actionType) => actionType !== "idle"),
);
const GOAL_TYPES = new Set<AgentGoal["type"]>(AGENT_AUTONOMY_GOAL_TYPES);
const RUNTIME_TERMINAL_OUTCOMES = new Set<RuntimeAgentActionOutcome>([
  "completed",
  "dispatched",
  "rejected",
  "failed",
]);

export type AgentAutonomyDecisionSource = "llm" | "scripted";

export interface AgentAutonomyProgressionAttempt {
  attemptId: string;
  characterId: string;
  phase: typeof PHASE;
  goalType: AgentGoal["type"] | null;
  actionType: Exclude<EmbeddedBehaviorAction["type"], "idle">;
  decisionSource: AgentAutonomyDecisionSource;
  startedAt: number;
}

export interface RecoveredAgentAutonomyAttempt {
  attempt: AgentAutonomyProgressionAttempt;
  checkpoint: AgentAutonomyCheckpoint;
}

export type AgentAutonomyRecoveryResolver = (
  db: Database,
  attempt: AgentAutonomyProgressionAttempt,
) => Promise<AgentAutonomyActionResult | null>;

type HeadRow = typeof agentAutonomyProgressionHeads.$inferSelect;

function safeTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`agent_autonomy_progression_${field}_invalid`);
  }
  return value;
}

function normalizeCharacterId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new Error("agent_autonomy_progression_character_id_invalid");
  }
  return normalized;
}

function normalizeAttempt(
  attempt: AgentAutonomyProgressionAttempt,
): AgentAutonomyProgressionAttempt {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      attempt.attemptId,
    ) ||
    attempt.phase !== PHASE ||
    !NON_IDLE_ACTION_TYPES.has(attempt.actionType) ||
    (attempt.goalType !== null && !GOAL_TYPES.has(attempt.goalType)) ||
    (attempt.decisionSource !== "llm" && attempt.decisionSource !== "scripted")
  ) {
    throw new Error("agent_autonomy_progression_attempt_invalid");
  }
  return {
    ...attempt,
    characterId: normalizeCharacterId(attempt.characterId),
    startedAt: safeTimestamp(attempt.startedAt, "started_at"),
  };
}

function attemptFromHead(head: HeadRow): AgentAutonomyProgressionAttempt {
  if (
    head.openAttemptId === null ||
    head.openPhase !== PHASE ||
    head.openActionType === null ||
    head.openDecisionSource === null ||
    head.openStartedAt === null
  ) {
    throw new Error("agent_autonomy_progression_head_invalid");
  }
  return normalizeAttempt({
    attemptId: head.openAttemptId,
    characterId: head.characterId,
    phase: PHASE,
    goalType: head.openGoalType as AgentGoal["type"] | null,
    actionType: head.openActionType as Exclude<
      EmbeddedBehaviorAction["type"],
      "idle"
    >,
    decisionSource: head.openDecisionSource as AgentAutonomyDecisionSource,
    startedAt: head.openStartedAt,
  });
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  if (
    [
      "40001",
      "40P01",
      "57P01",
      "57P02",
      "57P03",
      "08000",
      "08003",
      "08006",
      "ECONNRESET",
      "EPIPE",
    ].includes(code)
  ) {
    return true;
  }
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message.toLowerCase()
      : "";
  return (
    message.includes("connection terminated") ||
    message.includes("connection reset") ||
    message.includes("connection closed")
  );
}

async function withTransactionRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isRetryableTransactionError(error)) throw error;
    return operation();
  }
}

async function lockHead(
  tx: Database,
  characterId: string,
  updatedAt: number,
): Promise<HeadRow> {
  await tx
    .insert(agentAutonomyProgressionHeads)
    .values({ characterId, updatedAt })
    .onConflictDoNothing();
  const rows = await tx
    .select()
    .from(agentAutonomyProgressionHeads)
    .where(eq(agentAutonomyProgressionHeads.characterId, characterId))
    .limit(1)
    .for("update");
  if (!rows[0]) {
    throw new Error("agent_autonomy_progression_head_lock_failed");
  }
  return rows[0];
}

function headMatchesAttempt(
  head: HeadRow,
  attempt: AgentAutonomyProgressionAttempt,
): boolean {
  return (
    head.openAttemptId === attempt.attemptId &&
    head.openPhase === attempt.phase &&
    head.openGoalType === attempt.goalType &&
    head.openActionType === attempt.actionType &&
    head.openDecisionSource === attempt.decisionSource &&
    head.openStartedAt === attempt.startedAt
  );
}

function attemptsShareIdentity(
  left: AgentAutonomyProgressionAttempt,
  right: AgentAutonomyProgressionAttempt,
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.characterId === right.characterId &&
    left.phase === right.phase &&
    left.goalType === right.goalType &&
    left.actionType === right.actionType &&
    left.decisionSource === right.decisionSource
  );
}

/** Persist one started edge before a non-idle action can reach the game. */
export async function beginAgentAutonomyProgressionAttempt(
  pool: PostgresTransactionPool,
  input: {
    characterId: string;
    goalType: AgentGoal["type"] | null;
    actionType: Exclude<EmbeddedBehaviorAction["type"], "idle">;
    decisionSource: AgentAutonomyDecisionSource;
    startedAt?: number;
    attemptId?: string;
  },
): Promise<AgentAutonomyProgressionAttempt> {
  const attempt = normalizeAttempt({
    attemptId: input.attemptId ?? randomUUID(),
    characterId: input.characterId,
    phase: PHASE,
    goalType: input.goalType,
    actionType: input.actionType,
    decisionSource: input.decisionSource,
    startedAt: input.startedAt ?? Date.now(),
  });

  return withTransactionRetry(() =>
    runInPostgresTransaction(pool, async (tx) => {
      const db = tx as Database;
      const head = await lockHead(db, attempt.characterId, attempt.startedAt);
      if (head.openAttemptId !== null) {
        const committedAttempt = attemptFromHead(head);
        if (!attemptsShareIdentity(committedAttempt, attempt)) {
          throw new Error("agent_autonomy_progression_attempt_already_open");
        }
        const existing = await db
          .select({ eventKey: agentAutonomyProgressionEvents.eventKey })
          .from(agentAutonomyProgressionEvents)
          .where(
            and(
              eq(agentAutonomyProgressionEvents.attemptId, attempt.attemptId),
              eq(agentAutonomyProgressionEvents.eventType, "attempt_started"),
            ),
          )
          .limit(1);
        if (!existing[0]) {
          throw new Error("agent_autonomy_progression_started_edge_missing");
        }
        return committedAttempt;
      }

      const existing = await db
        .select({ eventKey: agentAutonomyProgressionEvents.eventKey })
        .from(agentAutonomyProgressionEvents)
        .where(
          and(
            eq(agentAutonomyProgressionEvents.attemptId, attempt.attemptId),
            eq(agentAutonomyProgressionEvents.eventType, "attempt_started"),
          ),
        )
        .limit(1);
      if (existing[0]) {
        throw new Error("agent_autonomy_progression_head_event_mismatch");
      }

      const committedAttempt: AgentAutonomyProgressionAttempt = {
        ...attempt,
        startedAt: Math.max(attempt.startedAt, head.updatedAt),
      };

      await db.insert(agentAutonomyProgressionEvents).values({
        eventKey: `${committedAttempt.attemptId}:started`,
        attemptId: committedAttempt.attemptId,
        characterId: committedAttempt.characterId,
        eventSource: "runtime",
        eventType: "attempt_started",
        phase: committedAttempt.phase,
        goalType: committedAttempt.goalType,
        actionType: committedAttempt.actionType,
        decisionSource: committedAttempt.decisionSource,
        occurredAt: committedAttempt.startedAt,
      });
      await recordAgentAutonomyLifecycleStart(db, committedAttempt);
      const updated = await db
        .update(agentAutonomyProgressionHeads)
        .set({
          openAttemptId: committedAttempt.attemptId,
          openPhase: committedAttempt.phase,
          openGoalType: committedAttempt.goalType,
          openActionType: committedAttempt.actionType,
          openDecisionSource: committedAttempt.decisionSource,
          openStartedAt: committedAttempt.startedAt,
          headRevision: sql`${agentAutonomyProgressionHeads.headRevision} + 1`,
          updatedAt: sql`GREATEST(${agentAutonomyProgressionHeads.updatedAt}, ${committedAttempt.startedAt})`,
        })
        .where(
          and(
            eq(agentAutonomyProgressionHeads.characterId, attempt.characterId),
            sql`${agentAutonomyProgressionHeads.openAttemptId} IS NULL`,
          ),
        )
        .returning({ characterId: agentAutonomyProgressionHeads.characterId });
      if (!updated[0]) {
        throw new Error("agent_autonomy_progression_head_open_failed");
      }
      return committedAttempt;
    }),
  );
}

function validateRuntimeTerminal(
  attempt: AgentAutonomyProgressionAttempt,
  draft: AgentAutonomyCheckpointDraft,
): void {
  if (
    draft.characterId !== attempt.characterId ||
    draft.lastAttemptedActionType !== attempt.actionType ||
    !RUNTIME_TERMINAL_OUTCOMES.has(draft.lastActionOutcome) ||
    draft.lastAttemptedAt < attempt.startedAt
  ) {
    throw new Error("agent_autonomy_progression_terminal_invalid");
  }
}

async function loadCommittedTerminalCheckpoint(
  db: Database,
  attempt: AgentAutonomyProgressionAttempt,
  expected?: {
    outcome: RuntimeAgentActionOutcome;
    appliedActionType: EmbeddedBehaviorAction["type"] | null;
  },
): Promise<AgentAutonomyCheckpoint | null> {
  const terminal = await db
    .select({
      checkpointRevision: agentAutonomyProgressionEvents.checkpointRevision,
      actionOutcome: agentAutonomyProgressionEvents.actionOutcome,
      appliedActionType: agentAutonomyProgressionEvents.appliedActionType,
    })
    .from(agentAutonomyProgressionEvents)
    .where(
      and(
        eq(agentAutonomyProgressionEvents.attemptId, attempt.attemptId),
        eq(agentAutonomyProgressionEvents.eventType, "attempt_terminal"),
      ),
    )
    .limit(1);
  if (!terminal[0]) return null;
  if (
    expected &&
    (terminal[0].actionOutcome !== expected.outcome ||
      terminal[0].appliedActionType !== expected.appliedActionType)
  ) {
    throw new Error("agent_autonomy_progression_terminal_result_mismatch");
  }
  const checkpoint = await loadAgentAutonomyCheckpoint(db, attempt.characterId);
  if (
    !checkpoint ||
    terminal[0].checkpointRevision === null ||
    checkpoint.revision < terminal[0].checkpointRevision
  ) {
    throw new Error("agent_autonomy_progression_terminal_checkpoint_missing");
  }
  return checkpoint;
}

/** Commit the terminal edge and checkpoint in one physical PG transaction. */
export async function finalizeAgentAutonomyProgressionAttempt(
  pool: PostgresTransactionPool,
  attemptInput: AgentAutonomyProgressionAttempt,
  draft: AgentAutonomyCheckpointDraft,
): Promise<AgentAutonomyCheckpoint> {
  const attempt = normalizeAttempt(attemptInput);
  validateRuntimeTerminal(attempt, draft);

  return withTransactionRetry(() =>
    runInPostgresTransaction(pool, async (tx) => {
      const db = tx as Database;
      const head = await lockHead(
        db,
        attempt.characterId,
        draft.lastAttemptedAt,
      );
      const committed = await loadCommittedTerminalCheckpoint(db, attempt, {
        outcome: draft.lastActionOutcome,
        appliedActionType: draft.lastAppliedActionType,
      });
      if (committed) {
        if (head.openAttemptId !== null) {
          throw new Error("agent_autonomy_progression_terminal_head_mismatch");
        }
        return committed;
      }
      if (!headMatchesAttempt(head, attempt)) {
        throw new Error("agent_autonomy_progression_attempt_not_open");
      }

      const checkpoint = await saveAgentAutonomyCheckpoint(db, draft);
      const occurredAt = Math.max(
        attempt.startedAt,
        draft.lastAttemptedAt,
        checkpoint.updatedAt,
      );
      await db.insert(agentAutonomyProgressionEvents).values({
        eventKey: `${attempt.attemptId}:terminal`,
        attemptId: attempt.attemptId,
        characterId: attempt.characterId,
        eventSource: "runtime",
        eventType: "attempt_terminal",
        phase: attempt.phase,
        goalType: attempt.goalType,
        actionType: attempt.actionType,
        decisionSource: attempt.decisionSource,
        actionOutcome: draft.lastActionOutcome,
        appliedActionType: draft.lastAppliedActionType,
        checkpointRevision: checkpoint.revision,
        occurredAt,
      });
      await recordAgentAutonomyLifecycleTerminal(db, attempt, {
        eventSource: "runtime",
        goalType: checkpoint.goal?.type ?? null,
        actionOutcome: draft.lastActionOutcome,
        checkpointRevision: checkpoint.revision,
        occurredAt,
      });
      const closed = await db
        .update(agentAutonomyProgressionHeads)
        .set({
          openAttemptId: null,
          openPhase: null,
          openGoalType: null,
          openActionType: null,
          openDecisionSource: null,
          openStartedAt: null,
          headRevision: sql`${agentAutonomyProgressionHeads.headRevision} + 1`,
          updatedAt: sql`GREATEST(${agentAutonomyProgressionHeads.updatedAt}, ${occurredAt})`,
        })
        .where(
          and(
            eq(agentAutonomyProgressionHeads.characterId, attempt.characterId),
            eq(agentAutonomyProgressionHeads.openAttemptId, attempt.attemptId),
          ),
        )
        .returning({ characterId: agentAutonomyProgressionHeads.characterId });
      if (!closed[0]) {
        throw new Error("agent_autonomy_progression_head_close_failed");
      }
      return checkpoint;
    }),
  );
}

/**
 * Close a started edge left open by a dead process. An optional subsystem
 * resolver may prove a synchronous committed receipt inside this same locked
 * transaction. Without exact proof, recovery records uncertainty and never
 * replays the action.
 */
export async function recoverOpenAgentAutonomyProgressionAttempt(
  pool: PostgresTransactionPool,
  instance: AgentInstance,
  now = Date.now(),
  resolveCommittedOutcome?: AgentAutonomyRecoveryResolver,
): Promise<RecoveredAgentAutonomyAttempt | null> {
  const characterId = normalizeCharacterId(instance.config.characterId);
  const recoveredAt = safeTimestamp(now, "recovered_at");

  return withTransactionRetry(() =>
    runInPostgresTransaction(pool, async (tx) => {
      const db = tx as Database;
      const head = await lockHead(db, characterId, recoveredAt);
      if (head.openAttemptId === null) return null;
      const attempt = attemptFromHead(head);
      const existing = await loadCommittedTerminalCheckpoint(db, attempt);
      if (existing) {
        throw new Error("agent_autonomy_progression_recovery_head_mismatch");
      }

      const resolvedActionResult = resolveCommittedOutcome
        ? await resolveCommittedOutcome(db, attempt)
        : null;
      if (
        resolvedActionResult &&
        (resolvedActionResult.attemptedActionType !== attempt.actionType ||
          resolvedActionResult.appliedActionType === null ||
          !["completed", "dispatched"].includes(resolvedActionResult.outcome))
      ) {
        throw new Error("agent_autonomy_progression_recovery_result_invalid");
      }
      const actionResult: AgentAutonomyActionResult = resolvedActionResult ?? {
        attemptedActionType: attempt.actionType,
        appliedActionType: null,
        outcome: "unknown_after_restart",
      };
      const priorCheckpoint = await loadAgentAutonomyCheckpoint(
        db,
        characterId,
      );
      const occurredAt = Math.max(
        attempt.startedAt,
        recoveredAt,
        priorCheckpoint?.updatedAt ?? 0,
      );
      const draft = buildAgentAutonomyCheckpointDraft(
        instance,
        actionResult,
        occurredAt,
      );
      const checkpoint = await saveAgentAutonomyCheckpoint(db, draft);
      const eventSource = resolvedActionResult
        ? "restart_reconciliation"
        : "restart_recovery";
      await db.insert(agentAutonomyProgressionEvents).values({
        eventKey: `${attempt.attemptId}:terminal`,
        attemptId: attempt.attemptId,
        characterId: attempt.characterId,
        eventSource,
        eventType: "attempt_terminal",
        phase: attempt.phase,
        goalType: attempt.goalType,
        actionType: attempt.actionType,
        decisionSource: attempt.decisionSource,
        actionOutcome: actionResult.outcome,
        appliedActionType: actionResult.appliedActionType,
        checkpointRevision: checkpoint.revision,
        occurredAt,
      });
      await recordAgentAutonomyLifecycleTerminal(db, attempt, {
        eventSource,
        goalType: checkpoint.goal?.type ?? null,
        actionOutcome: actionResult.outcome,
        checkpointRevision: checkpoint.revision,
        occurredAt,
      });
      const closed = await db
        .update(agentAutonomyProgressionHeads)
        .set({
          openAttemptId: null,
          openPhase: null,
          openGoalType: null,
          openActionType: null,
          openDecisionSource: null,
          openStartedAt: null,
          headRevision: sql`${agentAutonomyProgressionHeads.headRevision} + 1`,
          updatedAt: sql`GREATEST(${agentAutonomyProgressionHeads.updatedAt}, ${occurredAt})`,
        })
        .where(
          and(
            eq(agentAutonomyProgressionHeads.characterId, characterId),
            eq(agentAutonomyProgressionHeads.openAttemptId, attempt.attemptId),
          ),
        )
        .returning({ characterId: agentAutonomyProgressionHeads.characterId });
      if (!closed[0]) {
        throw new Error("agent_autonomy_progression_recovery_close_failed");
      }
      return { attempt, checkpoint };
    }),
  );
}
