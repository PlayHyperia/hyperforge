import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type {
  StreamingDuelExecutorCommand,
  StreamingDuelExecutorCommandRequest,
  StreamingDuelExecutorObservationContext,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import * as schema from "../../../database/schema.js";
import {
  PostgresStreamingDuelActionObservationStore,
  StreamingDuelActionObservationLedger,
  type StreamingDuelActionObservationPool,
} from "../../StreamingDuelScheduler/public-action-observation-ledger.js";
import type { StreamingDuelActionObservationDraft } from "../../StreamingDuelScheduler/public-action-observation-buffer.js";
import { DatabaseSystem } from "../index.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;

function fingerprint(
  playerId: string,
  publicActionObservation: StreamingDuelExecutorObservationContext,
  command: StreamingDuelExecutorCommand,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId,
        publicActionObservation,
        command,
      }),
      "utf8",
    )
    .digest("hex");
}

describeDatabase("streaming-duel executor command custody", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseSystem: DatabaseSystem;
  const playerId = "executor-command-agent";
  const opponentId = "executor-command-opponent";

  beforeAll(async () => {
    databaseName = `hyperia_executor_${process.pid}_${Date.now().toString(36)}`;
    const adminUrl = new URL(baseDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 2 });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);

    const testUrl = new URL(baseDatabaseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({
      connectionString: testUrl.toString(),
      max: 8,
      connectionTimeoutMillis: 1_000,
      statement_timeout: 2_000,
      query_timeout: 3_000,
    });
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          import.meta.dirname,
          "../../../database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }

    const db = drizzle(pool, { schema });
    await db.insert(schema.users).values({
      id: "executor-command-account",
      name: "Executor Command Account",
      roles: "user",
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    for (const [id, name] of [
      [playerId, "Executor Command Agent"],
      [opponentId, "Executor Command Opponent"],
    ] as const) {
      await db.insert(schema.characters).values({
        id,
        accountId: "executor-command-account",
        name,
        isAgent: 1,
      });
    }
    databaseSystem = new DatabaseSystem({
      drizzleDb: db,
      pgPool: pool,
    } as never);
    await databaseSystem.init();
  }, 30_000);

  afterAll(async () => {
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

  const context = (
    operationId: string,
    tick: number,
    action: "movement" | "engagement",
    value: "reposition" | "initial" | "keep_alive",
  ): StreamingDuelExecutorObservationContext =>
    Object.freeze({
      operationId,
      tick,
      observedAt: 1_800_000_100_000 + tick,
      cycleId: "cycle-executor-atomic",
      duelId: "duel-executor-atomic",
      actorId: playerId,
      opponentId,
      phase: "FIGHTING",
      combatRole: "ranged",
      tacticalMacro: "kite",
      action,
      value,
    }) as StreamingDuelExecutorObservationContext;

  const request = (
    publicActionObservation: StreamingDuelExecutorObservationContext,
    command: StreamingDuelExecutorCommand,
  ): StreamingDuelExecutorCommandRequest => ({
    operationId: publicActionObservation.operationId,
    playerId,
    publicActionObservation,
    command,
    requestFingerprint: fingerprint(playerId, publicActionObservation, command),
  });

  it("stages before execution, co-commits outcomes, and recovers exact pending order", async () => {
    const movementContext = context(randomUUID(), 1, "movement", "reposition");
    const movementCommand = Object.freeze({
      kind: "movement",
      mode: "ground",
      target: Object.freeze([351.5, 0, 406.5] as const),
      runMode: true,
    }) satisfies StreamingDuelExecutorCommand;
    const movementRequest = request(movementContext, movementCommand);

    await expect(
      databaseSystem.stageStreamingDuelExecutorCommandAsync(movementRequest),
    ).resolves.toMatchObject({
      replayed: false,
      completed: false,
      outcome: null,
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM operations_log WHERE id = $1 AND completed = false) AS pending_rows,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "operationId" = $1) AS observation_rows`,
        [movementRequest.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ pending_rows: 1, observation_rows: 0 }],
    });

    const replacement = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await replacement.init();
    await expect(
      replacement.listPendingStreamingDuelExecutorCommandsAsync(
        movementContext.cycleId,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        operationId: movementRequest.operationId,
        completed: false,
        outcome: null,
        command: movementCommand,
      }),
    ]);

    await expect(
      replacement.completeStreamingDuelExecutorCommandAsync({
        ...movementRequest,
        outcome: "accepted",
      }),
    ).resolves.toMatchObject({
      replayed: false,
      completed: true,
      outcome: "accepted",
    });
    await expect(
      replacement.stageStreamingDuelExecutorCommandAsync(movementRequest),
    ).resolves.toMatchObject({
      replayed: true,
      completed: true,
      outcome: "accepted",
    });
    await expect(
      replacement.completeStreamingDuelExecutorCommandAsync({
        ...movementRequest,
        outcome: "accepted",
      }),
    ).resolves.toMatchObject({
      replayed: true,
      completed: true,
      outcome: "accepted",
    });

    const engagementContext = context(randomUUID(), 2, "engagement", "initial");
    const engagementCommand = Object.freeze({
      kind: "engagement",
      targetId: opponentId,
      targetType: "player",
    }) satisfies StreamingDuelExecutorCommand;
    const engagementRequest = request(engagementContext, engagementCommand);
    await replacement.stageStreamingDuelExecutorCommandAsync(engagementRequest);
    await expect(
      replacement.completeStreamingDuelExecutorCommandAsync({
        ...engagementRequest,
        outcome: "rejected",
      }),
    ).resolves.toMatchObject({ outcome: "rejected" });

    const pendingAContext = context(
      "00000000-0000-4000-8000-0000000000a1",
      3,
      "engagement",
      "keep_alive",
    );
    const pendingBContext = context(
      "00000000-0000-4000-8000-0000000000a2",
      4,
      "movement",
      "reposition",
    );
    const pendingA = request(pendingAContext, engagementCommand);
    const pendingB = request(pendingBContext, {
      kind: "movement",
      mode: "combat_approach",
      targetId: opponentId,
      targetType: "player",
    });
    await replacement.stageStreamingDuelExecutorCommandAsync(pendingA);
    await replacement.stageStreamingDuelExecutorCommandAsync(pendingB);
    await expect(
      replacement.listPendingStreamingDuelExecutorCommandsAsync(
        movementContext.cycleId,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ operationId: pendingA.operationId }),
      expect.objectContaining({ operationId: pendingB.operationId }),
    ]);
    await replacement.completeStreamingDuelExecutorCommandAsync({
      ...pendingA,
      outcome: "accepted",
    });
    await replacement.completeStreamingDuelExecutorCommandAsync({
      ...pendingB,
      outcome: "accepted",
    });

    const store = new PostgresStreamingDuelActionObservationStore(
      pool as unknown as StreamingDuelActionObservationPool,
    );
    const ledger = new StreamingDuelActionObservationLedger(store, {
      retryDelay: async () => {},
    });
    ledger.activateCycle(movementContext.cycleId);
    await ledger.waitForIdle();
    expect(ledger.getSnapshot(movementContext.cycleId)).toEqual([
      expect.objectContaining({
        sequence: 1,
        action: "movement",
        outcome: "accepted",
      }),
      expect.objectContaining({
        sequence: 2,
        action: "engagement",
        outcome: "rejected",
      }),
      expect.objectContaining({ sequence: 3, action: "engagement" }),
      expect.objectContaining({ sequence: 4, action: "movement" }),
    ]);
    const delayedDraft = {
      tick: movementContext.tick,
      cycleId: movementContext.cycleId,
      duelId: movementContext.duelId,
      actorId: movementContext.actorId,
      opponentId: movementContext.opponentId,
      phase: movementContext.phase,
      combatRole: movementContext.combatRole,
      tacticalMacro: movementContext.tacticalMacro,
      action: "movement",
      outcome: "accepted",
      value: "reposition",
      amount: null,
    } satisfies StreamingDuelActionObservationDraft;
    expect(
      ledger.record(delayedDraft, {
        operationId: movementContext.operationId,
        observedAt: movementContext.observedAt,
      }),
    ).toBe(true);
    await ledger.waitForIdle();
    expect(ledger.getSnapshot(movementContext.cycleId)).toHaveLength(4);

    const missingContext = context(randomUUID(), 5, "engagement", "keep_alive");
    const missingRequest = request(missingContext, engagementCommand);
    await pool.query(
      `INSERT INTO operations_log (
         id, "playerId", "operationType", "operationState", completed,
         timestamp, "completedAt"
       ) VALUES ($1, $2, 'streaming_duel_executor_command', $3::jsonb, true, $4, $4)`,
      [
        missingRequest.operationId,
        playerId,
        JSON.stringify({
          version: 1,
          requestFingerprint: missingRequest.requestFingerprint,
          publicActionObservation: missingContext,
          command: engagementCommand,
          outcome: "accepted",
        }),
        Date.now(),
      ],
    );
    await expect(
      replacement.stageStreamingDuelExecutorCommandAsync(missingRequest),
    ).rejects.toThrow("streaming_duel_public_observation_conflict");
  });

  it("allocates a gap-free public sequence when both contestants complete commands concurrently", async () => {
    const authorityA = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    const authorityB = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await Promise.all([authorityA.init(), authorityB.init()]);
    const cycleId = "cycle-executor-concurrent";
    const duelId = "duel-executor-concurrent";
    const requests: StreamingDuelExecutorCommandRequest[] = [];

    for (let index = 0; index < 16; index += 1) {
      const buildRequest = (
        actorId: string,
        targetId: string,
        tick: number,
      ): StreamingDuelExecutorCommandRequest => {
        const publicActionObservation = Object.freeze({
          operationId: randomUUID(),
          tick,
          observedAt: 1_800_000_200_000 + tick,
          cycleId,
          duelId,
          actorId,
          opponentId: targetId,
          phase: "FIGHTING",
          combatRole: "ranged",
          tacticalMacro: "orbit",
          action: "engagement",
          value: "keep_alive",
        }) as StreamingDuelExecutorObservationContext;
        const command = Object.freeze({
          kind: "engagement",
          targetId,
          targetType: "player",
        }) satisfies StreamingDuelExecutorCommand;
        return {
          operationId: publicActionObservation.operationId,
          playerId: actorId,
          publicActionObservation,
          command,
          requestFingerprint: fingerprint(
            actorId,
            publicActionObservation,
            command,
          ),
        };
      };
      const requestA = buildRequest(playerId, opponentId, index * 2 + 1);
      const requestB = buildRequest(opponentId, playerId, index * 2 + 2);
      requests.push(requestA, requestB);
      await Promise.all([
        authorityA.stageStreamingDuelExecutorCommandAsync(requestA),
        authorityB.stageStreamingDuelExecutorCommandAsync(requestB),
      ]);
      await expect(
        Promise.all([
          authorityA.completeStreamingDuelExecutorCommandAsync({
            ...requestA,
            outcome: "accepted",
          }),
          authorityB.completeStreamingDuelExecutorCommandAsync({
            ...requestB,
            outcome: "accepted",
          }),
        ]),
      ).resolves.toEqual([
        expect.objectContaining({ completed: true, outcome: "accepted" }),
        expect.objectContaining({ completed: true, outcome: "accepted" }),
      ]);
    }

    await expect(
      pool.query(
        `SELECT
           count(*)::int AS observation_count,
           count(DISTINCT sequence)::int AS distinct_sequences,
           min(sequence)::int AS min_sequence,
           max(sequence)::int AS max_sequence,
           (SELECT "lastSequence" FROM streaming_duel_action_observation_heads
             WHERE "cycleId" = $1) AS last_sequence,
           (SELECT count(*)::int FROM operations_log
             WHERE id = ANY($2::text[]) AND completed = false) AS pending_operations
         FROM streaming_duel_action_observations
         WHERE "cycleId" = $1`,
        [cycleId, requests.map((entry) => entry.operationId)],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          observation_count: 32,
          distinct_sequences: 32,
          min_sequence: 1,
          max_sequence: 32,
          last_sequence: 32,
          pending_operations: 0,
        },
      ],
    });
  });
});
