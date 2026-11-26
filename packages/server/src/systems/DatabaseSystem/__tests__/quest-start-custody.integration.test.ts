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
  QuestStartCommitRequest,
  QuestStartRewardItem,
} from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;
const STARTED_AT = 1_788_140_800_000;
const ITEM_FIXTURES: Item[] = [
  {
    id: "bronze_shortsword",
    name: "Bronze Shortsword",
    type: ItemType.WEAPON,
    stackable: false,
    description: "Quest-start custody fixture",
    examine: "Quest-start custody fixture",
    tradeable: true,
    rarity: "common" as Item["rarity"],
    modelPath: null,
    iconPath: "",
  },
  {
    id: "thread",
    name: "Thread",
    type: ItemType.RESOURCE,
    stackable: true,
    description: "Quest-start custody fixture",
    examine: "Quest-start custody fixture",
    tradeable: true,
    rarity: "common" as Item["rarity"],
    modelPath: null,
    iconPath: "",
  },
  {
    id: "logs",
    name: "Logs",
    type: ItemType.RESOURCE,
    stackable: false,
    description: "Quest-start custody fixture",
    examine: "Quest-start custody fixture",
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

function requestFor(input: {
  playerId: string;
  questId: string;
  questStartedAt?: number;
  initialStage?: string;
  items?: QuestStartRewardItem[];
}): QuestStartCommitRequest {
  const questStartedAt = input.questStartedAt ?? STARTED_AT;
  const initialStage = input.initialStage ?? "gather_supplies";
  const items = [...(input.items ?? [])].sort((left, right) =>
    left.itemId.localeCompare(right.itemId),
  );
  const identity = {
    version: 1,
    playerId: input.playerId,
    questId: input.questId,
    questStartedAt,
  };
  const operationId = `quest-start:${createHash("sha256")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex")}`;
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify({ ...identity, initialStage, items }), "utf8")
    .digest("hex");
  return {
    operationId,
    playerId: input.playerId,
    requestFingerprint,
    questId: input.questId,
    questStartedAt,
    initialStage,
    items,
  };
}

describeDatabase("atomic quest-start custody", () => {
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
    databaseName = `hyperia_quest_start_${process.pid}_${Date.now().toString(36)}`;
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
      id: "quest-start-account",
      name: "Quest Start Account",
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

  async function createCharacter(
    playerId: string,
    options?: { fullInventory?: boolean },
  ): Promise<void> {
    await db.insert(schema.characters).values({
      id: playerId,
      accountId: "quest-start-account",
      name: playerId,
      isAgent: 1,
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

  it("co-commits quest progress, starter inventory, audit, and exact replay", async () => {
    const playerId = "quest-start-success";
    const questId = "success_quest";
    await createCharacter(playerId);
    const request = requestFor({
      playerId,
      questId,
      items: [
        { itemId: "bronze_shortsword", quantity: 1, stackable: false },
        { itemId: "thread", quantity: 5, stackable: true },
      ],
    });

    const receipt =
      await databaseSystem.commitQuestStartOperationAsync(request);
    expect(receipt).toMatchObject({
      replayed: false,
      questStartedAt: STARTED_AT,
      initialStage: "gather_supplies",
      committed: [
        { itemId: "bronze_shortsword", quantity: 1, slotIndex: 0 },
        { itemId: "thread", quantity: 5, slotIndex: 1 },
      ],
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
    expect(quest).toMatchObject({
      status: "in_progress",
      currentStage: "gather_supplies",
      stageProgress: {},
      startedAt: STARTED_AT,
      completedAt: null,
    });
    const audits = await db
      .select()
      .from(schema.questAuditLog)
      .where(
        and(
          eq(schema.questAuditLog.playerId, playerId),
          eq(schema.questAuditLog.questId, questId),
          eq(schema.questAuditLog.action, "started"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({
      operationId: request.operationId,
      requestFingerprint: request.requestFingerprint,
    });

    await db
      .update(schema.questProgress)
      .set({ currentStage: "later_stage", stageProgress: { gathered: 1 } })
      .where(
        and(
          eq(schema.questProgress.playerId, playerId),
          eq(schema.questProgress.questId, questId),
        ),
      );
    const replay = await databaseSystem.commitQuestStartOperationAsync(request);
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(
      await db
        .select()
        .from(schema.questAuditLog)
        .where(
          and(
            eq(schema.questAuditLog.playerId, playerId),
            eq(schema.questAuditLog.questId, questId),
            eq(schema.questAuditLog.action, "started"),
          ),
        ),
    ).toHaveLength(1);
  });

  it("serializes simultaneous authorities into one starter grant", async () => {
    const playerId = "quest-start-race";
    const questId = "race_quest";
    await createCharacter(playerId);
    const request = requestFor({
      playerId,
      questId,
      items: [{ itemId: "bronze_shortsword", quantity: 1, stackable: false }],
    });

    const receipts = await Promise.all([
      databaseSystem.commitQuestStartOperationAsync(request),
      databaseSystem.commitQuestStartOperationAsync(request),
    ]);
    expect(receipts.map((entry) => entry.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      await db
        .select()
        .from(schema.inventory)
        .where(eq(schema.inventory.playerId, playerId)),
    ).toHaveLength(1);
  });

  it("rolls back quest state when starter inventory is full", async () => {
    const playerId = "quest-start-full";
    const questId = "full_quest";
    await createCharacter(playerId, { fullInventory: true });
    const request = requestFor({
      playerId,
      questId,
      items: [{ itemId: "bronze_shortsword", quantity: 1, stackable: false }],
    });

    await expect(
      databaseSystem.commitQuestStartOperationAsync(request),
    ).rejects.toThrow("quest_start_inventory_full");
    expect(
      await db
        .select()
        .from(schema.questProgress)
        .where(eq(schema.questProgress.playerId, playerId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.inventory)
        .where(eq(schema.inventory.playerId, playerId)),
    ).toHaveLength(28);
  });

  it("rolls back earlier inventory and progress writes when the late audit insert fails", async () => {
    const playerId = "quest-start-late-failure";
    const questId = "late_failure_quest";
    await createCharacter(playerId);
    const request = requestFor({
      playerId,
      questId,
      items: [{ itemId: "bronze_shortsword", quantity: 1, stackable: false }],
    });
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_owned_quest_start_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."playerId" = '${playerId}' AND NEW."action" = 'started' THEN
          RAISE EXCEPTION 'forced quest start audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_owned_quest_start_audit_trigger
      BEFORE INSERT ON quest_audit_log
      FOR EACH ROW EXECUTE FUNCTION fail_owned_quest_start_audit();
    `);
    let failure: unknown;
    try {
      await databaseSystem.commitQuestStartOperationAsync(request);
    } catch (error) {
      failure = error;
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS fail_owned_quest_start_audit_trigger ON quest_audit_log;
        DROP FUNCTION IF EXISTS fail_owned_quest_start_audit();
      `);
    }
    expect(errorChain(failure)).toContain("forced quest start audit failure");
    expect(
      await db
        .select()
        .from(schema.inventory)
        .where(eq(schema.inventory.playerId, playerId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.questProgress)
        .where(eq(schema.questProgress.playerId, playerId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.operationsLog)
        .where(eq(schema.operationsLog.id, request.operationId)),
    ).toEqual([]);
  });

  it("rejects pre-existing quest state and a forged fingerprint without rewards", async () => {
    const playerId = "quest-start-conflict";
    const questId = "conflict_quest";
    await createCharacter(playerId);
    await db.insert(schema.questProgress).values({
      playerId,
      questId,
      status: "in_progress",
      currentStage: "other_stage",
      stageProgress: {},
      startedAt: STARTED_AT - 1,
    });
    const request = requestFor({
      playerId,
      questId,
      items: [{ itemId: "bronze_shortsword", quantity: 1, stackable: false }],
    });
    await expect(
      databaseSystem.commitQuestStartOperationAsync(request),
    ).rejects.toThrow("quest_start_progress_state_conflict");
    await expect(
      databaseSystem.commitQuestStartOperationAsync({
        ...request,
        requestFingerprint: "f".repeat(64),
      }),
    ).rejects.toThrow("quest_start_request_invalid");
    expect(
      await db
        .select()
        .from(schema.inventory)
        .where(eq(schema.inventory.playerId, playerId)),
    ).toEqual([]);
  });
});
