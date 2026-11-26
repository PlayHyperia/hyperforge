import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import { QuestRepository } from "../../../database/repositories/QuestRepository.js";
import * as schema from "../../../database/schema.js";
import type { ProcessingActionCommitRequest } from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;
const QUEST_STARTED_AT = 1_786_392_000_000;

type RequestInput = Omit<
  ProcessingActionCommitRequest,
  "operationId" | "requestFingerprint"
>;

type ProcessingFamilyCase = {
  family: string;
  targetId: string;
  quantity: number;
  coins?: number;
  inventory: Array<{ itemId: string; quantity: number }>;
  request: Omit<RequestInput, "playerId">;
};

function fingerprint(input: RequestInput): string {
  const payload: Record<string, unknown> = {
    version: 1,
    playerId: input.playerId,
    skill: input.skill,
    xpAmount: input.xpAmount,
    inputs: input.inputs,
    outputs: input.outputs,
  };
  if (input.requiredItems.length > 0) {
    payload.requiredItems = input.requiredItems;
  }
  if (input.consumables.length > 0) payload.consumables = input.consumables;
  if ((input.coinCost ?? 0) > 0) payload.coinCost = input.coinCost;
  if (input.worldEffect) payload.worldEffect = input.worldEffect;
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function requestFor(
  operationId: string,
  input: RequestInput,
): ProcessingActionCommitRequest {
  return { operationId, requestFingerprint: fingerprint(input), ...input };
}

const processingFamilies: ProcessingFamilyCase[] = [
  {
    family: "firemaking",
    targetId: "fire",
    quantity: 1,
    inventory: [
      { itemId: "logs", quantity: 1 },
      { itemId: "tinderbox", quantity: 1 },
    ],
    request: {
      skill: "firemaking",
      xpAmount: 40,
      inputs: [{ itemId: "logs", quantity: 1 }],
      requiredItems: [{ itemId: "tinderbox", quantity: 1 }],
      consumables: [],
      outputs: [],
      worldEffect: {
        kind: "fire",
        fireId: "fire_quest-progress-family",
        position: { x: 100.5, y: 0, z: 100.5 },
        tile: { x: 100, z: 100 },
        durationMs: 60_000,
      },
    },
  },
  {
    family: "cooking",
    targetId: "shrimp",
    quantity: 1,
    inventory: [{ itemId: "raw_shrimp", quantity: 2 }],
    request: {
      skill: "cooking",
      xpAmount: 30,
      inputs: [{ itemId: "raw_shrimp", quantity: 1 }],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: "shrimp", quantity: 1, stackable: false }],
    },
  },
  {
    family: "smelting",
    targetId: "iron_bar",
    quantity: 1,
    inventory: [{ itemId: "iron_ore", quantity: 1 }],
    request: {
      skill: "smithing",
      xpAmount: 12.5,
      inputs: [{ itemId: "iron_ore", quantity: 1 }],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: "iron_bar", quantity: 1, stackable: false }],
    },
  },
  {
    family: "smithing",
    targetId: "bronze_sword",
    quantity: 1,
    inventory: [
      { itemId: "bronze_bar", quantity: 2 },
      { itemId: "hammer", quantity: 1 },
    ],
    request: {
      skill: "smithing",
      xpAmount: 25,
      inputs: [{ itemId: "bronze_bar", quantity: 2 }],
      requiredItems: [{ itemId: "hammer", quantity: 1 }],
      consumables: [],
      outputs: [{ itemId: "bronze_sword", quantity: 1, stackable: false }],
    },
  },
  {
    family: "crafting",
    targetId: "leather_gloves",
    quantity: 1,
    inventory: [
      { itemId: "leather", quantity: 1 },
      { itemId: "needle", quantity: 1 },
    ],
    request: {
      skill: "crafting",
      xpAmount: 13.8,
      inputs: [{ itemId: "leather", quantity: 1 }],
      requiredItems: [{ itemId: "needle", quantity: 1 }],
      consumables: [],
      outputs: [{ itemId: "leather_gloves", quantity: 1, stackable: false }],
    },
  },
  {
    family: "fletching",
    targetId: "arrow_shaft",
    quantity: 15,
    inventory: [
      { itemId: "logs", quantity: 1 },
      { itemId: "knife", quantity: 1 },
    ],
    request: {
      skill: "fletching",
      xpAmount: 5,
      inputs: [{ itemId: "logs", quantity: 1 }],
      requiredItems: [{ itemId: "knife", quantity: 1 }],
      consumables: [],
      outputs: [{ itemId: "arrow_shaft", quantity: 15, stackable: true }],
    },
  },
  {
    family: "runecrafting",
    targetId: "air_rune",
    quantity: 5,
    inventory: [{ itemId: "rune_essence", quantity: 1 }],
    request: {
      skill: "runecrafting",
      xpAmount: 5,
      inputs: [{ itemId: "rune_essence", quantity: 1 }],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: "air_rune", quantity: 5, stackable: true }],
    },
  },
  {
    family: "tanning",
    targetId: "leather",
    quantity: 2,
    coins: 5,
    inventory: [{ itemId: "cowhide", quantity: 2 }],
    request: {
      skill: "crafting",
      xpAmount: 0,
      inputs: [{ itemId: "cowhide", quantity: 2 }],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: "leather", quantity: 2, stackable: false }],
      coinCost: 2,
    },
  },
];

