import { createHash } from "node:crypto";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ITEMS, ItemType, type Item } from "@hyperforge/shared";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import * as schema from "../../../database/schema.js";
import type {
  QuestCompletionCommitRequest,
  QuestCompletionRewardItem,
  QuestCompletionRewardXp,
} from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;
const STARTED_AT = 1_788_137_200_000;
const ITEM_FIXTURES: Item[] = [
  {
    id: "xp_lamp_100",
    name: "XP Lamp (100)",
    type: ItemType.CONSUMABLE,
    stackable: false,
    description: "Quest-completion custody fixture",
    examine: "Quest-completion custody fixture",
    tradeable: false,
    rarity: "rare" as Item["rarity"],
    modelPath: null,
    iconPath: "",
  },
  {
    id: "logs",
    name: "Logs",
    type: ItemType.RESOURCE,
    stackable: false,
    description: "Quest-completion custody fixture",
    examine: "Quest-completion custody fixture",
    tradeable: true,
    rarity: "common" as Item["rarity"],
    modelPath: null,
    iconPath: "",
  },
];
const priorItems = new Map<string, Item | undefined>();

function errorChain(error: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (
      "message" in current &&
      typeof (current as { message?: unknown }).message === "string"
    ) {
      messages.push((current as { message: string }).message);
    }
    current = "cause" in current ? current.cause : null;
  }
  return messages.join("\n");
}

function operationId(
  playerId: string,
  questId: string,
  questStartedAt: number,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({ version: 1, playerId, questId, questStartedAt }),
      "utf8",
    )
    .digest("hex");
  return `quest-completion:${digest}`;
}

function requestFor(input: {
  playerId: string;
  questId: string;
  questStartedAt?: number;
  expectedStage?: string;
  expectedProgress?: Record<string, number>;
  questPoints?: number;
  items?: QuestCompletionRewardItem[];
  xp?: QuestCompletionRewardXp[];
}): QuestCompletionCommitRequest {
  const questStartedAt = input.questStartedAt ?? STARTED_AT;
  const expectedStage = input.expectedStage ?? "return_to_mentor";
  const expectedProgress = input.expectedProgress ?? { kills: 15 };
  const questPoints = input.questPoints ?? 1;
  const items = [...(input.items ?? [])].sort((left, right) =>
    left.itemId.localeCompare(right.itemId),
  );
  const xp = [...(input.xp ?? [])].sort((left, right) =>
    left.skill.localeCompare(right.skill),
  );
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId: input.playerId,
        questId: input.questId,
        questStartedAt,
        expectedStage,
        expectedProgress,
        questPoints,
        items,
        xp,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    operationId: operationId(input.playerId, input.questId, questStartedAt),
    playerId: input.playerId,
    requestFingerprint,
    questId: input.questId,
    questStartedAt,
    expectedStage,
    expectedProgress,
    questPoints,
    items,
    xp,
  };
}

