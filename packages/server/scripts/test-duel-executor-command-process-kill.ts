import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import type {
  StreamingDuelExecutorCommand,
  StreamingDuelExecutorObservationContext,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import { EmbeddedHyperiaService } from "../src/eliza/EmbeddedHyperiaService.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";
import {
  PostgresStreamingDuelActionObservationStore,
  StreamingDuelActionObservationLedger,
  type StreamingDuelActionObservationPool,
} from "../src/systems/StreamingDuelScheduler/public-action-observation-ledger.js";
import type { StreamingDuelActionObservationDraft } from "../src/systems/StreamingDuelScheduler/public-action-observation-buffer.js";

const CHILD_MODE = "--executor-child";
const CHILD_DATABASE_URL = "DUEL_EXECUTOR_KILL_DATABASE_URL";
const CHILD_CONTEXT = "DUEL_EXECUTOR_KILL_CONTEXT";
const PLAYER_ID = "duel-executor-kill-agent";
const OPPONENT_ID = "duel-executor-kill-opponent";

type ChildContext = {
  observation: StreamingDuelExecutorObservationContext;
  command: StreamingDuelExecutorCommand;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function activateService(
  service: EmbeddedHyperiaService,
  playerId = PLAYER_ID,
): void {
  (service as unknown as { playerEntityId: string }).playerEntityId = playerId;
  (service as unknown as { isActive: boolean }).isActive = true;
}

async function runAuthorityChild(): Promise<never> {
  const databaseUrl = process.env[CHILD_DATABASE_URL]?.trim();
  const encodedContext = process.env[CHILD_CONTEXT];
  assert(databaseUrl, "child database URL is required");
  assert(encodedContext, "child context is required");
  const context = JSON.parse(encodedContext) as ChildContext;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const databaseSystem = new DatabaseSystem({
    drizzleDb: drizzle(pool, { schema }),
    pgPool: pool,
  } as never);
  await databaseSystem.init();
  const entities = new Map<string, { data: Record<string, unknown> }>([
    [PLAYER_ID, { data: {} }],
    [OPPONENT_ID, { data: {} }],
  ]);
  const requestServerMove = () => true;
  const requestServerAttack = () => true;
  const systems = new Map<string, unknown>([
    [
      "database",
      {
        stageStreamingDuelExecutorCommandAsync:
          databaseSystem.stageStreamingDuelExecutorCommandAsync.bind(
            databaseSystem,
          ),
        completeStreamingDuelExecutorCommandAsync: async () => {
          // The movement executor has already returned true. Kill before the
          // outcome/public row transaction starts, leaving only the WAL intent.
          await new Promise<void>((resolve) => {
            process.stdout.write(
              "EXECUTOR_ACCEPTED_BEFORE_COMPLETION\n",
              resolve,
            );
          });
          process.kill(process.pid, "SIGKILL");
          throw new Error("SIGKILL did not terminate the authority child");
        },
      },
    ],
    ["network", { requestServerMove, requestServerAttack }],
  ]);
  const world = {
    entities: { get: (id: string) => entities.get(id) },
    getSystem: (name: string) => systems.get(name) ?? null,
    isServer: true,
    emit: () => undefined,
  };
  const service = new EmbeddedHyperiaService(
    world as never,
    PLAYER_ID,
    "duel-executor-kill-account",
    "Executor Kill Agent",
  );
  activateService(service);
  service.setArenaBounds({ minX: 0, maxX: 20, minZ: 0, maxZ: 20 });
  if (context.command.kind === "engagement") {
    await service.executeDuelAttack(
      context.command.targetId,
      context.observation,
    );
  } else if (context.command.mode === "ground") {
    await service.executeDuelMove(
      [...context.command.target],
      context.command.runMode,
      context.observation,
    );
  } else {
    await service.executeDuelCombatApproach(
      context.command.targetId,
      context.observation,
    );
  }
  throw new Error("SIGKILL did not terminate the authority child");
}

async function waitForChild(
  databaseUrl: string,
  context: ChildContext,
): Promise<{ stdout: string; stderr: string; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, CHILD_MODE], {
      env: {
        ...process.env,
        [CHILD_DATABASE_URL]: databaseUrl,
        [CHILD_CONTEXT]: JSON.stringify(context),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("executor child did not terminate within 30 seconds"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(
          new Error(
            `executor child exited ${code}: ${stderr || stdout || "no output"}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, signal });
    });
  });
}

async function runParent(): Promise<void> {
  const baseDatabaseUrl =
    process.env.DUEL_EXECUTOR_COMMAND_TEST_DATABASE_URL?.trim() ?? "";
  assert(
    baseDatabaseUrl,
    "DUEL_EXECUTOR_COMMAND_TEST_DATABASE_URL is required",
  );
  const databaseName = `hyperia_duel_executor_kill_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const adminPool = new pg.Pool({
    connectionString: adminUrl.toString(),
    max: 2,
  });
  const testUrl = new URL(baseDatabaseUrl);
  testUrl.pathname = `/${databaseName}`;
  let pool: pg.Pool | null = null;
  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    pool = new pg.Pool({
      connectionString: testUrl.toString(),
      max: 8,
      connectionTimeoutMillis: 1_000,
      statement_timeout: 3_000,
      query_timeout: 4_000,
    });
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          import.meta.dirname,
          "../src/database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    const db = drizzle(pool, { schema });
    await db.insert(schema.users).values({
      id: "duel-executor-kill-account",
      name: "Duel Executor Kill Account",
      roles: "user",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    for (const [id, name] of [
      [PLAYER_ID, "Duel Executor Kill Agent"],
      [OPPONENT_ID, "Duel Executor Kill Opponent"],
    ] as const) {
      await db.insert(schema.characters).values({
        id,
        accountId: "duel-executor-kill-account",
        name,
        isAgent: 1,
      });
    }

    const movementContext: ChildContext = {
      observation: {
        operationId: randomUUID(),
        tick: 18,
        observedAt: Date.now(),
        cycleId: "cycle-executor-process-kill",
        duelId: "duel-executor-process-kill",
        actorId: PLAYER_ID,
        opponentId: OPPONENT_ID,
        phase: "FIGHTING",
        combatRole: "ranged",
        tacticalMacro: "kite",
        action: "movement",
        value: "reposition",
      },
      command: {
        kind: "movement",
        mode: "ground",
        target: [10.5, 0, 11.5],
        runMode: true,
      },
    };
    const engagementContext: ChildContext = {
      observation: {
        ...movementContext.observation,
        operationId: randomUUID(),
        tick: 19,
        observedAt: movementContext.observation.observedAt + 1,
        action: "engagement",
        value: "initial",
      },
      command: {
        kind: "engagement",
        targetId: OPPONENT_ID,
        targetType: "player",
      },
    };
    const contexts = [movementContext, engagementContext];
    const childResults = [];
    for (const context of contexts) {
      const childResult = await waitForChild(testUrl.toString(), context);
      assert(
        childResult.stdout.includes("EXECUTOR_ACCEPTED_BEFORE_COMPLETION"),
        `executor marker missing: ${childResult.stderr}`,
      );
      assert(
        childResult.signal === "SIGKILL",
        `executor child was not killed at the requested boundary (${String(childResult.signal)})`,
      );
      childResults.push(childResult);
    }

    const pendingRows = await pool.query<{
      pendingRows: number;
      observationRows: number;
    }>(
      `SELECT
         (SELECT count(*) FROM operations_log
           WHERE id = ANY($1::text[]) AND completed = false)::int AS "pendingRows",
         (SELECT count(*) FROM streaming_duel_action_observations
           WHERE "operationId" = ANY($1::text[]))::int AS "observationRows"`,
      [contexts.map(({ observation }) => observation.operationId)],
    );
    assert(
      pendingRows.rows[0]?.pendingRows === 2,
      "both write-ahead commands were not retained pending",
    );
    assert(
      pendingRows.rows[0]?.observationRows === 0,
      "public outcome appeared before durable completion",
    );

    const replacementDatabase = new DatabaseSystem({
      drizzleDb: db,
      pgPool: pool,
    } as never);
    await replacementDatabase.init();
    let replacementMovementExecutions = 0;
    let replacementEngagementExecutions = 0;
    const entities = new Map<string, { data: Record<string, unknown> }>([
      [PLAYER_ID, { data: {} }],
      [OPPONENT_ID, { data: {} }],
    ]);
    const systems = new Map<string, unknown>([
      ["database", replacementDatabase],
      [
        "network",
        {
          requestServerMove: () => {
            replacementMovementExecutions++;
            return true;
          },
          requestServerAttack: () => {
            replacementEngagementExecutions++;
            return true;
          },
        },
      ],
    ]);
    const world = {
      entities: { get: (id: string) => entities.get(id) },
      getSystem: (name: string) => systems.get(name) ?? null,
      isServer: true,
      emit: () => undefined,
    };
    const replacementService = new EmbeddedHyperiaService(
      world as never,
      PLAYER_ID,
      "duel-executor-kill-account",
      "Executor Kill Agent",
    );
    activateService(replacementService);
    replacementService.setArenaBounds({
      minX: 0,
      maxX: 20,
      minZ: 0,
      maxZ: 20,
    });
    const pending =
      await replacementDatabase.listPendingStreamingDuelExecutorCommandsAsync(
        movementContext.observation.cycleId,
      );
    assert(
      pending.length === 2,
      "replacement did not load both pending commands",
    );
    for (const command of pending) {
      const recoveredReceipt =
        await replacementService.recoverStreamingDuelExecutorCommand(command);
      assert(
        recoveredReceipt.completed && recoveredReceipt.outcome === "accepted",
        "replacement did not complete an accepted executor command",
      );
    }
    assert(
      replacementMovementExecutions === 1 &&
        replacementEngagementExecutions === 1,
      "replacement did not execute each exact command once",
    );

    const durableRows = await pool.query<{
      completedRows: number;
      observationRows: number;
    }>(
      `SELECT
         (SELECT count(*) FROM operations_log
           WHERE id = ANY($1::text[]) AND completed = true)::int AS "completedRows",
         (SELECT count(*) FROM streaming_duel_action_observations
           WHERE "operationId" = ANY($1::text[]))::int AS "observationRows"`,
      [contexts.map(({ observation }) => observation.operationId)],
    );
    assert(
      durableRows.rows[0]?.completedRows === 2,
      "replacement receipts are incomplete",
    );
    assert(
      durableRows.rows[0]?.observationRows === 2,
      "replacement public observations are not exact-once",
    );

    const store = new PostgresStreamingDuelActionObservationStore(
      pool as unknown as StreamingDuelActionObservationPool,
    );
    const ledger = new StreamingDuelActionObservationLedger(store, {
      retryDelay: async () => {},
    });
    ledger.activateCycle(movementContext.observation.cycleId);
    await ledger.waitForIdle();
    const recovered = ledger.getSnapshot(movementContext.observation.cycleId);
    assert(recovered.length === 2, "ledger did not hydrate two recovered rows");
    assert(
      recovered[0]?.action === "movement" &&
        recovered[0]?.outcome === "accepted" &&
        recovered[1]?.action === "engagement" &&
        recovered[1]?.outcome === "accepted",
      "ledger recovered the wrong executor outcomes",
    );
    const draft = {
      tick: movementContext.observation.tick,
      cycleId: movementContext.observation.cycleId,
      duelId: movementContext.observation.duelId,
      actorId: movementContext.observation.actorId,
      opponentId: movementContext.observation.opponentId,
      phase: movementContext.observation.phase,
      combatRole: movementContext.observation.combatRole,
      tacticalMacro: movementContext.observation.tacticalMacro,
      action: "movement",
      outcome: "accepted",
      value: "reposition",
      amount: null,
    } satisfies StreamingDuelActionObservationDraft;
    assert(
      ledger.record(draft, {
        operationId: movementContext.observation.operationId,
        observedAt: movementContext.observation.observedAt,
      }),
      "delayed controller callback was rejected",
    );
    await ledger.waitForIdle();
    const replayRows = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM streaming_duel_action_observations
       WHERE "operationId" = ANY($1::text[])`,
      [contexts.map(({ observation }) => observation.operationId)],
    );
    assert(
      replayRows.rows[0]?.count === 2,
      "delayed callback duplicated a row",
    );

    console.log(
      JSON.stringify({
        status: "passed",
        boundary:
          "executor_acceptance_after_wal_before_outcome_commit_process_kill",
        signals: childResults.map(({ signal }) => signal),
        pendingBeforeRecovery: pendingRows.rows[0].pendingRows,
        observationRowsBeforeRecovery: pendingRows.rows[0].observationRows,
        replacementMovementExecutions,
        replacementEngagementExecutions,
        operationsCompleted: durableRows.rows[0].completedRows,
        observationRows: replayRows.rows[0].count,
        recoveredActions: recovered.map(({ action }) => action),
        recoveredOutcomes: recovered.map(({ outcome }) => outcome),
        recoveredSequences: recovered.map(({ sequence }) => sequence),
        ledgerHealth: ledger.getHealth(),
      }),
    );
  } finally {
    await pool?.end();
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  }
}

if (process.argv[2] === CHILD_MODE) {
  await runAuthorityChild();
} else {
  await runParent();
}