describeDatabase("durable processing quest progress", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseSystem: DatabaseSystem;
  let questRepository: QuestRepository;
  const operations = new Map<string, string>();

  beforeAll(async () => {
    databaseName = `hyperia_processing_quest_${process.pid}_${Date.now().toString(36)}`;
    const adminUrl = new URL(baseDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 2 });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);

    const testUrl = new URL(baseDatabaseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 16 });
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
      id: "processing-quest-account",
      name: "Processing Quest Account",
      roles: "user",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    questRepository = new QuestRepository(db, pool);

    for (const familyCase of processingFamilies) {
      const playerId = `processing-quest-${familyCase.family}`;
      await db.insert(schema.characters).values({
        id: playerId,
        accountId: "processing-quest-account",
        name: `Processing Quest ${familyCase.family}`,
        isAgent: 1,
        coins: familyCase.coins ?? 0,
      });
      await db.insert(schema.questProgress).values({
        playerId,
        questId: `durable_processing_${familyCase.family}`,
        status: "in_progress",
        currentStage: `process_${familyCase.targetId}`,
        stageProgress: {},
        startedAt: QUEST_STARTED_AT,
      });
      await db.insert(schema.inventory).values(
        familyCase.inventory.map((item, slotIndex) => ({
          playerId,
          itemId: item.itemId,
          quantity: item.quantity,
          slotIndex,
        })),
      );
      const operationId = `processing-family:${familyCase.family}:${randomUUID()}`;
      operations.set(familyCase.family, operationId);
      await databaseSystem.commitProcessingActionOperationAsync(
        requestFor(operationId, { playerId, ...familyCase.request }),
      );
    }
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

  it("captures every production processing family inside the custody transaction", async () => {
    for (const familyCase of processingFamilies) {
      const playerId = `processing-quest-${familyCase.family}`;
      const operationId = operations.get(familyCase.family)!;
      await expect(
        questRepository.getPendingProcessingProgressReceipts(playerId),
      ).resolves.toEqual([
        {
          operationId,
          playerId,
          questId: `durable_processing_${familyCase.family}`,
          questStartedAt: QUEST_STARTED_AT,
          capturedStage: `process_${familyCase.targetId}`,
          targetId: familyCase.targetId,
          quantity: familyCase.quantity,
          createdAt: expect.any(Number),
        },
      ]);

      await databaseSystem.commitProcessingActionOperationAsync(
        requestFor(operationId, { playerId, ...familyCase.request }),
      );
      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM quest_processing_progress_receipts WHERE operation_id = $1`,
        [operationId],
      );
      expect(count.rows[0]?.count).toBe("1");
    }
  });

  it("applies, replays, and stale-retries an exact committed target once", async () => {
    const playerId = "processing-quest-cooking";
    const first = (
      await questRepository.getPendingProcessingProgressReceipts(playerId)
    )[0];
    const firstRequest = {
      ...first,
      expectedCurrentStage: "process_shrimp",
      expectedProgress: {},
      resultingStage: "process_shrimp",
      resultingProgress: { shrimp: 1 },
    };
    await expect(
      questRepository.applyProcessingProgressReceipt(firstRequest),
    ).resolves.toEqual({
      status: "applied",
      currentStage: "process_shrimp",
      stageProgress: { shrimp: 1 },
    });
    await expect(
      questRepository.applyProcessingProgressReceipt(firstRequest),
    ).resolves.toEqual({
      status: "replayed",
      currentStage: "process_shrimp",
      stageProgress: { shrimp: 1 },
    });

    const familyCase = processingFamilies.find(
      (entry) => entry.family === "cooking",
    )!;
    const secondOperation = `processing-family:cooking:${randomUUID()}`;
    await databaseSystem.commitProcessingActionOperationAsync(
      requestFor(secondOperation, { playerId, ...familyCase.request }),
    );
    const second = (
      await questRepository.getPendingProcessingProgressReceipts(playerId)
    ).find((entry) => entry.operationId === secondOperation)!;
    await expect(
      questRepository.applyProcessingProgressReceipt({
        ...second,
        expectedCurrentStage: "process_shrimp",
        expectedProgress: {},
        resultingStage: "process_shrimp",
        resultingProgress: { shrimp: 1 },
      }),
    ).resolves.toEqual({
      status: "stale",
      currentStage: "process_shrimp",
      stageProgress: { shrimp: 1 },
    });
    await expect(
      questRepository.applyProcessingProgressReceipt({
        ...second,
        expectedCurrentStage: "process_shrimp",
        expectedProgress: { shrimp: 1 },
        resultingStage: "process_shrimp",
        resultingProgress: { shrimp: 2 },
      }),
    ).resolves.toEqual({
      status: "applied",
      currentStage: "process_shrimp",
      stageProgress: { shrimp: 2 },
    });

    const custody = await pool.query<{
      progress: { shrimp: number };
      audit_count: string;
      pending_count: string;
    }>(
      `SELECT qp."stageProgress" AS progress,
              (SELECT count(*)::text FROM quest_audit_log qal
               WHERE qal."playerId" = qp."playerId"
                 AND qal."questId" = qp."questId"
                 AND qal.action = 'progressed') AS audit_count,
              (SELECT count(*)::text FROM quest_processing_progress_receipts qppr
               WHERE qppr.player_id = qp."playerId"
                 AND qppr.resolved_at IS NULL) AS pending_count
       FROM quest_progress qp
       WHERE qp."playerId" = $1 AND qp."questId" = 'durable_processing_cooking'`,
      [playerId],
    );
    expect(custody.rows).toEqual([
      { progress: { shrimp: 2 }, audit_count: "2", pending_count: "0" },
    ]);
  });

  it("rejects inflated progress without mutating the quest or resolving custody", async () => {
    const playerId = "processing-quest-smelting";
    const committedReceipt = (
      await questRepository.getPendingProcessingProgressReceipts(playerId)
    )[0];
    await expect(
      questRepository.applyProcessingProgressReceipt({
        ...committedReceipt,
        expectedCurrentStage: "process_iron_bar",
        expectedProgress: {},
        resultingStage: "process_iron_bar",
        resultingProgress: { iron_bar: 2 },
      }),
    ).rejects.toThrow("quest_processing_progress_result_invalid");

    const state = await pool.query<{
      progress: Record<string, number>;
      resolution: string | null;
    }>(
      `SELECT qp."stageProgress" AS progress, qppr.resolution
       FROM quest_progress qp
       JOIN quest_processing_progress_receipts qppr
         ON qppr.player_id = qp."playerId" AND qppr.quest_id = qp."questId"
       WHERE qppr.operation_id = $1 AND qppr.target_id = 'iron_bar'`,
      [committedReceipt.operationId],
    );
    expect(state.rows).toEqual([{ progress: {}, resolution: null }]);
    await expect(
      questRepository.getPendingProcessingProgressReceipts(playerId),
    ).resolves.toEqual([committedReceipt]);
    await expect(
      questRepository.ignoreProcessingProgressReceipt(committedReceipt),
    ).resolves.toBe("ignored");
  });

  it("resolves irrelevant targets and retires only superseded incarnations", async () => {
    const craftingPlayer = "processing-quest-crafting";
    const irrelevant = (
      await questRepository.getPendingProcessingProgressReceipts(craftingPlayer)
    )[0];
    await expect(
      questRepository.ignoreProcessingProgressReceipt(irrelevant),
    ).resolves.toBe("ignored");
    await expect(
      questRepository.ignoreProcessingProgressReceipt(irrelevant),
    ).resolves.toBe("already_resolved");

    const fletchingPlayer = "processing-quest-fletching";
    const superseded = (
      await questRepository.getPendingProcessingProgressReceipts(
        fletchingPlayer,
      )
    )[0];
    await expect(
      questRepository.retireProcessingProgressReceipt(superseded),
    ).resolves.toBe("still_active");
    await questRepository.completeQuest(
      fletchingPlayer,
      "durable_processing_fletching",
    );
    await expect(
      questRepository.retireProcessingProgressReceipt(superseded),
    ).resolves.toBe("retired");
    await expect(
      questRepository.retireProcessingProgressReceipt(superseded),
    ).resolves.toBe("already_resolved");
  });

  it("creates no quest edge without an active incarnation or a committed action", async () => {
    const db = drizzle(pool, { schema });
    const playerId = "processing-quest-none";
    await db.insert(schema.characters).values({
      id: playerId,
      accountId: "processing-quest-account",
      name: "Processing Quest None",
      isAgent: 1,
    });
    await db.insert(schema.inventory).values({
      playerId,
      itemId: "raw_shrimp",
      quantity: 1,
      slotIndex: 0,
    });
    const operationId = `processing-family:none:${randomUUID()}`;
    const request = requestFor(operationId, {
      playerId,
      skill: "cooking",
      xpAmount: 30,
      inputs: [{ itemId: "raw_shrimp", quantity: 1 }],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: "shrimp", quantity: 1, stackable: false }],
    });
    await databaseSystem.commitProcessingActionOperationAsync(request);
    await expect(
      questRepository.getPendingProcessingProgressReceipts(playerId),
    ).resolves.toEqual([]);

    const rejectedOperation = `processing-family:rejected:${randomUUID()}`;
    const rejectedInput: RequestInput = {
      playerId,
      skill: "cooking",
      xpAmount: 30,
      inputs: [{ itemId: "raw_shrimp", quantity: 2 }],
      requiredItems: [],
      consumables: [],
      outputs: [{ itemId: "shrimp", quantity: 2, stackable: false }],
    };
    await expect(
      databaseSystem.commitProcessingActionOperationAsync(
        requestFor(rejectedOperation, rejectedInput),
      ),
    ).rejects.toThrow("processing_action_insufficient_items");
    const counts = await pool.query<{
      operation_count: string;
      quest_receipt_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM operations_log WHERE id = $1) AS operation_count,
         (SELECT count(*)::text FROM quest_processing_progress_receipts
          WHERE operation_id = $1) AS quest_receipt_count`,
      [rejectedOperation],
    );
    expect(counts.rows[0]).toEqual({
      operation_count: "0",
      quest_receipt_count: "0",
    });
  });
});
