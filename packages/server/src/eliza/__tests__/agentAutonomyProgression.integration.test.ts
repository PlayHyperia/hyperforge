import { readFile } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ITEMS } from "@hyperforge/shared";

import { createPostgresClientDatabase } from "../../database/postgres-transaction.js";
import type { Database } from "../../database/client.js";
import * as schema from "../../database/schema.js";
import { AgentManager } from "../AgentManager.js";
import { executeAuthoritativeAgentBankTransfer } from "../AuthoritativeAgentBanking.js";
import {
  buildAgentAutonomyCheckpointDraft,
  saveAgentAutonomyCheckpoint,
  type AgentAutonomyActionResult,
} from "../agentAutonomyCheckpoint.js";
import {
  beginAgentAutonomyProgressionAttempt,
  finalizeAgentAutonomyProgressionAttempt,
  recoverOpenAgentAutonomyProgressionAttempt,
} from "../agentAutonomyProgression.js";
import { loadAgentAutonomyLifecycleHead } from "../agentAutonomyLifecycle.js";
import {
  getOrdinaryBankOperationId,
  getOrdinaryBankStageOperationId,
  resolveOrdinaryBankingRecovery,
} from "../ordinaryAgentBanking.js";
import {
  getOrdinaryBoneBurialOperationId,
  resolveOrdinaryBoneBurialRecovery,
} from "../ordinaryAgentPrayerTraining.js";
import {
  getOrdinaryStoreBuyOperationId,
  resolveOrdinaryStoreRecovery,
} from "../ordinaryAgentStore.js";
import type { AgentInstance } from "../managers/AgentBehaviorTicker.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;

function makeInstance(characterId: string): AgentInstance {
  return {
    config: {
      characterId,
      accountId: `account-${characterId}`,
      name: `Agent ${characterId}`,
    },
    goal: { type: "gathering", description: "Gather verified resources" },
    llmPlan: {
      steps: ["Gather one resource", "Reassess inventory"],
      currentStep: 0,
      createdAt: 100,
      goal: "Gather verified resources",
    },
    memories: [],
    recentActionLog: [],
    tickCounter: 0,
  } as unknown as AgentInstance;
}

function draftFor(
  instance: AgentInstance,
  actionResult: AgentAutonomyActionResult,
  now: number,
) {
  return buildAgentAutonomyCheckpointDraft(instance, actionResult, now);
}

