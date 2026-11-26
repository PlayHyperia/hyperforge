import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import { QuestRepository } from "../../../database/repositories/QuestRepository.js";
import * as schema from "../../../database/schema.js";
import type { GatheringRewardCommitRequest } from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;
const RESOURCE_ID = "ore_durable_contention_10_20";

function requestFor(
  operationId: string,
  playerId: string,
  overrides: Partial<GatheringRewardCommitRequest> = {},
): GatheringRewardCommitRequest {
  const input = {
    playerId,
    resourceId: RESOURCE_ID,
    depleteAfterCommit: true,
    respawnTicks: 10,
    skill: "mining" as const,
    xpAmount: 18,
    reward: { itemId: "copper_ore", quantity: 1, stackable: false },
    secondaryItemId: null,
    ...overrides,
  };
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        playerId: input.playerId,
        resourceId: input.resourceId,
        depleteAfterCommit: input.depleteAfterCommit,
        respawnTicks: input.respawnTicks,
        skill: input.skill,
        xpAmount: input.xpAmount,
        reward: input.reward,
        secondaryItemId: input.secondaryItemId,
      }),
      "utf8",
    )
    .digest("hex");
  return { operationId, requestFingerprint, ...input };
}

describeDatabase("durable gathering resource state", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseSystem: DatabaseSystem;
  let questRepository: QuestRepository;

  beforeAll(async () => {
    databaseName = `hyperia_gathering_state_${process.pid}_${Date.now().toString(36)}`;
    const adminUrl = new URL(baseDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 2 });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);

    const testUrl = new URL(baseDatabaseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 32 });
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
      id: "gathering-state-account",
      name: "Gathering State Account",
      roles: "user",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    await db.insert(schema.characters).values(
      Array.from({ length: 25 }, (_, index) => ({
        id: `gathering-state-agent-${index.toString().padStart(2, "0")}`,
        accountId: "gathering-state-account",
        name: `Gathering State Agent ${index}`,
        isAgent: 1,
      })),
    );
    await db.insert(schema.questProgress).values(
      Array.from({ length: 25 }, (_, index) => ({
        playerId: `gathering-state-agent-${index.toString().padStart(2, "0")}`,
        questId: "durable_gathering_quest",
        status: "in_progress",
        currentStage: "chop_logs",
        stageProgress: {},
        startedAt: 1_786_388_400_000,
      })),
    );
    databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    questRepository = new QuestRepository(db, pool);
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

  it("admits one cross-process-equivalent winner and hydrates its deadline", async () => {
    const requests = Array.from({ length: 25 }, (_, index) =>
      requestFor(
        randomUUID(),
        `gathering-state-agent-${index.toString().padStart(2, "0")}`,
      ),
    );
    const results = await Promise.allSettled(
      requests.map((request) =>
        databaseSystem.commitGatheringRewardOperationAsync(request),
      ),
    );
    const committed = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<
          ReturnType<DatabaseSystem["commitGatheringRewardOperationAsync"]>
        >
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(committed).toHaveLength(1);
    expect(rejected).toHaveLength(24);
    expect(
      rejected.every((result) =>
        String(result.reason).includes("gathering_reward_resource_unavailable"),
      ),
    ).toBe(true);

    const winner = committed[0].value;
    expect(winner.replayed).toBe(false);
    expect(winner.depletedUntil).toBeGreaterThan(Date.now());
    await expect(
      databaseSystem.commitGatheringRewardOperationAsync(
        requests.find((request) => request.operationId === winner.operationId)!,
      ),
    ).resolves.toMatchObject({
      operationId: winner.operationId,
      replayed: true,
      depletedUntil: winner.depletedUntil,
    });

    await expect(
      databaseSystem.getGatheringResourceStatesAsync([RESOURCE_ID]),
    ).resolves.toEqual([
      {
        resourceId: RESOURCE_ID,
        operationId: winner.operationId,
        depletedAt: expect.any(Number),
        respawnAt: winner.depletedUntil,
      },
    ]);

    const custody = await pool.query<{
      rewarded_players: string;
      receipt_count: string;
      state_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM characters WHERE "miningXp" = 18) AS rewarded_players,
         (SELECT count(*)::text FROM operations_log WHERE "operationType" = 'gathering_reward') AS receipt_count,
         (SELECT count(*)::text FROM gathering_resource_states WHERE resource_id = $1) AS state_count`,
      [RESOURCE_ID],
    );
    expect(custody.rows[0]).toEqual({
      rewarded_players: "1",
      receipt_count: "1",
      state_count: "1",
    });

    const pendingQuestReceipts =
      await questRepository.getPendingGatheringProgressReceipts(
        winner.playerId,
      );
    expect(pendingQuestReceipts).toEqual([
      {
        operationId: winner.operationId,
        playerId: winner.playerId,
        questId: "durable_gathering_quest",
        questStartedAt: 1_786_388_400_000,
        capturedStage: "chop_logs",
        rewardItemId: "copper_ore",
        rewardQuantity: 1,
        createdAt: expect.any(Number),
      },
    ]);
    const progressRequest = {
      ...pendingQuestReceipts[0],
      expectedCurrentStage: "chop_logs",
      expectedProgress: {},
      resultingStage: "chop_logs",
      resultingProgress: { copper_ore: 1 },
    };
    await expect(
      questRepository.applyGatheringProgressReceipt(progressRequest),
    ).resolves.toEqual({
      status: "applied",
      currentStage: "chop_logs",
      stageProgress: { copper_ore: 1 },
    });
    await expect(
      questRepository.applyGatheringProgressReceipt(progressRequest),
    ).resolves.toEqual({
      status: "replayed",
      currentStage: "chop_logs",
      stageProgress: { copper_ore: 1 },
    });
    await expect(
      questRepository.getPendingGatheringProgressReceipts(winner.playerId),
    ).resolves.toEqual([]);
    const questCustody = await pool.query<{
      progress: { copper_ore: number };
      resolution: string;
      audit_count: string;
    }>(
      `SELECT qp."stageProgress" AS progress, qgpr.resolution,
              (SELECT count(*)::text FROM quest_audit_log qal
               WHERE qal."playerId" = qp."playerId"
                 AND qal."questId" = qp."questId"
                 AND qal.action = 'progressed') AS audit_count
       FROM quest_progress qp
       JOIN quest_gathering_progress_receipts qgpr
         ON qgpr.player_id = qp."playerId" AND qgpr.quest_id = qp."questId"
       WHERE qgpr.operation_id = $1`,
      [winner.operationId],
    );
    expect(questCustody.rows).toEqual([
      {
        progress: { copper_ore: 1 },
        resolution: "applied",
        audit_count: "1",
      },
    ]);

    const concurrentEdge =
      await databaseSystem.commitGatheringRewardOperationAsync(
        requestFor(randomUUID(), winner.playerId, {
          resourceId: "tree-stale-quest-progress",
          depleteAfterCommit: false,
          respawnTicks: 0,
          skill: "woodcutting",
          xpAmount: 10,
        }),
      );
    const concurrentReceipt = (
      await questRepository.getPendingGatheringProgressReceipts(winner.playerId)
    ).find((receipt) => receipt.operationId === concurrentEdge.operationId)!;
    await expect(
      questRepository.applyGatheringProgressReceipt({
        ...concurrentReceipt,
        expectedCurrentStage: "chop_logs",
        expectedProgress: {},
        resultingStage: "chop_logs",
        resultingProgress: { copper_ore: 1 },
      }),
    ).resolves.toEqual({
      status: "stale",
      currentStage: "chop_logs",
      stageProgress: { copper_ore: 1 },
    });
    await expect(
      questRepository.applyGatheringProgressReceipt({
        ...concurrentReceipt,
        expectedCurrentStage: "chop_logs",
        expectedProgress: { copper_ore: 1 },
        resultingStage: "chop_logs",
        resultingProgress: { copper_ore: 2 },
      }),
    ).resolves.toEqual({
      status: "applied",
      currentStage: "chop_logs",
      stageProgress: { copper_ore: 2 },
    });

    await pool.query(
      `UPDATE gathering_resource_states SET respawn_at = depleted_at + 1
       WHERE resource_id = $1`,
      [RESOURCE_ID],
    );
    await expect(
      databaseSystem.getGatheringResourceStatesAsync([RESOURCE_ID]),
    ).resolves.toEqual([]);

    const nextPlayer = requests.find(
      (request) => request.playerId !== winner.playerId,
    )!.playerId;
    const next = await databaseSystem.commitGatheringRewardOperationAsync(
      requestFor(randomUUID(), nextPlayer),
    );
    expect(next).toMatchObject({
      replayed: false,
      resourceId: RESOURCE_ID,
      depletedUntil: expect.any(Number),
    });
    const afterRespawn = await pool.query<{
      rewarded_players: string;
      receipt_count: string;
      operation_id: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM characters WHERE "miningXp" = 18) AS rewarded_players,
         (SELECT count(*)::text FROM operations_log WHERE "operationType" = 'gathering_reward') AS receipt_count,
         operation_id
       FROM gathering_resource_states WHERE resource_id = $1`,
      [RESOURCE_ID],
    );
    expect(afterRespawn.rows[0]).toEqual({
      rewarded_players: "2",
      receipt_count: "3",
      operation_id: next.operationId,
    });

    const superseded =
      await questRepository.getPendingGatheringProgressReceipts(nextPlayer);
    expect(superseded).toHaveLength(1);
    await questRepository.completeQuest(nextPlayer, "durable_gathering_quest");
    await expect(
      questRepository.retireGatheringProgressReceipt(superseded[0]),
    ).resolves.toBe("retired");
    await expect(
      questRepository.retireGatheringProgressReceipt(superseded[0]),
    ).resolves.toBe("already_resolved");
    await expect(
      questRepository.getPendingGatheringProgressReceipts(nextPlayer),
    ).resolves.toEqual([]);
  });

  it("does not capture a reward committed before any quest incarnation exists", async () => {
    const playerId = "gathering-state-no-quest-agent";
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent")
       VALUES ($1, 'gathering-state-account', 'No Quest Agent', 1)`,
      [playerId],
    );
    const request = requestFor(randomUUID(), playerId, {
      resourceId: "tree-no-quest-capture",
      depleteAfterCommit: false,
      respawnTicks: 0,
      skill: "woodcutting",
      xpAmount: 10,
      reward: { itemId: "logs", quantity: 1, stackable: false },
    });
    await expect(
      databaseSystem.commitGatheringRewardOperationAsync(request),
    ).resolves.toMatchObject({ operationId: request.operationId });

    const counts = await pool.query<{
      operation_count: string;
      quest_receipt_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM operations_log WHERE id = $1) AS operation_count,
         (SELECT count(*)::text FROM quest_gathering_progress_receipts
          WHERE operation_id = $1) AS quest_receipt_count`,
      [request.operationId],
    );
    expect(counts.rows[0]).toEqual({
      operation_count: "1",
      quest_receipt_count: "0",
    });
  });
});