describeDatabase("atomic quest completion custody", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let databaseSystem: DatabaseSystem;

  beforeAll(async () => {
    for (const item of ITEM_FIXTURES) {
      priorItems.set(item.id, ITEMS.get(item.id));
      ITEMS.set(item.id, item);
    }
    databaseName = `hyperia_quest_completion_${process.pid}_${Date.now().toString(36)}`;
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
          "../../../database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    db = drizzle(pool, { schema });
    await db.insert(schema.users).values({
      id: "quest-completion-account",
      name: "Quest Completion Account",
      roles: "user",
      createdAt: "2026-08-31T00:00:00.000Z",
    });
    databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
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
    for (const item of ITEM_FIXTURES) {
      const prior = priorItems.get(item.id);
      if (prior) ITEMS.set(item.id, prior);
      else ITEMS.delete(item.id);
    }
  }, 30_000);

  async function createQuest(
    playerId: string,
    questId: string,
    options?: { fullInventory?: boolean },
  ): Promise<void> {
    await db.insert(schema.characters).values({
      id: playerId,
      accountId: "quest-completion-account",
      name: playerId,
      isAgent: 1,
    });
    await db.insert(schema.questProgress).values({
      playerId,
      questId,
      status: "in_progress",
      currentStage: "return_to_mentor",
      stageProgress: { kills: 15 },
      startedAt: STARTED_AT,
    });
    if (options?.fullInventory) {
      await db.insert(schema.inventory).values(
        Array.from({ length: 28 }, (_, slotIndex) => ({
          playerId,
          itemId: "logs",
          quantity: 1,
          slotIndex,
        })),
      );
    }
  }

  it("commits quest state, points, items, all XP, Prayer, audit, and receipt together", async () => {
    const playerId = "quest-completion-success";
    const questId = "success_quest";
    await createQuest(playerId, questId);
    const request = requestFor({
      playerId,
      questId,
      questPoints: 2,
      items: [{ itemId: "xp_lamp_100", quantity: 1, stackable: false }],
      xp: [
        { skill: "prayer", xpAmount: 100 },
        { skill: "attack", xpAmount: 500 },
        { skill: "crafting", xpAmount: 100 },
      ],
    });

    const receipt =
      await databaseSystem.commitQuestCompletionOperationAsync(request);
    expect(receipt).toMatchObject({
      replayed: false,
      questPoints: 2,
      operationCommittedQuestPoints: 2,
      currentQuestPoints: 2,
      items: [{ itemId: "xp_lamp_100", quantity: 1, stackable: false }],
      progress: [
        {
          skill: "attack",
          awardedXp: 500,
          operationCommittedXp: 500,
          currentLevel: 5,
        },
        {
          skill: "crafting",
          awardedXp: 100,
          operationCommittedXp: 100,
          currentLevel: 2,
        },
        {
          skill: "prayer",
          awardedXp: 100,
          operationCommittedXp: 100,
          currentLevel: 2,
        },
      ],
      prayer: {
        pointUnits: 2_000_000,
        maxPoints: 2,
        activePrayers: [],
      },
      committed: [{ itemId: "xp_lamp_100", quantity: 1, slotIndex: 0 }],
    });

    const [character] = await db
      .select({
        questPoints: schema.characters.questPoints,
        attackXp: schema.characters.attackXp,
        attackLevel: schema.characters.attackLevel,
        craftingXp: schema.characters.craftingXp,
        craftingLevel: schema.characters.craftingLevel,
        prayerXp: schema.characters.prayerXp,
        prayerLevel: schema.characters.prayerLevel,
        prayerPointUnits: schema.characters.prayerPointUnits,
        prayerMaxPoints: schema.characters.prayerMaxPoints,
      })
      .from(schema.characters)
      .where(eq(schema.characters.id, playerId));
    expect(character).toEqual({
      questPoints: 2,
      attackXp: 500,
      attackLevel: 5,
      craftingXp: 100,
      craftingLevel: 2,
      prayerXp: 100,
      prayerLevel: 2,
      prayerPointUnits: 2_000_000,
      prayerMaxPoints: 2,
    });
    const [quest] = await db
      .select()
      .from(schema.questProgress)
      .where(
        and(
          eq(schema.questProgress.playerId, playerId),
          eq(schema.questProgress.questId, questId),
        ),
      );
    expect(quest.status).toBe("completed");
    expect(quest.completedAt).toBe(receipt.completedAt);
    const audits = await db
      .select()
      .from(schema.questAuditLog)
      .where(
        and(
          eq(schema.questAuditLog.playerId, playerId),
          eq(schema.questAuditLog.questId, questId),
          eq(schema.questAuditLog.action, "completed"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({
      operationId: request.operationId,
      requestFingerprint: request.requestFingerprint,
    });

    const replay =
      await databaseSystem.commitQuestCompletionOperationAsync(request);
    expect(replay).toMatchObject({
      replayed: true,
      completedAt: receipt.completedAt,
      operationCommittedQuestPoints: 2,
      currentQuestPoints: 2,
    });
    expect(replay.committed).toHaveLength(1);
    expect(replay.progress).toEqual(receipt.progress);
    expect(
      await db
        .select()
        .from(schema.questAuditLog)
        .where(
          and(
            eq(schema.questAuditLog.playerId, playerId),
            eq(schema.questAuditLog.questId, questId),
            eq(schema.questAuditLog.action, "completed"),
          ),
        ),
    ).toHaveLength(1);
  });

  it("serializes simultaneous completion authorities into one reward", async () => {
    const playerId = "quest-completion-race";
    const questId = "race_quest";
    await createQuest(playerId, questId);
    const request = requestFor({
      playerId,
      questId,
      items: [{ itemId: "xp_lamp_100", quantity: 1, stackable: false }],
      xp: [{ skill: "attack", xpAmount: 500 }],
    });
    const receipts = await Promise.all([
      databaseSystem.commitQuestCompletionOperationAsync(request),
      databaseSystem.commitQuestCompletionOperationAsync(request),
    ]);
    expect(receipts.map((entry) => entry.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const [character] = await db
      .select({
        questPoints: schema.characters.questPoints,
        attackXp: schema.characters.attackXp,
      })
      .from(schema.characters)
      .where(eq(schema.characters.id, playerId));
    expect(character).toEqual({ questPoints: 1, attackXp: 500 });
    expect(
      await db
        .select()
        .from(schema.inventory)
        .where(eq(schema.inventory.playerId, playerId)),
    ).toHaveLength(1);
  });

  it("rolls back every reward when inventory capacity rejects", async () => {
    const playerId = "quest-completion-full";
    const questId = "full_quest";
    await createQuest(playerId, questId, { fullInventory: true });
    const request = requestFor({
      playerId,
      questId,
      items: [{ itemId: "xp_lamp_100", quantity: 1, stackable: false }],
      xp: [{ skill: "attack", xpAmount: 500 }],
    });
    await expect(
      databaseSystem.commitQuestCompletionOperationAsync(request),
    ).rejects.toThrow("quest_completion_inventory_full");
    const [character] = await db
      .select({
        questPoints: schema.characters.questPoints,
        attackXp: schema.characters.attackXp,
      })
      .from(schema.characters)
      .where(eq(schema.characters.id, playerId));
    expect(character).toEqual({ questPoints: 0, attackXp: 0 });
    const [quest] = await db
      .select({ status: schema.questProgress.status })
      .from(schema.questProgress)
      .where(eq(schema.questProgress.playerId, playerId));
    expect(quest.status).toBe("in_progress");
    expect(
      await db
        .select()
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, request.operationId)),
    ).toEqual([]);
  });

  it("rolls back late audit failure after inventory, XP, points, and status writes", async () => {
    const playerId = "quest-completion-late-failure";
    const questId = "rollback_quest";
    await createQuest(playerId, questId);
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_rollback_quest_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."questId" = 'rollback_quest' AND NEW."action" = 'completed' THEN
          RAISE EXCEPTION 'forced late quest completion failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_rollback_quest_audit_trigger
      BEFORE INSERT ON quest_audit_log
      FOR EACH ROW EXECUTE FUNCTION reject_rollback_quest_audit();
    `);
    const request = requestFor({
      playerId,
      questId,
      items: [{ itemId: "xp_lamp_100", quantity: 1, stackable: false }],
      xp: [{ skill: "attack", xpAmount: 500 }],
    });
    let failure: unknown;
    try {
      await databaseSystem.commitQuestCompletionOperationAsync(request);
    } catch (error) {
      failure = error;
    }
    expect(errorChain(failure)).toContain(
      "forced late quest completion failure",
    );
    const [character] = await db
      .select({
        questPoints: schema.characters.questPoints,
        attackXp: schema.characters.attackXp,
      })
      .from(schema.characters)
      .where(eq(schema.characters.id, playerId));
    expect(character).toEqual({ questPoints: 0, attackXp: 0 });
    const [quest] = await db
      .select({
        status: schema.questProgress.status,
        completedAt: schema.questProgress.completedAt,
      })
      .from(schema.questProgress)
      .where(eq(schema.questProgress.playerId, playerId));
    expect(quest).toEqual({ status: "in_progress", completedAt: null });
    expect(
      await db
        .select()
        .from(schema.inventory)
        .where(eq(schema.inventory.playerId, playerId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, request.operationId)),
    ).toEqual([]);
  });

  it("rejects stale progress and a forged fingerprint before mutation", async () => {
    const playerId = "quest-completion-stale";
    const questId = "stale_quest";
    await createQuest(playerId, questId);
    const stale = requestFor({
      playerId,
      questId,
      expectedProgress: { kills: 14 },
    });
    await expect(
      databaseSystem.commitQuestCompletionOperationAsync(stale),
    ).rejects.toThrow("quest_completion_progress_state_conflict");
    await expect(
      databaseSystem.commitQuestCompletionOperationAsync({
        ...requestFor({ playerId, questId }),
        requestFingerprint: "0".repeat(64),
      }),
    ).rejects.toThrow("quest_completion_request_invalid");
    const [character] = await db
      .select({ questPoints: schema.characters.questPoints })
      .from(schema.characters)
      .where(eq(schema.characters.id, playerId));
    expect(character.questPoints).toBe(0);
  });
});