describeDatabase("agent autonomy progression PostgreSQL contract", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let db: Database;
  let databaseName: string;

  beforeAll(async () => {
    const suffix = `${process.pid}_${Date.now().toString(36)}`.replace(
      /[^a-z0-9_]/g,
      "",
    );
    databaseName = `hyperia_progression_${suffix}`;
    const adminUrl = new URL(baseDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 2 });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);

    const testUrl = new URL(baseDatabaseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 12 });
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          import.meta.dirname,
          "../../database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    db = drizzle(pool, { schema });

    for (const characterId of [
      "progression-linear",
      "progression-concurrent",
      "progression-recovery",
      "progression-bank-recovery",
      "progression-bank-withdraw-recovery",
      "progression-bank-composite",
      "progression-store-recovery",
      "progression-prayer-recovery",
      "progression-manager-recovery",
      "progression-rollback",
      "progression-lifecycle-start-rollback",
      "progression-lifecycle",
      "progression-autocast-lifecycle",
    ]) {
      await db.insert(schema.users).values({
        id: `account-${characterId}`,
        name: `Account ${characterId}`,
        roles: "user",
        createdAt: "2026-08-09T00:00:00.000Z",
      });
      await db.insert(schema.characters).values({
        id: characterId,
        accountId: `account-${characterId}`,
        name: characterId,
        isAgent: 1,
      });
    }
  }, 30_000);

  afterAll(async () => {
    ITEMS.delete("progression_composite_a");
    ITEMS.delete("progression_composite_b");
    await pool?.end();
    if (adminPool && databaseName) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
  }, 30_000);

  it("commits a start before execution and atomically pairs terminal truth with checkpoint revision", async () => {
    const instance = makeInstance("progression-linear");
    const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "11111111-1111-4111-8111-111111111111",
      characterId: instance.config.characterId,
      goalType: "gathering",
      actionType: "gather",
      decisionSource: "llm",
      startedAt: 1_000,
    });

    const before = await pool.query<{
      event_type: string;
      action_outcome: string | null;
      open_attempt_id: string | null;
    }>(
      `SELECT event.event_type, event.action_outcome, head.open_attempt_id
       FROM agent_autonomy_progression_events event
       JOIN agent_autonomy_progression_heads head USING (character_id)
       WHERE event.attempt_id = $1`,
      [attempt.attemptId],
    );
    expect(before.rows).toEqual([
      {
        event_type: "attempt_started",
        action_outcome: null,
        open_attempt_id: attempt.attemptId,
      },
    ]);

    const checkpoint = await finalizeAgentAutonomyProgressionAttempt(
      pool,
      attempt,
      draftFor(
        instance,
        {
          attemptedActionType: "gather",
          appliedActionType: "gather",
          outcome: "dispatched",
        },
        1_100,
      ),
    );
    expect(checkpoint).toMatchObject({
      schemaVersion: 3,
      revision: 1,
      lastAttemptedActionType: "gather",
      lastActionOutcome: "dispatched",
      lastAppliedActionType: "gather",
    });

    const after = await pool.query<{
      event_type: string;
      event_source: string;
      action_outcome: string | null;
      applied_action_type: string | null;
      checkpoint_revision: string | null;
    }>(
      `SELECT event_type, event_source, action_outcome,
              applied_action_type, checkpoint_revision::text
       FROM agent_autonomy_progression_events
       WHERE attempt_id = $1 ORDER BY event_sequence`,
      [attempt.attemptId],
    );
    expect(after.rows).toEqual([
      {
        event_type: "attempt_started",
        event_source: "runtime",
        action_outcome: null,
        applied_action_type: null,
        checkpoint_revision: null,
      },
      {
        event_type: "attempt_terminal",
        event_source: "runtime",
        action_outcome: "dispatched",
        applied_action_type: "gather",
        checkpoint_revision: "1",
      },
    ]);

    await expect(
      finalizeAgentAutonomyProgressionAttempt(
        pool,
        attempt,
        draftFor(
          instance,
          {
            attemptedActionType: "gather",
            appliedActionType: "gather",
            outcome: "dispatched",
          },
          1_100,
        ),
      ),
    ).resolves.toMatchObject({ revision: 1 });

    const regressedInput = {
      attemptId: "66666666-6666-4666-8666-666666666666",
      characterId: instance.config.characterId,
      goalType: "gathering" as const,
      actionType: "gather" as const,
      decisionSource: "scripted" as const,
      startedAt: 900,
    };
    const monotonicAttempt = await beginAgentAutonomyProgressionAttempt(
      pool,
      regressedInput,
    );
    expect(monotonicAttempt.startedAt).toBe(1_100);
    await expect(
      beginAgentAutonomyProgressionAttempt(pool, regressedInput),
    ).resolves.toEqual(monotonicAttempt);

    const monotonicStart = await pool.query<{ occurred_at: string }>(
      `SELECT occurred_at::text
       FROM agent_autonomy_progression_events
       WHERE attempt_id = $1 AND event_type = 'attempt_started'`,
      [monotonicAttempt.attemptId],
    );
    expect(monotonicStart.rows).toEqual([{ occurred_at: "1100" }]);
    await finalizeAgentAutonomyProgressionAttempt(
      pool,
      monotonicAttempt,
      draftFor(
        instance,
        {
          attemptedActionType: "gather",
          appliedActionType: null,
          outcome: "rejected",
        },
        monotonicAttempt.startedAt,
      ),
    );

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'agent_autonomy_progression_events'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "event_sequence",
      "event_key",
      "attempt_id",
      "character_id",
      "event_source",
      "event_type",
      "phase",
      "goal_type",
      "action_type",
      "decision_source",
      "action_outcome",
      "applied_action_type",
      "checkpoint_revision",
      "occurred_at",
    ]);
  });

  it("persists the typed autocast action through a fresh lifecycle migration", async () => {
    const instance = makeInstance("progression-autocast-lifecycle");
    instance.goal = {
      type: "provisioning",
      description: "Prepare an authored magic loadout",
    };
    const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "17777777-7777-4777-8777-777777777777",
      characterId: instance.config.characterId,
      goalType: "provisioning",
      actionType: "setAutocast",
      decisionSource: "scripted",
      startedAt: 1_200,
    });
    await finalizeAgentAutonomyProgressionAttempt(
      pool,
      attempt,
      draftFor(
        instance,
        {
          attemptedActionType: "setAutocast",
          appliedActionType: "setAutocast",
          outcome: "completed",
        },
        1_300,
      ),
    );

    await expect(
      loadAgentAutonomyLifecycleHead(db, instance.config.characterId),
    ).resolves.toMatchObject({
      state: "provisioning",
      latestActionType: "setAutocast",
      latestActionStartedAt: 1_200,
      headRevision: 2,
    });
  });

  it("allows exactly one concurrent open attempt per agent", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        beginAgentAutonomyProgressionAttempt(pool, {
          attemptId: `22222222-2222-4222-8${index}22-22222222222${index}`,
          characterId: "progression-concurrent",
          goalType: "smelting",
          actionType: "smelt",
          decisionSource: "scripted",
          startedAt: 2_000 + index,
        }),
      ),
    );
    const fulfilled = attempts.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof beginAgentAutonomyProgressionAttempt>>
      > => result.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(4);

    const instance = makeInstance("progression-concurrent");
    await finalizeAgentAutonomyProgressionAttempt(
      pool,
      fulfilled[0].value,
      draftFor(
        instance,
        {
          attemptedActionType: "smelt",
          appliedActionType: null,
          outcome: "rejected",
        },
        2_100,
      ),
    );
    const counts = await pool.query<{ starts: string; terminals: string }>(
      `SELECT
         count(*) FILTER (WHERE event_type = 'attempt_started')::text AS starts,
         count(*) FILTER (WHERE event_type = 'attempt_terminal')::text AS terminals
       FROM agent_autonomy_progression_events
       WHERE character_id = 'progression-concurrent'`,
    );
    expect(counts.rows[0]).toEqual({ starts: "1", terminals: "1" });
  });

  it("records goal selection, concrete work, reassessment, and goal clearing as one ordered private-safe lifecycle", async () => {
    const characterId = "progression-lifecycle";
    const instance = makeInstance(characterId);
    const rejectedMove = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "a1111111-1111-4111-8111-111111111111",
      characterId,
      goalType: "gathering",
      actionType: "move",
      decisionSource: "scripted",
      startedAt: 10_000,
    });
    await finalizeAgentAutonomyProgressionAttempt(
      pool,
      rejectedMove,
      draftFor(
        instance,
        {
          attemptedActionType: "move",
          appliedActionType: null,
          outcome: "rejected",
        },
        10_100,
      ),
    );

    const gathered = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "a2222222-2222-4222-8222-222222222222",
      characterId,
      goalType: "gathering",
      actionType: "gather",
      decisionSource: "scripted",
      startedAt: 10_200,
    });
    instance.goal = null;
    await finalizeAgentAutonomyProgressionAttempt(
      pool,
      gathered,
      draftFor(
        instance,
        {
          attemptedActionType: "gather",
          appliedActionType: "gather",
          outcome: "completed",
        },
        10_300,
      ),
    );

    instance.goal = {
      type: "provisioning",
      description: "Acquire verified supplies",
    };
    const provisioned = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "a3333333-3333-4333-8333-333333333333",
      characterId,
      goalType: "provisioning",
      actionType: "storeBuy",
      decisionSource: "llm",
      startedAt: 10_400,
    });
    await finalizeAgentAutonomyProgressionAttempt(
      pool,
      provisioned,
      draftFor(
        instance,
        {
          attemptedActionType: "storeBuy",
          appliedActionType: "storeBuy",
          outcome: "completed",
        },
        10_500,
      ),
    );

    // Moving toward the next provisioning context stays in the same broad
    // lifecycle category, but its bounded latest action must still persist for
    // privacy-safe travel storytelling and restart recovery.
    const provisioningTravel = await beginAgentAutonomyProgressionAttempt(
      pool,
      {
        attemptId: "a4444444-4444-4444-8444-444444444444",
        characterId,
        goalType: "provisioning",
        actionType: "move",
        decisionSource: "scripted",
        startedAt: 10_600,
      },
    );
    await finalizeAgentAutonomyProgressionAttempt(
      pool,
      provisioningTravel,
      draftFor(
        instance,
        {
          attemptedActionType: "move",
          appliedActionType: "move",
          outcome: "dispatched",
        },
        10_700,
      ),
    );

    const events = await pool.query<{
      event_type: string;
      lifecycle_state: string;
      previous_state: string | null;
      previous_goal_type: string | null;
      goal_type: string | null;
      action_type: string;
      action_outcome: string | null;
      checkpoint_revision: string | null;
    }>(
      `SELECT event_type, lifecycle_state, previous_state,
              previous_goal_type, goal_type, action_type, action_outcome,
              checkpoint_revision::text
       FROM agent_autonomy_lifecycle_events
       WHERE character_id = $1 ORDER BY event_sequence`,
      [characterId],
    );
    expect(events.rows).toEqual([
      {
        event_type: "goal_selected",
        lifecycle_state: "goal_selection",
        previous_state: "goal_selection",
        previous_goal_type: null,
        goal_type: "gathering",
        action_type: "move",
        action_outcome: null,
        checkpoint_revision: null,
      },
      {
        event_type: "state_entered",
        lifecycle_state: "gathering",
        previous_state: "goal_selection",
        previous_goal_type: "gathering",
        goal_type: "gathering",
        action_type: "move",
        action_outcome: null,
        checkpoint_revision: null,
      },
      {
        event_type: "reassessment_required",
        lifecycle_state: "reassessment",
        previous_state: "gathering",
        previous_goal_type: "gathering",
        goal_type: "gathering",
        action_type: "move",
        action_outcome: "rejected",
        checkpoint_revision: "1",
      },
      {
        event_type: "state_entered",
        lifecycle_state: "gathering",
        previous_state: "reassessment",
        previous_goal_type: "gathering",
        goal_type: "gathering",
        action_type: "gather",
        action_outcome: null,
        checkpoint_revision: null,
      },
      {
        event_type: "goal_cleared",
        lifecycle_state: "goal_selection",
        previous_state: "gathering",
        previous_goal_type: "gathering",
        goal_type: null,
        action_type: "gather",
        action_outcome: "completed",
        checkpoint_revision: "2",
      },
      {
        event_type: "goal_selected",
        lifecycle_state: "goal_selection",
        previous_state: "goal_selection",
        previous_goal_type: null,
        goal_type: "provisioning",
        action_type: "storeBuy",
        action_outcome: null,
        checkpoint_revision: null,
      },
      {
        event_type: "state_entered",
        lifecycle_state: "provisioning",
        previous_state: "goal_selection",
        previous_goal_type: "provisioning",
        goal_type: "provisioning",
        action_type: "storeBuy",
        action_outcome: null,
        checkpoint_revision: null,
      },
    ]);

    const head = await pool.query<{
      current_state: string;
      current_goal_type: string;
      latest_action_type: string;
      latest_action_started_at: string;
      head_revision: string;
    }>(
      `SELECT current_state, current_goal_type, latest_action_type,
              latest_action_started_at::text, head_revision::text
       FROM agent_autonomy_lifecycle_heads WHERE character_id = $1`,
      [characterId],
    );
    expect(head.rows).toEqual([
      {
        current_state: "provisioning",
        current_goal_type: "provisioning",
        latest_action_type: "move",
        latest_action_started_at: "10600",
        head_revision: "7",
      },
    ]);
    const publicHead = await loadAgentAutonomyLifecycleHead(db, characterId);
    expect(publicHead).toMatchObject({
      state: "provisioning",
      latestActionType: "move",
      latestActionStartedAt: 10_600,
      headRevision: 7,
    });
    expect(publicHead?.updatedAt).toBe(10_600);
    expect(Object.isFrozen(publicHead)).toBe(true);
    await expect(
      pool.query(
        `UPDATE agent_autonomy_lifecycle_heads
         SET latest_action_started_at = NULL
         WHERE character_id = $1`,
        [characterId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `UPDATE agent_autonomy_lifecycle_heads
         SET latest_action_type = 'move_to_private_target'
         WHERE character_id = $1`,
        [characterId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'agent_autonomy_lifecycle_events'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "event_sequence",
      "event_key",
      "character_id",
      "attempt_id",
      "event_source",
      "event_type",
      "lifecycle_state",
      "previous_state",
      "previous_goal_type",
      "goal_type",
      "action_type",
      "action_outcome",
      "checkpoint_revision",
      "occurred_at",
    ]);
  });

  it("recovers an unresolved start as explicit uncertainty without replaying it", async () => {
    const priorInstance = makeInstance("progression-recovery");
    await saveAgentAutonomyCheckpoint(
      db,
      draftFor(
        priorInstance,
        {
          attemptedActionType: "idle",
          appliedActionType: null,
          outcome: "idle",
        },
        4_000,
      ),
    );
    const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "33333333-3333-4333-8333-333333333333",
      characterId: "progression-recovery",
      goalType: "combat",
      actionType: "attack",
      decisionSource: "llm",
      startedAt: 3_000,
    });
    const replacement = makeInstance("progression-recovery");
    replacement.pendingLlmResult = undefined;
    const recovered = await recoverOpenAgentAutonomyProgressionAttempt(
      pool,
      replacement,
      3_500,
    );
    expect(recovered?.attempt).toEqual(attempt);
    expect(recovered?.checkpoint).toMatchObject({
      schemaVersion: 3,
      revision: 2,
      lastAttemptedActionType: "attack",
      lastActionOutcome: "unknown_after_restart",
      lastAppliedActionType: null,
      requiresReassessment: true,
      updatedAt: 4_000,
    });
    await expect(
      recoverOpenAgentAutonomyProgressionAttempt(pool, replacement, 3_600),
    ).resolves.toBeNull();

    const terminal = await pool.query<{
      event_source: string;
      action_outcome: string;
      applied_action_type: string | null;
      occurred_at: string;
    }>(
      `SELECT event_source, action_outcome, applied_action_type, occurred_at::text
       FROM agent_autonomy_progression_events
       WHERE attempt_id = $1 AND event_type = 'attempt_terminal'`,
      [attempt.attemptId],
    );
    expect(terminal.rows).toEqual([
      {
        event_source: "restart_recovery",
        action_outcome: "unknown_after_restart",
        applied_action_type: null,
        occurred_at: "4000",
      },
    ]);
  });

  it("recovers a process-killed bank action as completed only from its immutable committed receipt", async () => {
    const characterId = "progression-bank-recovery";
    const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "7d745091-b5d8-4fe5-bff7-f18409243432",
      characterId,
      goalType: "banking",
      actionType: "bankDepositAll",
      decisionSource: "scripted",
      startedAt: 4_100,
    });
    await db.insert(schema.agentBankOperations).values({
      operationId: getOrdinaryBankOperationId(attempt.attemptId),
      playerId: characterId,
      action: "deposit_all",
      bankId: "bank-1",
      itemId: null,
      requestedQuantity: 8,
      committedQuantity: 8,
      inventoryQuantityAfter: 4,
      bankQuantityAfter: null,
      requestFingerprint: "a".repeat(64),
      itemCount: 0,
      createdAt: 4_200,
    });

    const recovered = await recoverOpenAgentAutonomyProgressionAttempt(
      pool,
      makeInstance(characterId),
      4_300,
      resolveOrdinaryBankingRecovery,
    );

    expect(recovered?.checkpoint).toMatchObject({
      lastAttemptedActionType: "bankDepositAll",
      lastActionOutcome: "completed",
      lastAppliedActionType: "bankDepositAll",
      requiresReassessment: true,
    });
    const terminal = await pool.query<{
      event_source: string;
      action_outcome: string;
      applied_action_type: string;
    }>(
      `SELECT event_source, action_outcome, applied_action_type
       FROM agent_autonomy_progression_events
       WHERE attempt_id = $1 AND event_type = 'attempt_terminal'`,
      [attempt.attemptId],
    );
    expect(terminal.rows).toEqual([
      {
        event_source: "restart_reconciliation",
        action_outcome: "completed",
        applied_action_type: "bankDepositAll",
      },
    ]);
  });

  it("recovers a process-killed ordinary withdrawal only from its exact immutable receipt", async () => {
    const characterId = "progression-bank-withdraw-recovery";
    const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "15b42b68-9508-42b4-bf0c-c8c4d7aa42ec",
      characterId,
      goalType: "banking",
      actionType: "bankWithdraw",
      decisionSource: "scripted",
      startedAt: 4_350,
    });
    await db.insert(schema.agentBankOperations).values({
      operationId: getOrdinaryBankStageOperationId(attempt.attemptId),
      playerId: characterId,
      action: "withdraw",
      bankId: "bank-1",
      itemId: "raw_shrimp",
      requestedQuantity: 5,
      committedQuantity: 5,
      inventoryQuantityAfter: 5,
      bankQuantityAfter: 7,
      requestFingerprint: "c".repeat(64),
      itemCount: 1,
      createdAt: 4_400,
    });

    const recovered = await recoverOpenAgentAutonomyProgressionAttempt(
      pool,
      makeInstance(characterId),
      4_450,
      resolveOrdinaryBankingRecovery,
    );

    expect(recovered?.checkpoint).toMatchObject({
      lastAttemptedActionType: "bankWithdraw",
      lastActionOutcome: "completed",
      lastAppliedActionType: "bankWithdraw",
      requiresReassessment: true,
    });
    const terminal = await pool.query<{
      event_source: string;
      action_outcome: string;
      applied_action_type: string;
    }>(
      `SELECT event_source, action_outcome, applied_action_type
       FROM agent_autonomy_progression_events
       WHERE attempt_id = $1 AND event_type = 'attempt_terminal'`,
      [attempt.attemptId],
    );
    expect(terminal.rows).toEqual([
      {
        event_source: "restart_reconciliation",
        action_outcome: "completed",
        applied_action_type: "bankWithdraw",
      },
    ]);
  });

  it("recovers a process-killed autonomous purchase only from its exact immutable receipt", async () => {
    const characterId = "progression-store-recovery";
    const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "884c4d9e-3b28-49ca-b8cf-6dd7ee8a5103",
      characterId,
      goalType: "provisioning",
      actionType: "storeBuy",
      decisionSource: "scripted",
      startedAt: 4_475,
    });
    await db.insert(schema.agentStoreOperations).values({
      operationId: getOrdinaryStoreBuyOperationId(attempt.attemptId),
      playerId: characterId,
      action: "buy",
      storeId: "verified_store",
      itemId: "verified_tool",
      requestedQuantity: 1,
      unitPrice: 10,
      totalValue: 10,
      coinBalanceAfter: 90,
      inventoryQuantityAfter: 1,
      requestFingerprint: "d".repeat(64),
      createdAt: 4_500,
    });

    const recovered = await recoverOpenAgentAutonomyProgressionAttempt(
      pool,
      makeInstance(characterId),
      4_525,
      resolveOrdinaryStoreRecovery,
    );

    expect(recovered?.checkpoint).toMatchObject({
      lastAttemptedActionType: "storeBuy",
      lastActionOutcome: "completed",
      lastAppliedActionType: "storeBuy",
      requiresReassessment: true,
    });
    const terminal = await pool.query<{
      event_source: string;
      action_outcome: string;
      applied_action_type: string;
    }>(
      `SELECT event_source, action_outcome, applied_action_type
       FROM agent_autonomy_progression_events
       WHERE attempt_id = $1 AND event_type = 'attempt_terminal'`,
      [attempt.attemptId],
    );
    expect(terminal.rows).toEqual([
      {
        event_source: "restart_reconciliation",
        action_outcome: "completed",
        applied_action_type: "storeBuy",
      },
    ]);
  });

  it("recovers a process-killed burial only from its exact immutable custody receipt", async () => {
    const characterId = "progression-prayer-recovery";
    const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "c1781e48-bb41-487f-9317-51eefdf73d6b",
      characterId,
      goalType: "provisioning",
      actionType: "bury",
      decisionSource: "scripted",
      startedAt: 4_400,
    });
    await db.insert(schema.boneBurialOperations).values({
      operationId: getOrdinaryBoneBurialOperationId(attempt.attemptId),
      playerId: characterId,
      itemId: "verified_bones",
      xpAmount: 20,
      levelRequired: 1,
      awardedXp: 20,
      operationCommittedXp: 100,
      committedLevel: 2,
      requestFingerprint: "b".repeat(64),
      createdAt: 4_500,
    });

    const recovered = await recoverOpenAgentAutonomyProgressionAttempt(
      pool,
      makeInstance(characterId),
      4_600,
      resolveOrdinaryBoneBurialRecovery,
    );

    expect(recovered?.checkpoint).toMatchObject({
      lastAttemptedActionType: "bury",
      lastActionOutcome: "completed",
      lastAppliedActionType: "bury",
      requiresReassessment: true,
    });
    const terminal = await pool.query<{
      event_source: string;
      action_outcome: string;
      applied_action_type: string;
    }>(
      `SELECT event_source, action_outcome, applied_action_type
       FROM agent_autonomy_progression_events
       WHERE attempt_id = $1 AND event_type = 'attempt_terminal'`,
      [attempt.attemptId],
    );
    expect(terminal.rows).toEqual([
      {
        event_source: "restart_reconciliation",
        action_outcome: "completed",
        applied_action_type: "bury",
      },
    ]);
  });

  it("commits, replays, and constrains a composite withdrawal in real PostgreSQL", async () => {
    const characterId = "progression-bank-composite";
    const itemA = "progression_composite_a";
    const itemB = "progression_composite_b";
    ITEMS.set(itemA, {
      id: itemA,
      name: itemA,
      type: "resource",
      stackable: false,
    } as never);
    ITEMS.set(itemB, {
      id: itemB,
      name: itemB,
      type: "resource",
      stackable: true,
    } as never);
    await pool.query(
      `INSERT INTO bank_storage
         ("playerId", "itemId", quantity, slot, "tabIndex")
       VALUES ($1, $2, 5, 0, 0), ($1, $3, 10, 1, 0)`,
      [characterId, itemA, itemB],
    );
    const entities = new Map<string, unknown>([
      [
        characterId,
        { position: { x: 0, y: 0, z: 0 }, data: { inStreamingDuel: false } },
      ],
      ["bank-1", { position: { x: 1, y: 0, z: 1 }, data: { type: "bank" } }],
    ]);
    const inventorySystem = {
      isInventoryReady: () => true,
      queueOperation: async (
        _playerId: string,
        operation: () => Promise<boolean>,
      ) => operation(),
      lockForTransaction: () => true,
      unlockTransaction: () => undefined,
      persistInventoryImmediate: async () => undefined,
      reloadFromDatabase: async () => undefined,
    };
    const world = {
      pgPool: pool,
      entities: { get: (id: string) => entities.get(id) },
      getSystem: (name: string) =>
        name === "inventory" ? inventorySystem : null,
    };
    const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "ebbb5df2-2b6d-4a14-b1ea-713cc82d805f",
      characterId,
      goalType: "banking",
      actionType: "bankWithdraw",
      decisionSource: "scripted",
      startedAt: 4_500,
    });
    const operationId = getOrdinaryBankStageOperationId(attempt.attemptId);
    const request = {
      world: world as never,
      playerId: characterId,
      bankId: "bank-1",
      action: "withdraw" as const,
      operationId,
      withdrawItems: [
        { itemId: itemB, quantity: 3 },
        { itemId: itemA, quantity: 2 },
      ],
    };

    const receipts = await Promise.all(
      Array.from({ length: 5 }, () =>
        executeAuthoritativeAgentBankTransfer(request),
      ),
    );
    expect(receipts.every((receipt) => receipt.success)).toBe(true);
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.replayed)).toHaveLength(4);
    expect(receipts[0]).toMatchObject({
      action: "withdraw",
      itemId: null,
      requestedQuantity: 5,
      committedQuantity: 5,
      inventoryQuantityAfter: 5,
      bankQuantityAfter: null,
    });
    const committed = await pool.query<{
      item_count: number;
      requested_quantity: number;
      committed_quantity: number;
      item_id: string;
      item_requested: number;
      item_committed: number;
      inventory_after: number;
      bank_after: number;
    }>(
      `SELECT parent."itemCount" AS item_count,
              parent."requestedQuantity" AS requested_quantity,
              parent."committedQuantity" AS committed_quantity,
              item."itemId" AS item_id,
              item."requestedQuantity" AS item_requested,
              item."committedQuantity" AS item_committed,
              item."inventoryQuantityAfter" AS inventory_after,
              item."bankQuantityAfter" AS bank_after
       FROM agent_bank_operations parent
       JOIN agent_bank_operation_items item USING ("operationId")
       WHERE parent."operationId" = $1 ORDER BY item."itemId"`,
      [operationId],
    );
    expect(committed.rows).toEqual([
      {
        item_count: 2,
        requested_quantity: 5,
        committed_quantity: 5,
        item_id: itemA,
        item_requested: 2,
        item_committed: 2,
        inventory_after: 2,
        bank_after: 3,
      },
      {
        item_count: 2,
        requested_quantity: 5,
        committed_quantity: 5,
        item_id: itemB,
        item_requested: 3,
        item_committed: 3,
        inventory_after: 3,
        bank_after: 7,
      },
    ]);
    const recovered = await recoverOpenAgentAutonomyProgressionAttempt(
      pool,
      makeInstance(characterId),
      4_600,
      resolveOrdinaryBankingRecovery,
    );
    expect(recovered?.checkpoint).toMatchObject({
      lastAttemptedActionType: "bankWithdraw",
      lastActionOutcome: "completed",
      lastAppliedActionType: "bankWithdraw",
      requiresReassessment: true,
    });

    const custodyBeforeFailure = await pool.query(
      `SELECT 'inventory' AS source, "itemId", quantity
       FROM inventory WHERE "playerId" = $1
       UNION ALL
       SELECT 'bank' AS source, "itemId", quantity
       FROM bank_storage WHERE "playerId" = $1
       ORDER BY source, "itemId"`,
      [characterId],
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_composite_component_receipt()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."itemId" = '${itemB}' THEN
          RAISE EXCEPTION 'forced composite component receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER aaa_fail_test_composite_component_receipt
      BEFORE INSERT ON agent_bank_operation_items
      FOR EACH ROW EXECUTE FUNCTION fail_test_composite_component_receipt();
    `);
    const forcedReceiptFailure = await executeAuthoritativeAgentBankTransfer({
      ...request,
      operationId: "f3848df3-13bd-4932-a964-5920488aec6c",
      withdrawItems: [
        { itemId: itemA, quantity: 1 },
        { itemId: itemB, quantity: 1 },
      ],
    });
    expect(forcedReceiptFailure).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "operation_failed",
    });
    await pool.query(
      `DROP TRIGGER aaa_fail_test_composite_component_receipt
       ON agent_bank_operation_items`,
    );
    await pool.query(`DROP FUNCTION fail_test_composite_component_receipt()`);
    const custodyAfterReceiptFailure = await pool.query(
      `SELECT 'inventory' AS source, "itemId", quantity
       FROM inventory WHERE "playerId" = $1
       UNION ALL
       SELECT 'bank' AS source, "itemId", quantity
       FROM bank_storage WHERE "playerId" = $1
       ORDER BY source, "itemId"`,
      [characterId],
    );
    expect(custodyAfterReceiptFailure.rows).toEqual(custodyBeforeFailure.rows);
    const forcedReceiptRows = await pool.query<{
      receipts: string;
      items: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM agent_bank_operations
          WHERE "operationId" = $1) AS receipts,
         (SELECT count(*)::text FROM agent_bank_operation_items
          WHERE "operationId" = $1) AS items`,
      ["f3848df3-13bd-4932-a964-5920488aec6c"],
    );
    expect(forcedReceiptRows.rows[0]).toEqual({ receipts: "0", items: "0" });

    const rejected = await executeAuthoritativeAgentBankTransfer({
      ...request,
      operationId: "674da094-aac8-445a-85f7-a7036df28141",
      withdrawItems: [
        { itemId: itemA, quantity: 1 },
        { itemId: itemB, quantity: 100 },
      ],
    });
    expect(rejected).toMatchObject({
      success: false,
      commitState: "not_committed",
      failureReason: "insufficient_bank_quantity",
    });
    const custodyAfterFailure = await pool.query(
      `SELECT 'inventory' AS source, "itemId", quantity
       FROM inventory WHERE "playerId" = $1
       UNION ALL
       SELECT 'bank' AS source, "itemId", quantity
       FROM bank_storage WHERE "playerId" = $1
       ORDER BY source, "itemId"`,
      [characterId],
    );
    expect(custodyAfterFailure.rows).toEqual(custodyBeforeFailure.rows);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO agent_bank_operations
           ("operationId", "playerId", action, "bankId", "itemId",
            "requestedQuantity", "committedQuantity",
            "inventoryQuantityAfter", "bankQuantityAfter",
            "requestFingerprint", "itemCount")
         VALUES (
           '69578dda-c27a-426a-816f-d68f4e89c6a8', $1, 'withdraw',
           'bank-1', NULL, 2, 2, 2, NULL, $2, 2
         )`,
        [characterId, "e".repeat(64)],
      );
      await expect(client.query("COMMIT")).rejects.toThrow(
        /does not match its components/,
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await expect(
      pool.query(
        `UPDATE agent_bank_operation_items SET "committedQuantity" = 1
         WHERE "operationId" = $1`,
        [operationId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `INSERT INTO agent_bank_operation_items
           ("operationId", "itemId", "requestedQuantity",
            "committedQuantity", "inventoryQuantityAfter",
            "bankQuantityAfter")
         VALUES ($1, 'late_forged_item', 1, 1, 1, 0)`,
        [operationId],
      ),
    ).rejects.toThrow(/exceeds immutable parent receipt/);
    const installedContract = await pool.query<{
      kind: string;
      name: string;
    }>(
      `SELECT 'constraint' AS kind, conname AS name
       FROM pg_constraint
       WHERE conrelid IN (
         'agent_bank_operations'::regclass,
         'agent_bank_operation_items'::regclass
       )
       UNION ALL
       SELECT 'trigger' AS kind, tgname AS name
       FROM pg_trigger
       WHERE tgrelid IN (
         'agent_bank_operations'::regclass,
         'agent_bank_operation_items'::regclass
       ) AND NOT tgisinternal
       ORDER BY kind, name`,
    );
    expect(installedContract.rows).toEqual(
      expect.arrayContaining([
        { kind: "constraint", name: "agent_bank_operations_receipt_check" },
        {
          kind: "constraint",
          name: "agent_bank_operation_items_quantity_check",
        },
        { kind: "constraint", name: "agent_bank_operation_items_pk" },
        {
          kind: "trigger",
          name: "agent_bank_operations_validate_components",
        },
        {
          kind: "trigger",
          name: "agent_bank_operation_items_validate_insert",
        },
        {
          kind: "trigger",
          name: "agent_bank_operation_items_reject_mutation",
        },
        {
          kind: "trigger",
          name: "agent_bank_operation_items_reject_truncate",
        },
      ]),
    );
  });

  it("recovers an open attempt through the manager hydration boundary", async () => {
    const characterId = "progression-manager-recovery";
    await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "99999999-9999-4999-8999-999999999999",
      characterId,
      goalType: "gathering",
      actionType: "gather",
      decisionSource: "scripted",
      startedAt: 5_000,
    });
    const replacement = makeInstance(characterId);
    const world = {
      getSystem: (name: string) =>
        name === "database"
          ? { getDb: () => db, getPool: () => pool }
          : undefined,
      on: () => undefined,
      off: () => undefined,
    };
    const manager = new AgentManager(world as never, {
      startBehaviorBridge: false,
    });

    try {
      await (
        manager as unknown as {
          hydrateAutonomyCheckpoint: (instance: AgentInstance) => Promise<void>;
        }
      ).hydrateAutonomyCheckpoint(replacement);

      expect(replacement).toMatchObject({
        autonomyCheckpointRevision: 1,
        autonomyRecoveryPending: true,
      });
      const checkpoint = await pool.query<{
        last_action_outcome: string;
        revision: string;
      }>(
        `SELECT last_action_outcome, revision::text
         FROM agent_autonomy_checkpoints WHERE character_id = $1`,
        [characterId],
      );
      expect(checkpoint.rows).toEqual([
        { last_action_outcome: "unknown_after_restart", revision: "1" },
      ]);
      await expect(
        recoverOpenAgentAutonomyProgressionAttempt(
          pool,
          makeInstance(characterId),
          5_500,
        ),
      ).resolves.toBeNull();
    } finally {
      manager.dispose();
    }
  });

  it("rolls back the action start and both heads when lifecycle start insertion fails", async () => {
    const characterId = "progression-lifecycle-start-rollback";
    const attemptInput = {
      attemptId: "c4444444-4444-4444-8444-444444444444",
      characterId,
      goalType: "combat" as const,
      actionType: "attack" as const,
      decisionSource: "scripted" as const,
      startedAt: 5_800,
    };
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_lifecycle_start()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced lifecycle start failure';
      END;
      $$;
      CREATE TRIGGER aaa_fail_test_lifecycle_start
      BEFORE INSERT ON agent_autonomy_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION fail_test_lifecycle_start();
    `);
    let startError: unknown;
    try {
      await beginAgentAutonomyProgressionAttempt(pool, attemptInput);
    } catch (error) {
      startError = error;
    }
    await pool.query(
      `DROP TRIGGER aaa_fail_test_lifecycle_start ON agent_autonomy_lifecycle_events`,
    );
    await pool.query(`DROP FUNCTION fail_test_lifecycle_start()`);
    expect(
      (startError as { cause?: { message?: string } })?.cause?.message,
    ).toContain("forced lifecycle start failure");
    const rolledBack = await pool.query<{
      progression_events: string;
      progression_heads: string;
      lifecycle_events: string;
      lifecycle_heads: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM agent_autonomy_progression_events
          WHERE character_id = $1) AS progression_events,
         (SELECT count(*)::text FROM agent_autonomy_progression_heads
          WHERE character_id = $1) AS progression_heads,
         (SELECT count(*)::text FROM agent_autonomy_lifecycle_events
          WHERE character_id = $1) AS lifecycle_events,
         (SELECT count(*)::text FROM agent_autonomy_lifecycle_heads
          WHERE character_id = $1) AS lifecycle_heads`,
      [characterId],
    );
    expect(rolledBack.rows[0]).toEqual({
      progression_events: "0",
      progression_heads: "0",
      lifecycle_events: "0",
      lifecycle_heads: "0",
    });
    const attempt = await beginAgentAutonomyProgressionAttempt(
      pool,
      attemptInput,
    );
    await expect(
      finalizeAgentAutonomyProgressionAttempt(
        pool,
        attempt,
        draftFor(
          makeInstance(characterId),
          {
            attemptedActionType: "attack",
            appliedActionType: null,
            outcome: "rejected",
          },
          5_900,
        ),
      ),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it("rolls back checkpoint and terminal together when terminal insertion fails", async () => {
    const instance = makeInstance("progression-rollback");
    const attempt = await beginAgentAutonomyProgressionAttempt(pool, {
      attemptId: "44444444-4444-4444-8444-444444444444",
      characterId: instance.config.characterId,
      goalType: "gathering",
      actionType: "craft",
      decisionSource: "scripted",
      startedAt: 4_000,
    });
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_progression_terminal()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'attempt_terminal' THEN
          RAISE EXCEPTION 'forced terminal failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER aaa_fail_test_progression_terminal
      BEFORE INSERT ON agent_autonomy_progression_events
      FOR EACH ROW EXECUTE FUNCTION fail_test_progression_terminal();
    `);

    let terminalError: unknown;
    try {
      await finalizeAgentAutonomyProgressionAttempt(
        pool,
        attempt,
        draftFor(
          instance,
          {
            attemptedActionType: "craft",
            appliedActionType: "craft",
            outcome: "completed",
          },
          4_100,
        ),
      );
    } catch (error) {
      terminalError = error;
    }
    expect(
      (terminalError as { cause?: { message?: string } })?.cause?.message,
    ).toContain("forced terminal failure");
    const rolledBack = await pool.query<{
      checkpoints: string;
      terminals: string;
      open_attempt_id: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM agent_autonomy_checkpoints
          WHERE character_id = 'progression-rollback') AS checkpoints,
         (SELECT count(*)::text FROM agent_autonomy_progression_events
          WHERE attempt_id = $1 AND event_type = 'attempt_terminal') AS terminals,
         (SELECT open_attempt_id FROM agent_autonomy_progression_heads
          WHERE character_id = 'progression-rollback') AS open_attempt_id`,
      [attempt.attemptId],
    );
    expect(rolledBack.rows[0]).toEqual({
      checkpoints: "0",
      terminals: "0",
      open_attempt_id: attempt.attemptId,
    });

    await pool.query(
      `DROP TRIGGER aaa_fail_test_progression_terminal ON agent_autonomy_progression_events`,
    );
    await pool.query(`DROP FUNCTION fail_test_progression_terminal()`);

    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_lifecycle_terminal()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.checkpoint_revision IS NOT NULL THEN
          RAISE EXCEPTION 'forced lifecycle terminal failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER aaa_fail_test_lifecycle_terminal
      BEFORE INSERT ON agent_autonomy_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION fail_test_lifecycle_terminal();
    `);
    let lifecycleError: unknown;
    try {
      await finalizeAgentAutonomyProgressionAttempt(
        pool,
        attempt,
        draftFor(
          instance,
          {
            attemptedActionType: "craft",
            appliedActionType: null,
            outcome: "rejected",
          },
          4_100,
        ),
      );
    } catch (error) {
      lifecycleError = error;
    }
    expect(
      (lifecycleError as { cause?: { message?: string } })?.cause?.message,
    ).toContain("forced lifecycle terminal failure");
    const lifecycleRolledBack = await pool.query<{
      checkpoints: string;
      progression_terminals: string;
      lifecycle_terminals: string;
      open_attempt_id: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM agent_autonomy_checkpoints
          WHERE character_id = 'progression-rollback') AS checkpoints,
         (SELECT count(*)::text FROM agent_autonomy_progression_events
          WHERE attempt_id = $1 AND event_type = 'attempt_terminal') AS progression_terminals,
         (SELECT count(*)::text FROM agent_autonomy_lifecycle_events
          WHERE attempt_id = $1 AND checkpoint_revision IS NOT NULL) AS lifecycle_terminals,
         (SELECT open_attempt_id FROM agent_autonomy_progression_heads
          WHERE character_id = 'progression-rollback') AS open_attempt_id`,
      [attempt.attemptId],
    );
    expect(lifecycleRolledBack.rows[0]).toEqual({
      checkpoints: "0",
      progression_terminals: "0",
      lifecycle_terminals: "0",
      open_attempt_id: attempt.attemptId,
    });
    await pool.query(
      `DROP TRIGGER aaa_fail_test_lifecycle_terminal ON agent_autonomy_lifecycle_events`,
    );
    await pool.query(`DROP FUNCTION fail_test_lifecycle_terminal()`);

    await expect(
      finalizeAgentAutonomyProgressionAttempt(
        pool,
        attempt,
        draftFor(
          instance,
          {
            attemptedActionType: "craft",
            appliedActionType: "craft",
            outcome: "completed",
          },
          4_100,
        ),
      ),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it("rejects forged edges and every receipt mutation path, then reapplies the populated hardening migration without drift", async () => {
    await expect(
      pool.query(
        `INSERT INTO agent_autonomy_progression_events (
           event_key, attempt_id, character_id, event_source, event_type,
           phase, goal_type, action_type, decision_source, action_outcome,
           applied_action_type, checkpoint_revision, occurred_at
         ) VALUES (
           '55555555-5555-4555-8555-555555555555:terminal',
           '55555555-5555-4555-8555-555555555555', 'progression-linear',
           'runtime', 'attempt_terminal', 'ordinary_progression', 'gathering',
           'gather', 'llm', 'rejected', NULL, 99, 5000
         )`,
      ),
    ).rejects.toThrow(/no started edge/);
    await expect(
      pool.query(
        `UPDATE agent_autonomy_progression_events SET action_type = 'move'
         WHERE character_id = 'progression-linear'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `DELETE FROM agent_autonomy_progression_events
         WHERE character_id = 'progression-linear'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`TRUNCATE agent_autonomy_progression_events`),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `UPDATE agent_bank_operations SET "committedQuantity" = 1
         WHERE "playerId" = 'progression-bank-recovery'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `DELETE FROM agent_bank_operations
         WHERE "playerId" = 'progression-bank-recovery'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query(`TRUNCATE agent_bank_operations`)).rejects.toThrow(
      /foreign key constraint|append-only/,
    );
    await expect(
      pool.query(`TRUNCATE agent_bank_operations CASCADE`),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `UPDATE agent_store_operations SET total_value = 0
         WHERE player_id = 'progression-store-recovery'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `DELETE FROM agent_store_operations
         WHERE player_id = 'progression-store-recovery'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query(`TRUNCATE agent_store_operations`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      pool.query(`DELETE FROM agent_bank_operation_items`),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`TRUNCATE agent_bank_operation_items`),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `UPDATE bone_burial_operations SET awarded_xp = 0
         WHERE player_id = 'progression-prayer-recovery'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `DELETE FROM bone_burial_operations
         WHERE player_id = 'progression-prayer-recovery'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query(`TRUNCATE bone_burial_operations`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      pool.query(
        `UPDATE agent_autonomy_lifecycle_events SET lifecycle_state = 'training'
         WHERE character_id = 'progression-lifecycle'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `DELETE FROM agent_autonomy_lifecycle_events
         WHERE character_id = 'progression-lifecycle'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`TRUNCATE agent_autonomy_lifecycle_events`),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `INSERT INTO agent_autonomy_lifecycle_events (
           event_key, character_id, attempt_id, event_source, event_type,
           lifecycle_state, previous_state, previous_goal_type, goal_type,
           action_type, occurred_at
         ) VALUES (
           'b5555555-5555-4555-8555-555555555555:lifecycle:state-start',
           'progression-lifecycle',
           'b5555555-5555-4555-8555-555555555555', 'runtime',
           'state_entered', 'gathering', 'goal_selection', NULL,
           'gathering', 'gather', 12000
         )`,
      ),
    ).rejects.toThrow(/matching progression edge/);

    // Reconstruct the exact pre-0083 shape, write one valid historical
    // preparation receipt, and require the checked-in migration to bind it.
    await pool.query(`DROP VIEW streaming_duel_bank_action_audit`);
    await pool.query(`DROP VIEW streaming_duel_committed_bank_action_audit`);
    await pool.query(
      `DROP TRIGGER agent_bank_operations_validate_preparation_insert
       ON agent_bank_operations`,
    );
    await pool.query(
      `ALTER TABLE agent_bank_operations
         DROP CONSTRAINT "agent_bank_operations_preparationId_preparations_fk",
         DROP CONSTRAINT agent_bank_operations_preparation_identity_check`,
    );
    await pool.query(
      `DROP INDEX idx_agent_bank_operations_preparation_created`,
    );
    await pool.query(
      `ALTER TABLE agent_bank_operations DROP COLUMN "preparationId"`,
    );
    const legacyPreparationId = "e3333333-3333-4333-8333-333333333333";
    const legacyOperationId = "e4444444-4444-4444-8444-444444444444";
    await pool.query(
      `INSERT INTO streaming_duel_preparations (
         "preparationId", "fencingToken", "agent1Id", "agent2Id",
         "allowedBankActions", status, "selectedAt", "expiresAt",
         "cancelledAt", "cancellationReason"
       ) VALUES (
         $1, 1, 'progression-bank-recovery', 'progression-linear',
         ARRAY['open', 'deposit', 'withdraw', 'deposit_all'],
         'cancelled', 1, 2, 2, 'migration_fixture'
       )`,
      [legacyPreparationId],
    );
    await pool.query(
      `INSERT INTO agent_bank_operations (
         "operationId", "playerId", action, "bankId", "itemId",
         "requestedQuantity", "committedQuantity",
         "inventoryQuantityAfter", "bankQuantityAfter",
         "requestFingerprint", "itemCount", "createdAt"
       ) VALUES (
         $1, 'progression-bank-recovery', 'deposit', $2,
         'progression_migration_item', 1, 1, 0, 1, $3, 1, 10000
       )`,
      [
        legacyOperationId,
        `duel-preparation:${legacyPreparationId}`,
        "ef".repeat(32),
      ],
    );

    const before = await pool.query<{
      events: string;
      bank_receipts: string;
      bank_receipt_items: string;
      store_receipts: string;
      bone_receipts: string;
      lifecycle_events: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM agent_autonomy_progression_events) AS events,
         (SELECT count(*)::text FROM agent_bank_operations) AS bank_receipts,
         (SELECT count(*)::text FROM agent_bank_operation_items) AS bank_receipt_items,
         (SELECT count(*)::text FROM agent_store_operations) AS store_receipts,
         (SELECT count(*)::text FROM bone_burial_operations) AS bone_receipts,
         (SELECT count(*)::text FROM agent_autonomy_lifecycle_events) AS lifecycle_events`,
    );
    // Reapply the latest cumulative action-category migration. Historical
    // category migrations are intentionally superseded and cannot admit rows
    // written by later action types on their own.
    for (const migrationName of [
      "0077_add_atomic_composite_bank_withdrawal.sql",
      "0078_add_agent_store_operation_receipts.sql",
      "0083_bind_duel_bank_receipts_to_preparations.sql",
      "0084_add_durable_preparation_bank_open_audit.sql",
    ]) {
      const migration = await readFile(
        path.resolve(
          import.meta.dirname,
          `../../database/migrations/${migrationName}`,
        ),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }
    const after = await pool.query<{
      events: string;
      bank_receipts: string;
      bank_receipt_items: string;
      store_receipts: string;
      bone_receipts: string;
      lifecycle_events: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM agent_autonomy_progression_events) AS events,
         (SELECT count(*)::text FROM agent_bank_operations) AS bank_receipts,
         (SELECT count(*)::text FROM agent_bank_operation_items) AS bank_receipt_items,
         (SELECT count(*)::text FROM agent_store_operations) AS store_receipts,
         (SELECT count(*)::text FROM bone_burial_operations) AS bone_receipts,
         (SELECT count(*)::text FROM agent_autonomy_lifecycle_events) AS lifecycle_events`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    const openOperationId = "e5555555-5555-4555-8555-555555555555";
    await pool.query(
      `INSERT INTO streaming_duel_bank_open_events
         ("operationId", "preparationId", "playerId", "bankId")
       VALUES ($1, $2, 'progression-bank-recovery', $3)`,
      [
        openOperationId,
        legacyPreparationId,
        `duel-preparation:${legacyPreparationId}`,
      ],
    );
    await expect(
      pool.query(
        `UPDATE streaming_duel_bank_open_events SET "createdAt" = 0
         WHERE "operationId" = $1`,
        [openOperationId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `DELETE FROM streaming_duel_bank_open_events
         WHERE "operationId" = $1`,
        [openOperationId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`TRUNCATE streaming_duel_bank_open_events`),
    ).rejects.toThrow(/append-only/);
    const openMigration = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../database/migrations/0084_add_durable_preparation_bank_open_audit.sql",
      ),
      "utf8",
    );
    for (const statement of openMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }

    const migrated = await pool.query<{
      preparation_id: string | null;
      private_columns: string;
      protection_triggers: string;
      open_events: string;
      open_protection_triggers: string;
    }>(
      `SELECT
         (SELECT "preparationId" FROM agent_bank_operations
          WHERE "operationId" = $1) AS preparation_id,
         (SELECT count(*)::text FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'streaming_duel_bank_action_audit'
            AND column_name IN (
              'itemId', 'requestedQuantity', 'committedQuantity',
              'inventoryQuantityAfter', 'bankQuantityAfter', 'itemCount'
            )) AS private_columns,
         (SELECT count(*)::text FROM pg_trigger
          WHERE tgrelid = 'agent_bank_operations'::regclass
            AND tgname IN (
              'agent_bank_operations_reject_mutation',
              'agent_bank_operations_validate_preparation_insert'
            )
            AND NOT tgisinternal) AS protection_triggers,
         (SELECT count(*)::text FROM streaming_duel_bank_open_events
          WHERE "operationId" = $2) AS open_events,
         (SELECT count(*)::text FROM pg_trigger
          WHERE tgrelid = 'streaming_duel_bank_open_events'::regclass
            AND tgname IN (
              'streaming_duel_bank_open_events_validate_insert',
              'streaming_duel_bank_open_events_reject_mutation',
              'streaming_duel_bank_open_events_reject_truncate'
            )
            AND NOT tgisinternal) AS open_protection_triggers`,
      [legacyOperationId, openOperationId],
    );
    expect(migrated.rows[0]).toEqual({
      preparation_id: legacyPreparationId,
      private_columns: "0",
      protection_triggers: "2",
      open_events: "1",
      open_protection_triggers: "3",
    });
  });
});
