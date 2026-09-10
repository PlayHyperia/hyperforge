import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  ITEMS,
  ammunitionShotIdentityFromRequest,
  generateKillToken,
  getProcessingFireExtinguishOperationId,
  serializeGroundItemDeathCommitFingerprint,
  serializeGroundItemDropCommitFingerprint,
  serializeGroundItemMobLootCommitFingerprint,
  serializeGroundItemSourceRegistrationFingerprint,
  serializeProcessingFireExtinguishFingerprint,
  serializeAmmunitionShotFingerprint,
} from "@hyperforge/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import * as schema from "../../../database/schema.js";
import type {
  GroundItemDropCommitRequest,
  GroundItemDeathCommitRequest,
  GroundItemMobLootCommitRequest,
  GroundItemPickupCommitRequest,
  GroundItemSourceRegistrationRequest,
  AmmunitionShotCommitRequest,
  ProjectileRuneCostCommitRequest,
  ProcessingFireExtinguishCommitRequest,
} from "../../../shared/types/index.js";
import { DatabaseSystem } from "../index.js";

const baseDatabaseUrl =
  process.env.GROUND_ITEM_PICKUP_TEST_DATABASE_URL?.trim() ||
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ||
  "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;
const PLAYER_ID = "ground-pickup-custody-agent";
const MOB_LOOT_SECRET = "ground-pickup-mob-loot-integration-secret";
const priorKillTokenSecret = process.env.KILL_TOKEN_SECRET;

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

async function expectErrorChain(
  promise: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(errorChain(caught)).toContain(expectedMessage);
}

function fingerprint(
  sourceEntityId: string,
  itemId: string,
  quantity: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        playerId: PLAYER_ID,
        sourceEntityId,
        itemId,
        quantity,
      }),
      "utf8",
    )
    .digest("hex");
}

function request(
  operationId: string,
  sourceEntityId: string,
  itemId = "air_rune",
  quantity = 1,
): GroundItemPickupCommitRequest {
  return {
    operationId,
    playerId: PLAYER_ID,
    requestFingerprint: fingerprint(sourceEntityId, itemId, quantity),
    sourceEntityId,
    itemId,
    quantity,
  };
}

function sourceRegistrationRequest(
  sourceId: string,
  itemId: string,
  quantity: number,
  options: {
    position?: { x: number; y: number; z: number };
    tile?: { x: number; z: number };
    allowMerge?: boolean;
    droppedBy?: string | null;
    lootProtectionMs?: number;
  } = {},
): GroundItemSourceRegistrationRequest {
  const input: Omit<GroundItemSourceRegistrationRequest, "requestFingerprint"> =
    {
      contributionId: `ground-item-source:${randomUUID()}`,
      preferredSourceId: sourceId,
      itemId,
      quantity,
      stackable: ITEMS.get(itemId)?.stackable === true,
      position: options.position ?? { x: 1.5, y: 0.2, z: 1.5 },
      tile: options.tile ?? { x: 1, z: 1 },
      droppedBy: options.droppedBy ?? null,
      lifetimeMs: 120_000,
      lootProtectionMs: options.lootProtectionMs ?? 0,
      allowMerge: options.allowMerge ?? false,
    };
  return {
    ...input,
    requestFingerprint: createHash("sha256")
      .update(serializeGroundItemSourceRegistrationFingerprint(input), "utf8")
      .digest("hex"),
  };
}

function groundDeathRequest(
  operationId: string,
  sources: GroundItemSourceRegistrationRequest[],
): GroundItemDeathCommitRequest {
  const input: Omit<GroundItemDeathCommitRequest, "requestFingerprint"> = {
    operationId,
    playerId: PLAYER_ID,
    deathTimestamp: 1_788_087_600_000,
    position: { x: 50.5, y: 0.2, z: 50.5 },
    killedBy: "combat_agent",
    zoneType: "wilderness",
    sources,
  };
  return {
    ...input,
    requestFingerprint: createHash("sha256")
      .update(serializeGroundItemDeathCommitFingerprint(input), "utf8")
      .digest("hex"),
  };
}

async function groundMobLootRequest(
  operationId: string,
  sources: GroundItemSourceRegistrationRequest[],
): Promise<GroundItemMobLootCommitRequest> {
  const deathTimestamp = 1_788_087_600_000;
  const attackStyle = "aggressive";
  const damageDealt = 20;
  const identity = {
    operationId,
    killedBy: PLAYER_ID,
    mobId: "integration-mob-life-1",
    mobType: "guard",
    deathTimestamp,
    position: { x: 60.5, y: 0.2, z: 60.5 },
    killToken: await generateKillToken(
      "integration-mob-life-1",
      PLAYER_ID,
      deathTimestamp,
      operationId,
      attackStyle,
      damageDealt,
    ),
    attackStyle,
    damageDealt,
  };
  return {
    ...identity,
    requestFingerprint: createHash("sha256")
      .update(serializeGroundItemMobLootCommitFingerprint(identity), "utf8")
      .digest("hex"),
    sources,
  };
}

function groundDropRequest(
  operationId: string,
  sourceId: string,
  itemId: string,
  quantity: number,
  slotIndex: number | null,
): GroundItemDropCommitRequest {
  const source = sourceRegistrationRequest(sourceId, itemId, quantity, {
    position: { x: 40.5, y: 0.2, z: 40.5 },
    tile: { x: 40, z: 40 },
    droppedBy: PLAYER_ID,
  });
  const input: Omit<GroundItemDropCommitRequest, "requestFingerprint"> = {
    operationId,
    playerId: PLAYER_ID,
    itemId,
    quantity,
    slotIndex,
    source,
  };
  return {
    ...input,
    requestFingerprint: createHash("sha256")
      .update(serializeGroundItemDropCommitFingerprint(input), "utf8")
      .digest("hex"),
  };
}

async function registerSource(
  databaseSystem: DatabaseSystem,
  sourceId: string,
  itemId: string,
  quantity: number,
): Promise<void> {
  await databaseSystem.registerGroundItemSourceAsync(
    sourceRegistrationRequest(sourceId, itemId, quantity),
  );
}

function fireExtinguishRequest(
  fireId: string,
  playerId: string,
  position: { x: number; y: number; z: number },
  expiresAt: number,
  source: GroundItemSourceRegistrationRequest,
): ProcessingFireExtinguishCommitRequest {
  const identity = {
    operationId: getProcessingFireExtinguishOperationId(fireId),
    fireId,
    playerId,
    position,
    expiresAt,
  };
  return {
    ...identity,
    requestFingerprint: createHash("sha256")
      .update(serializeProcessingFireExtinguishFingerprint(identity), "utf8")
      .digest("hex"),
    source,
  };
}

function ammunitionShotRequest(
  operationId: string,
  source: GroundItemSourceRegistrationRequest | null,
): AmmunitionShotCommitRequest {
  const input = {
    operationId,
    playerId: PLAYER_ID,
    itemId: "bronze_arrow",
    quantity: 1 as const,
    recoveryDisposition: source
      ? ("recovered" as const)
      : ("destroyed" as const),
    source,
  };
  return {
    ...input,
    requestFingerprint: createHash("sha256")
      .update(
        serializeAmmunitionShotFingerprint(
          ammunitionShotIdentityFromRequest(input),
        ),
        "utf8",
      )
      .digest("hex"),
  };
}

function projectileRuneCostRequest(
  operationId: string,
): ProjectileRuneCostCommitRequest {
  const requirements = [
    { itemId: "air_rune", quantity: 2 },
    { itemId: "mind_rune", quantity: 1 },
  ];
  return {
    operationId,
    playerId: PLAYER_ID,
    requirements,
    requestFingerprint: createHash("sha256")
      .update(
        JSON.stringify({ version: 1, playerId: PLAYER_ID, requirements }),
        "utf8",
      )
      .digest("hex"),
  };
}

describeDatabase("ground-item pickup PostgreSQL custody", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseSystem: DatabaseSystem;
  const priorAirRune = ITEMS.get("air_rune");
  const priorMindRune = ITEMS.get("mind_rune");
  const priorCoins = ITEMS.get("coins");
  const priorLogs = ITEMS.get("logs");
  const priorAshes = ITEMS.get("ashes");
  const priorBronzeArrow = ITEMS.get("bronze_arrow");

  beforeAll(async () => {
    process.env.KILL_TOKEN_SECRET = MOB_LOOT_SECRET;
    ITEMS.set("air_rune", {
      id: "air_rune",
      name: "Air rune",
      type: "resource",
      stackable: true,
    } as never);
    ITEMS.set("mind_rune", {
      id: "mind_rune",
      name: "Mind rune",
      type: "resource",
      stackable: true,
    } as never);
    ITEMS.set("coins", {
      id: "coins",
      name: "Coins",
      type: "currency",
      stackable: true,
    } as never);
    ITEMS.set("logs", {
      id: "logs",
      name: "Logs",
      type: "resource",
      stackable: false,
    } as never);
    ITEMS.set("ashes", {
      id: "ashes",
      name: "Ashes",
      type: "misc",
      stackable: true,
    } as never);
    ITEMS.set("bronze_arrow", {
      id: "bronze_arrow",
      name: "Bronze arrow",
      type: "ammunition",
      equipSlot: "arrows",
      stackable: true,
    } as never);

    databaseName = `hyperia_ground_pickup_${process.pid}_${Date.now().toString(36)}`;
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
      statement_timeout: 3_000,
      query_timeout: 4_000,
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
      id: "ground-pickup-custody-account",
      name: "Ground Pickup Custody Account",
      roles: "user",
      createdAt: "2026-08-29T00:00:00.000Z",
    });
    await db.insert(schema.characters).values({
      id: PLAYER_ID,
      accountId: "ground-pickup-custody-account",
      name: "Ground Pickup Custody Agent",
      isAgent: 1,
      coins: 100,
    });
    databaseSystem = new DatabaseSystem({
      drizzleDb: db,
      pgPool: pool,
    } as never);
    await databaseSystem.init();
  }, 30_000);

  afterAll(async () => {
    if (priorKillTokenSecret === undefined)
      delete process.env.KILL_TOKEN_SECRET;
    else process.env.KILL_TOKEN_SECRET = priorKillTokenSecret;
    if (priorAirRune) ITEMS.set("air_rune", priorAirRune);
    else ITEMS.delete("air_rune");
    if (priorMindRune) ITEMS.set("mind_rune", priorMindRune);
    else ITEMS.delete("mind_rune");
    if (priorCoins) ITEMS.set("coins", priorCoins);
    else ITEMS.delete("coins");
    if (priorLogs) ITEMS.set("logs", priorLogs);
    else ITEMS.delete("logs");
    if (priorAshes) ITEMS.set("ashes", priorAshes);
    else ITEMS.delete("ashes");
    if (priorBronzeArrow) ITEMS.set("bronze_arrow", priorBronzeArrow);
    else ITEMS.delete("bronze_arrow");
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

  it("commits once, returns current custody on replacement replay, and fences source contention", async () => {
    const source = `ground_item_${randomUUID()}`;
    const operationId = `ground-item-pickup:${randomUUID()}`;
    await registerSource(databaseSystem, source, "air_rune", 2);
    const firstRequest = request(operationId, source, "air_rune", 2);
    await expect(
      databaseSystem.commitGroundItemPickupOperationAsync(firstRequest),
    ).resolves.toMatchObject({
      replayed: false,
      currentCoins: 100,
      committed: [
        { itemId: "air_rune", quantity: 2, slotIndex: 0, metadata: null },
      ],
    });

    await pool.query(`DELETE FROM inventory WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex") VALUES ($1, 'logs', 1, 4)`,
      [PLAYER_ID],
    );
    await pool.query(`UPDATE characters SET coins = 125 WHERE id = $1`, [
      PLAYER_ID,
    ]);
    const replacement = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await replacement.init();
    await expect(
      replacement.commitGroundItemPickupOperationAsync(firstRequest),
    ).resolves.toMatchObject({
      replayed: true,
      currentCoins: 125,
      committed: [
        { itemId: "logs", quantity: 1, slotIndex: 4, metadata: null },
      ],
    });

    const contestedSource = `ground_item_${randomUUID()}`;
    await registerSource(databaseSystem, contestedSource, "air_rune", 1);
    const contenders = await Promise.allSettled([
      databaseSystem.commitGroundItemPickupOperationAsync(
        request(
          `ground-item-pickup:${randomUUID()}`,
          contestedSource,
          "air_rune",
          1,
        ),
      ),
      replacement.commitGroundItemPickupOperationAsync(
        request(
          `ground-item-pickup:${randomUUID()}`,
          contestedSource,
          "air_rune",
          1,
        ),
      ),
    ]);
    expect(
      contenders.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = contenders.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: "ground_item_pickup_source_claimed",
      }),
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM operations_log
             WHERE "operationType" = 'ground_item_pickup'
               AND "operationState"->>'sourceEntityId' = $1) AS source_receipts,
           (SELECT COALESCE(sum(quantity), 0)::int FROM inventory
             WHERE "playerId" = $2 AND "itemId" = 'air_rune') AS air_runes`,
        [contestedSource, PLAYER_ID],
      ),
    ).resolves.toMatchObject({
      rows: [{ source_receipts: 1, air_runes: 1 }],
    });
  });

  it("co-commits one mob loot roll, replays it on a replacement, and rolls back a failed receipt", async () => {
    const questId = `mob_loot_kill_progress_${randomUUID()}`;
    const questStartedAt = 1_788_087_500_000;
    const questRepository = databaseSystem.getQuestRepository();
    await questRepository.startQuest(
      PLAYER_ID,
      questId,
      "kill_guards",
      questStartedAt,
    );
    const firstSource = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "air_rune",
      4,
      {
        position: { x: 60.5, y: 0.2, z: 60.5 },
        tile: { x: 60, z: 60 },
        droppedBy: PLAYER_ID,
        lootProtectionMs: 60_000,
      },
    );
    const operationId = `ground-item-mob-loot:${randomUUID()}`;
    const mobLoot = await groundMobLootRequest(operationId, [firstSource]);

    await expect(
      databaseSystem.commitGroundItemMobLootOperationAsync(mobLoot),
    ).resolves.toMatchObject({
      replayed: false,
      dropped: [{ itemId: "air_rune", quantity: 4 }],
      sources: [{ replayed: false }],
      combatProgress: [
        {
          skill: "strength",
          awardedXp: 80,
          operationCommittedXp: 80,
          currentXp: 80,
        },
        {
          skill: "constitution",
          awardedXp: 26,
          operationCommittedXp: 1_180,
          currentXp: 1_180,
        },
      ],
    });
    const pendingKillProgress =
      await questRepository.getPendingKillProgressReceipts(PLAYER_ID);
    expect(pendingKillProgress).toContainEqual({
      operationId,
      playerId: PLAYER_ID,
      questId,
      questStartedAt,
      capturedStage: "kill_guards",
      mobId: mobLoot.mobId,
      mobType: mobLoot.mobType,
      quantity: 1,
      createdAt: expect.any(Number),
    });
    const killReceipt = pendingKillProgress.find(
      (receipt) => receipt.operationId === operationId,
    );
    expect(killReceipt).toBeDefined();
    if (!killReceipt) throw new Error("kill_progress_receipt_missing");
    const killApplication = {
      ...killReceipt,
      expectedCurrentStage: "kill_guards",
      expectedProgress: {},
      resultingStage: "kill_guards",
      resultingProgress: { kills: 1 },
    };
    await expect(
      questRepository.applyKillProgressReceipt(killApplication),
    ).resolves.toEqual({
      status: "applied",
      currentStage: "kill_guards",
      stageProgress: { kills: 1 },
    });
    await expect(
      questRepository.applyKillProgressReceipt(killApplication),
    ).resolves.toEqual({
      status: "replayed",
      currentStage: "kill_guards",
      stageProgress: { kills: 1 },
    });
    const replacement = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await replacement.init();
    const changedCandidate = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "coins",
      99,
      {
        position: { x: 61.5, y: 0.2, z: 60.5 },
        tile: { x: 61, z: 60 },
        droppedBy: PLAYER_ID,
        lootProtectionMs: 60_000,
      },
    );
    await expect(
      replacement.commitGroundItemMobLootOperationAsync({
        ...mobLoot,
        sources: [changedCandidate],
      }),
    ).resolves.toMatchObject({
      replayed: true,
      dropped: [{ itemId: "air_rune", quantity: 4 }],
      sources: [
        {
          sourceId: firstSource.preferredSourceId,
          itemId: "air_rune",
          quantity: 4,
          replayed: true,
        },
      ],
      combatProgress: [
        { skill: "strength", currentXp: 80 },
        { skill: "constitution", currentXp: 1_180 },
      ],
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM operations_log WHERE id = $1) AS operation_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = ANY($2::text[])) AS original_source_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = $3) AS changed_source_count,
           (SELECT count(*)::int FROM quest_kill_progress_receipts
             WHERE operation_id = $1 AND quest_id = $4
               AND resolution = 'applied') AS kill_receipt_count,
           (SELECT ("stageProgress"->>'kills')::int FROM quest_progress
             WHERE "playerId" = $5 AND "questId" = $4) AS kill_count,
           (SELECT "strengthXp" FROM characters WHERE id = $5) AS strength_xp,
           (SELECT "constitutionXp" FROM characters WHERE id = $5) AS constitution_xp`,
        [
          operationId,
          [firstSource.preferredSourceId],
          changedCandidate.preferredSourceId,
          questId,
          PLAYER_ID,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          operation_count: 1,
          original_source_count: 1,
          changed_source_count: 0,
          kill_receipt_count: 1,
          kill_count: 1,
          strength_xp: 80,
          constitution_xp: 1_180,
        },
      ],
    });
    await questRepository.completeQuest(PLAYER_ID, questId);

    const rollbackSource = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "air_rune",
      3,
      {
        position: { x: 62.5, y: 0.2, z: 60.5 },
        tile: { x: 62, z: 60 },
        droppedBy: PLAYER_ID,
        lootProtectionMs: 60_000,
      },
    );
    const rollbackOperationId = `ground-item-mob-loot:${randomUUID()}`;
    const rollbackRequest = await groundMobLootRequest(rollbackOperationId, [
      rollbackSource,
    ]);
    const rollbackQuestId = `mob_loot_rollback_${randomUUID()}`;
    await questRepository.startQuest(
      PLAYER_ID,
      rollbackQuestId,
      "kill_guards",
      questStartedAt + 1,
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_test_quest_kill_progress_receipt()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced_quest_kill_progress_receipt_failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_quest_kill_progress_receipt_trigger
      BEFORE INSERT ON quest_kill_progress_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_test_quest_kill_progress_receipt();
    `);
    try {
      await expectErrorChain(
        databaseSystem.commitGroundItemMobLootOperationAsync(rollbackRequest),
        "forced_quest_kill_progress_receipt_failure",
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_test_quest_kill_progress_receipt_trigger
          ON quest_kill_progress_receipts;
        DROP FUNCTION IF EXISTS reject_test_quest_kill_progress_receipt();
      `);
    }
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM operations_log WHERE id = $1) AS operation_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = $2) AS source_count,
           (SELECT count(*)::int FROM ground_item_source_contributions
             WHERE contribution_id = $3) AS contribution_count,
           (SELECT count(*)::int FROM quest_kill_progress_receipts
             WHERE operation_id = $1) AS kill_receipt_count,
           (SELECT "strengthXp" FROM characters WHERE id = $4) AS strength_xp,
           (SELECT "constitutionXp" FROM characters WHERE id = $4) AS constitution_xp`,
        [
          rollbackOperationId,
          rollbackSource.preferredSourceId,
          rollbackSource.contributionId,
          PLAYER_ID,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          operation_count: 0,
          source_count: 0,
          contribution_count: 0,
          kill_receipt_count: 0,
          strength_xp: 80,
          constitution_xp: 1_180,
        },
      ],
    });
    await questRepository.completeQuest(PLAYER_ID, rollbackQuestId);
  });

  it("co-commits fire expiry and ashes, replays on replacement, and rolls back a failed receipt", async () => {
    const fireId = `fire_${randomUUID()}`;
    const parentOperationId = `processing-action-seed:${randomUUID()}`;
    const position = { x: 70.5, y: 0.2, z: 70.5 };
    const expiresAt = Date.now() - 1_000;
    await pool.query(
      `INSERT INTO operations_log
         (id, "playerId", "operationType", "operationState", completed, timestamp, "completedAt")
       VALUES ($1, $2, 'processing_action', '{}'::jsonb, true, $3, $3)`,
      [parentOperationId, PLAYER_ID, expiresAt - 1_000],
    );
    await pool.query(
      `INSERT INTO processing_active_fires
         (fire_id, operation_id, player_id, position_x, position_y, position_z,
          tile_x, tile_z, created_at, expires_at, extinguished_at)
       VALUES ($1, $2, $3, $4, $5, $6, 70, 70, $7, $8, NULL)`,
      [
        fireId,
        parentOperationId,
        PLAYER_ID,
        position.x,
        position.y,
        position.z,
        expiresAt - 60_000,
        expiresAt,
      ],
    );
    const source = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "ashes",
      1,
      { position, tile: { x: 70, z: 70 } },
    );
    const request = fireExtinguishRequest(
      fireId,
      PLAYER_ID,
      position,
      expiresAt,
      source,
    );
    await expect(
      databaseSystem.commitProcessingFireExtinguishOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: false,
      sourceRequest: source,
      source: { sourceId: source.preferredSourceId, replayed: false },
    });

    const replacement = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await replacement.init();
    const changedCandidate = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "ashes",
      1,
      { position, tile: { x: 70, z: 70 } },
    );
    await expect(
      replacement.commitProcessingFireExtinguishOperationAsync({
        ...request,
        source: changedCandidate,
      }),
    ).resolves.toMatchObject({
      replayed: true,
      sourceRequest: source,
      source: { sourceId: source.preferredSourceId, replayed: true },
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM operations_log WHERE id = $1) AS operation_count,
           (SELECT count(*)::int FROM processing_active_fires
             WHERE fire_id = $2 AND extinguished_at IS NOT NULL) AS extinguished_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = $3) AS source_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = $4) AS changed_source_count`,
        [
          request.operationId,
          fireId,
          source.preferredSourceId,
          changedCandidate.preferredSourceId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          operation_count: 1,
          extinguished_count: 1,
          source_count: 1,
          changed_source_count: 0,
        },
      ],
    });

    const rollbackFireId = `fire_${randomUUID()}`;
    const rollbackParentId = `processing-action-seed:${randomUUID()}`;
    const rollbackExpiresAt = Date.now() - 1_000;
    await pool.query(
      `INSERT INTO operations_log
         (id, "playerId", "operationType", "operationState", completed, timestamp, "completedAt")
       VALUES ($1, $2, 'processing_action', '{}'::jsonb, true, $3, $3)`,
      [rollbackParentId, PLAYER_ID, rollbackExpiresAt - 1_000],
    );
    await pool.query(
      `INSERT INTO processing_active_fires
         (fire_id, operation_id, player_id, position_x, position_y, position_z,
          tile_x, tile_z, created_at, expires_at, extinguished_at)
       VALUES ($1, $2, $3, $4, $5, $6, 71, 70, $7, $8, NULL)`,
      [
        rollbackFireId,
        rollbackParentId,
        PLAYER_ID,
        71.5,
        position.y,
        position.z,
        rollbackExpiresAt - 60_000,
        rollbackExpiresAt,
      ],
    );
    const rollbackSource = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "ashes",
      1,
      {
        position: { x: 71.5, y: position.y, z: position.z },
        tile: { x: 71, z: 70 },
      },
    );
    const rollbackRequest = fireExtinguishRequest(
      rollbackFireId,
      PLAYER_ID,
      rollbackSource.position,
      rollbackExpiresAt,
      rollbackSource,
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_test_fire_extinguish_receipt()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."operationType" = 'processing_fire_extinguish' THEN
          RAISE EXCEPTION 'forced_fire_extinguish_receipt_failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_fire_extinguish_receipt_trigger
      BEFORE INSERT ON operations_log
      FOR EACH ROW EXECUTE FUNCTION reject_test_fire_extinguish_receipt();
    `);
    try {
      await expectErrorChain(
        databaseSystem.commitProcessingFireExtinguishOperationAsync(
          rollbackRequest,
        ),
        "forced_fire_extinguish_receipt_failure",
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_test_fire_extinguish_receipt_trigger
          ON operations_log;
        DROP FUNCTION IF EXISTS reject_test_fire_extinguish_receipt();
      `);
    }
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM operations_log WHERE id = $1) AS operation_count,
           (SELECT count(*)::int FROM processing_active_fires
             WHERE fire_id = $2 AND extinguished_at IS NULL) AS active_fire_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = $3) AS source_count,
           (SELECT count(*)::int FROM ground_item_source_contributions
             WHERE contribution_id = $4) AS contribution_count`,
        [
          rollbackRequest.operationId,
          rollbackFireId,
          rollbackSource.preferredSourceId,
          rollbackSource.contributionId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          operation_count: 0,
          active_fire_count: 1,
          source_count: 0,
          contribution_count: 0,
        },
      ],
    });
  });

  it("co-commits ammunition debit and recovery source across replay and final-receipt rollback", async () => {
    await pool.query(`DELETE FROM equipment WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
       VALUES ($1, 'weapon', 'shortbow', 1),
              ($1, 'arrows', 'bronze_arrow', 2)`,
      [PLAYER_ID],
    );
    const operationId = `ammunition-shot:${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const source = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "bronze_arrow",
      1,
      {
        position: { x: 72.5, y: 0.2, z: 72.5 },
        tile: { x: 72, z: 72 },
        droppedBy: PLAYER_ID,
      },
    );
    const request = ammunitionShotRequest(operationId, source);
    await expect(
      databaseSystem.commitAmmunitionShotOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: false,
      status: "pending",
      committed: expect.arrayContaining([
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 1 },
      ]),
      sourceRequest: source,
      source: null,
    });
    await expect(
      databaseSystem.completeAmmunitionShotOperationAsync({
        operationId,
        playerId: PLAYER_ID,
        requestFingerprint: request.requestFingerprint,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      status: "fired",
      source: { sourceId: source.preferredSourceId, replayed: false },
    });

    const replacement = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await replacement.init();
    await expectErrorChain(
      replacement.recoverPendingAmmunitionShotOperationsAsync(PLAYER_ID),
      "ammunition_shot_fired_reconciliation_required",
    );
    const changedCandidate = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "bronze_arrow",
      1,
      {
        position: source.position,
        tile: source.tile,
        droppedBy: PLAYER_ID,
      },
    );
    await expect(
      replacement.commitAmmunitionShotOperationAsync({
        ...request,
        source: changedCandidate,
      }),
    ).resolves.toMatchObject({
      replayed: true,
      status: "fired",
      sourceRequest: source,
      source: { sourceId: source.preferredSourceId, replayed: true },
    });
    await expect(
      replacement.getProjectileCostCustodyStatsAsync(),
    ).resolves.toMatchObject({
      pendingAmmunitionShots: 0,
      firedAmmunitionShots: 1,
      invalidOperations: 0,
      futureTimestampOperations: 0,
      oldestUnresolvedAgeMs: expect.any(Number),
    });
    await expect(
      pool.query(
        `SELECT count(*)::int AS index_count
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'idx_operations_log_projectile_cost_custody_unresolved'`,
      ),
    ).resolves.toMatchObject({ rows: [{ index_count: 1 }] });
    await expect(
      pool.query(
        `SELECT
           (SELECT quantity::int FROM equipment
             WHERE "playerId" = $1 AND "slotType" = 'arrows') AS arrow_count,
           (SELECT count(*)::int FROM operations_log WHERE id = $2) AS operation_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = $3) AS source_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = $4) AS changed_source_count`,
        [
          PLAYER_ID,
          operationId,
          source.preferredSourceId,
          changedCandidate.preferredSourceId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          arrow_count: 1,
          operation_count: 1,
          source_count: 1,
          changed_source_count: 0,
        },
      ],
    });

    await pool.query(
      `UPDATE equipment SET quantity = 2
       WHERE "playerId" = $1 AND "slotType" = 'arrows'`,
      [PLAYER_ID],
    );
    const rollbackOperationId = `ammunition-shot:${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const rollbackSource = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "bronze_arrow",
      1,
      {
        position: { x: 73.5, y: 0.2, z: 72.5 },
        tile: { x: 73, z: 72 },
        droppedBy: PLAYER_ID,
      },
    );
    const rollbackRequest = ammunitionShotRequest(
      rollbackOperationId,
      rollbackSource,
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_test_ammunition_shot_receipt()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."operationType" = 'ammunition_shot' THEN
          RAISE EXCEPTION 'forced_ammunition_shot_receipt_failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_ammunition_shot_receipt_trigger
      BEFORE INSERT ON operations_log
      FOR EACH ROW EXECUTE FUNCTION reject_test_ammunition_shot_receipt();
    `);
    try {
      await expectErrorChain(
        databaseSystem.commitAmmunitionShotOperationAsync(rollbackRequest),
        "forced_ammunition_shot_receipt_failure",
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_test_ammunition_shot_receipt_trigger
          ON operations_log;
        DROP FUNCTION IF EXISTS reject_test_ammunition_shot_receipt();
      `);
    }
    await expect(
      pool.query(
        `SELECT
           (SELECT quantity::int FROM equipment
             WHERE "playerId" = $1 AND "slotType" = 'arrows') AS arrow_count,
           (SELECT count(*)::int FROM operations_log WHERE id = $2) AS operation_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = $3) AS source_count,
           (SELECT count(*)::int FROM ground_item_source_contributions
             WHERE contribution_id = $4) AS contribution_count`,
        [
          PLAYER_ID,
          rollbackOperationId,
          rollbackSource.preferredSourceId,
          rollbackSource.contributionId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          arrow_count: 2,
          operation_count: 0,
          source_count: 0,
          contribution_count: 0,
        },
      ],
    });
  });

  it("fails replacement hydration on a fired rune cost without durable impact", async () => {
    await pool.query(`DELETE FROM inventory WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'air_rune', 10, 0), ($1, 'mind_rune', 5, 1)`,
      [PLAYER_ID],
    );
    const operationId = `spell-runes:${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const runeCost = projectileRuneCostRequest(operationId);
    await expect(
      databaseSystem.commitProjectileRuneCostOperationAsync(runeCost),
    ).resolves.toMatchObject({
      replayed: false,
      status: "pending",
      committed: [
        { itemId: "air_rune", quantity: 8, slotIndex: 0, metadata: null },
        { itemId: "mind_rune", quantity: 4, slotIndex: 1, metadata: null },
      ],
    });
    await expect(
      databaseSystem.completeProjectileRuneCostOperationAsync({
        operationId,
        playerId: PLAYER_ID,
        requestFingerprint: runeCost.requestFingerprint,
      }),
    ).resolves.toMatchObject({ replayed: false, status: "fired" });

    const replacement = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await replacement.init();
    await expectErrorChain(
      replacement.recoverPendingProjectileRuneCostOperationsAsync(PLAYER_ID),
      "projectile_rune_cost_fired_reconciliation_required",
    );
    await expect(
      replacement.commitProjectileRuneCostOperationAsync(runeCost),
    ).resolves.toMatchObject({ replayed: true, status: "fired" });
    await expect(
      replacement.getProjectileCostCustodyStatsAsync(),
    ).resolves.toMatchObject({
      pendingRuneCosts: 0,
      firedRuneCosts: 1,
      invalidOperations: 0,
      futureTimestampOperations: 0,
      oldestUnresolvedAgeMs: expect.any(Number),
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT quantity::int FROM inventory
             WHERE "playerId" = $1 AND "itemId" = 'air_rune') AS air_runes,
           (SELECT quantity::int FROM inventory
             WHERE "playerId" = $1 AND "itemId" = 'mind_rune') AS mind_runes,
           (SELECT count(*)::int FROM operations_log WHERE id = $2) AS operation_count`,
        [PLAYER_ID, operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ air_runes: 8, mind_runes: 4, operation_count: 1 }],
    });
  });

  it("commits coins once and rejects operation-payload collisions", async () => {
    const source = `ground_item_${randomUUID()}`;
    const operationId = `ground-item-pickup:${randomUUID()}`;
    await registerSource(databaseSystem, source, "coins", 25);
    const coinRequest = request(operationId, source, "coins", 25);
    await expect(
      databaseSystem.commitGroundItemPickupOperationAsync(coinRequest),
    ).resolves.toMatchObject({
      replayed: false,
      operationCommittedCoins: 150,
      currentCoins: 150,
    });
    await pool.query(`UPDATE characters SET coins = 160 WHERE id = $1`, [
      PLAYER_ID,
    ]);
    await expect(
      databaseSystem.commitGroundItemPickupOperationAsync(coinRequest),
    ).resolves.toMatchObject({
      replayed: true,
      operationCommittedCoins: 150,
      currentCoins: 160,
    });
    await expect(
      databaseSystem.commitGroundItemPickupOperationAsync(
        request(operationId, source, "coins", 24),
      ),
    ).rejects.toThrow("ground_item_pickup_operation_id_conflict");
    await expect(
      pool.query(
        `SELECT coins,
                (SELECT count(*)::int FROM operations_log WHERE id = $2) AS receipt_rows
         FROM characters WHERE id = $1`,
        [PLAYER_ID, operationId],
      ),
    ).resolves.toMatchObject({ rows: [{ coins: 160, receipt_rows: 1 }] });
  });

  it("replays merged contributions, hydrates only active truth, and retires it with the pickup", async () => {
    const source = `ground_item_${randomUUID()}`;
    const mergedPreferredSource = `ground_item_${randomUUID()}`;
    const position = { x: 20.5, y: 0.2, z: 20.5 };
    const tile = { x: 20, z: 20 };
    const first = sourceRegistrationRequest(source, "air_rune", 2, {
      position,
      tile,
    });
    const merged = sourceRegistrationRequest(
      mergedPreferredSource,
      "air_rune",
      3,
      { position, tile, allowMerge: true },
    );

    await expect(
      databaseSystem.registerGroundItemSourcesAsync([first, merged]),
    ).resolves.toEqual([
      expect.objectContaining({
        sourceId: source,
        replayed: false,
        quantity: 2,
        version: 1,
      }),
      expect.objectContaining({
        sourceId: source,
        replayed: false,
        quantity: 5,
        version: 2,
      }),
    ]);
    await expect(
      databaseSystem.registerGroundItemSourcesAsync([first, merged]),
    ).resolves.toEqual([
      expect.objectContaining({
        sourceId: source,
        replayed: true,
        quantity: 5,
        version: 2,
      }),
      expect.objectContaining({
        sourceId: source,
        replayed: true,
        quantity: 5,
        version: 2,
      }),
    ]);
    await expect(
      databaseSystem.listActiveGroundItemSourcesAsync(),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: source,
          status: "active",
          itemId: "air_rune",
          quantity: 5,
        }),
      ]),
    );

    const pickupOperation = `ground-item-pickup:${randomUUID()}`;
    await expect(
      databaseSystem.commitGroundItemPickupOperationAsync(
        request(pickupOperation, source, "air_rune", 5),
      ),
    ).resolves.toMatchObject({ replayed: false, quantity: 5 });
    expect(
      (await databaseSystem.listActiveGroundItemSourcesAsync()).some(
        (candidate) => candidate.sourceId === source,
      ),
    ).toBe(false);
    await expect(
      pool.query(
        `SELECT source.status,
                source."claimed_by_operation_id" AS claimed_operation,
                count(*)::int AS contribution_count
         FROM ground_item_sources AS source
         JOIN ground_item_source_contributions AS contribution
           ON contribution."source_id" = source."source_id"
         WHERE source."source_id" = $1
         GROUP BY source.status, source."claimed_by_operation_id"`,
        [source],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: "claimed",
          claimed_operation: pickupOperation,
          contribution_count: 2,
        },
      ],
    });
  });

  it("rolls back every source when a later batch contribution is invalid", async () => {
    const firstSource = `ground_item_${randomUUID()}`;
    const secondSource = `ground_item_${randomUUID()}`;
    const first = sourceRegistrationRequest(firstSource, "logs", 1, {
      position: { x: 30.5, y: 0.2, z: 30.5 },
      tile: { x: 30, z: 30 },
    });
    const second = {
      ...sourceRegistrationRequest(secondSource, "logs", 1, {
        position: { x: 31.5, y: 0.2, z: 31.5 },
        tile: { x: 31, z: 31 },
      }),
      requestFingerprint: "a".repeat(64),
    };

    await expect(
      databaseSystem.registerGroundItemSourcesAsync([first, second]),
    ).rejects.toThrow("ground_item_source_request_invalid");
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = ANY($1::text[])) AS source_count,
           (SELECT count(*)::int FROM ground_item_source_contributions
             WHERE source_id = ANY($1::text[])) AS contribution_count`,
        [[firstSource, secondSource]],
      ),
    ).resolves.toMatchObject({
      rows: [{ source_count: 0, contribution_count: 0 }],
    });
  });

  it("co-commits a manual slot debit and source exactly once across replacement replay", async () => {
    await pool.query(`DELETE FROM inventory WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'air_rune', 5, 3), ($1, 'mind_rune', 4, 4)`,
      [PLAYER_ID],
    );
    await pool.query(`UPDATE characters SET coins = 100 WHERE id = $1`, [
      PLAYER_ID,
    ]);
    const sourceId = `ground_item_${randomUUID()}`;
    const operationId = `ground-item-drop:${randomUUID()}`;
    const drop = groundDropRequest(operationId, sourceId, "air_rune", 2, 3);

    await expect(
      databaseSystem.commitGroundItemDropOperationAsync(drop),
    ).resolves.toMatchObject({
      replayed: false,
      operationCommittedCoins: null,
      currentCoins: 100,
      committed: [
        { itemId: "air_rune", quantity: 3, slotIndex: 3, metadata: null },
        { itemId: "mind_rune", quantity: 4, slotIndex: 4, metadata: null },
      ],
      source: {
        sourceId,
        contributionId: drop.source.contributionId,
        quantity: 2,
        replayed: false,
      },
    });

    await pool.query(`DELETE FROM inventory WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'mind_rune', 7, 8)`,
      [PLAYER_ID],
    );
    await pool.query(`UPDATE characters SET coins = 125 WHERE id = $1`, [
      PLAYER_ID,
    ]);
    const replacement = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await replacement.init();
    await expect(
      replacement.commitGroundItemDropOperationAsync(drop),
    ).resolves.toMatchObject({
      replayed: true,
      currentCoins: 125,
      committed: [
        { itemId: "mind_rune", quantity: 7, slotIndex: 8, metadata: null },
      ],
      source: { sourceId, quantity: 2, replayed: true },
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM operations_log WHERE id = $1) AS operation_count,
           (SELECT count(*)::int FROM ground_item_sources WHERE source_id = $2) AS source_count,
           (SELECT count(*)::int FROM ground_item_source_contributions
             WHERE contribution_id = $3) AS contribution_count`,
        [operationId, sourceId, drop.source.contributionId],
      ),
    ).resolves.toMatchObject({
      rows: [{ operation_count: 1, source_count: 1, contribution_count: 1 }],
    });
  });

  it("rolls back both debit and source when the final receipt insert fails", async () => {
    await pool.query(`DELETE FROM inventory WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'air_rune', 5, 3)`,
      [PLAYER_ID],
    );
    const sourceId = `ground_item_${randomUUID()}`;
    const operationId = `ground-item-drop:${randomUUID()}`;
    const drop = groundDropRequest(operationId, sourceId, "air_rune", 2, 3);

    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_test_ground_item_drop_receipt()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."operationType" = 'ground_item_drop' THEN
          RAISE EXCEPTION 'forced_ground_item_drop_receipt_failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_ground_item_drop_receipt_trigger
      BEFORE INSERT ON operations_log
      FOR EACH ROW EXECUTE FUNCTION reject_test_ground_item_drop_receipt();
    `);
    try {
      await expectErrorChain(
        databaseSystem.commitGroundItemDropOperationAsync(drop),
        "forced_ground_item_drop_receipt_failure",
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_test_ground_item_drop_receipt_trigger
          ON operations_log;
        DROP FUNCTION IF EXISTS reject_test_ground_item_drop_receipt();
      `);
    }
    await expect(
      pool.query(
        `SELECT
           (SELECT quantity::int FROM inventory
             WHERE "playerId" = $1 AND "itemId" = 'air_rune') AS air_runes,
           (SELECT count(*)::int FROM operations_log WHERE id = $2) AS operation_count,
           (SELECT count(*)::int FROM ground_item_sources WHERE source_id = $3) AS source_count,
           (SELECT count(*)::int FROM ground_item_source_contributions
             WHERE contribution_id = $4) AS contribution_count`,
        [PLAYER_ID, operationId, sourceId, drop.source.contributionId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          air_runes: 5,
          operation_count: 0,
          source_count: 0,
          contribution_count: 0,
        },
      ],
    });
  });

  it("co-commits coin debit and source without rewriting item inventory", async () => {
    await pool.query(`DELETE FROM inventory WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'mind_rune', 4, 4)`,
      [PLAYER_ID],
    );
    await pool.query(`UPDATE characters SET coins = 100 WHERE id = $1`, [
      PLAYER_ID,
    ]);
    const sourceId = `ground_item_${randomUUID()}`;
    const operationId = `ground-item-drop:${randomUUID()}`;
    const drop = groundDropRequest(operationId, sourceId, "coins", 25, null);

    await expect(
      databaseSystem.commitGroundItemDropOperationAsync(drop),
    ).resolves.toMatchObject({
      replayed: false,
      operationCommittedCoins: 75,
      currentCoins: 75,
      committed: [
        { itemId: "mind_rune", quantity: 4, slotIndex: 4, metadata: null },
      ],
      source: { sourceId, itemId: "coins", quantity: 25 },
    });
    await expect(
      pool.query(
        `SELECT characters.coins,
                inventory.quantity::int AS mind_runes,
                source.quantity::int AS source_coins
         FROM characters
         JOIN inventory ON inventory."playerId" = characters.id
         JOIN ground_item_sources AS source ON source.source_id = $2
         WHERE characters.id = $1 AND inventory."itemId" = 'mind_rune'`,
        [PLAYER_ID, sourceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ coins: 75, mind_runes: 4, source_coins: 25 }],
    });
  });

  it("co-commits public death custody and rolls every side effect back when the receipt fails", async () => {
    await pool.query(`DELETE FROM player_deaths WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(`DELETE FROM inventory WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(`DELETE FROM equipment WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'air_rune', 5, 3)`,
      [PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
       VALUES ($1, 'weapon', 'logs', 1)`,
      [PLAYER_ID],
    );
    const firstSource = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "air_rune",
      5,
      {
        position: { x: 50.5, y: 0.2, z: 50.5 },
        tile: { x: 50, z: 50 },
        droppedBy: PLAYER_ID,
        lootProtectionMs: 60_000,
      },
    );
    const secondSource = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "logs",
      1,
      {
        position: { x: 51.5, y: 0.2, z: 50.5 },
        tile: { x: 51, z: 50 },
        droppedBy: PLAYER_ID,
        lootProtectionMs: 60_000,
      },
    );
    const operationId = `ground-item-death:${randomUUID()}`;
    const death = groundDeathRequest(operationId, [firstSource, secondSource]);

    await expect(
      databaseSystem.commitGroundItemDeathOperationAsync(death),
    ).resolves.toMatchObject({
      replayed: false,
      dropped: [
        { itemId: "air_rune", quantity: 5 },
        { itemId: "logs", quantity: 1 },
      ],
      sources: [{ replayed: false }, { replayed: false }],
    });
    const replacement = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await replacement.init();
    await expect(
      replacement.commitGroundItemDeathOperationAsync(death),
    ).resolves.toMatchObject({
      replayed: true,
      sources: [{ replayed: true }, { replayed: true }],
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM inventory WHERE "playerId" = $1) AS inventory_count,
           (SELECT count(*)::int FROM equipment WHERE "playerId" = $1) AS equipment_count,
           (SELECT count(*)::int FROM operations_log WHERE id = $2) AS operation_count,
           (SELECT count(*)::int FROM player_deaths
             WHERE "playerId" = $1 AND "deathOperationId" = $2) AS death_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = ANY($3::text[])) AS source_count,
           (SELECT count(*)::int FROM ground_item_source_contributions
             WHERE contribution_id = ANY($4::text[])) AS contribution_count`,
        [
          PLAYER_ID,
          operationId,
          [firstSource.preferredSourceId, secondSource.preferredSourceId],
          [firstSource.contributionId, secondSource.contributionId],
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          inventory_count: 0,
          equipment_count: 0,
          operation_count: 1,
          death_count: 1,
          source_count: 2,
          contribution_count: 2,
        },
      ],
    });

    await pool.query(`DELETE FROM player_deaths WHERE "playerId" = $1`, [
      PLAYER_ID,
    ]);
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'air_rune', 3, 4)`,
      [PLAYER_ID],
    );
    const rollbackSource = sourceRegistrationRequest(
      `ground_item_${randomUUID()}`,
      "air_rune",
      3,
      {
        position: { x: 52.5, y: 0.2, z: 50.5 },
        tile: { x: 52, z: 50 },
        droppedBy: PLAYER_ID,
        lootProtectionMs: 60_000,
      },
    );
    const rollbackOperationId = `ground-item-death:${randomUUID()}`;
    const rollbackDeath = groundDeathRequest(rollbackOperationId, [
      rollbackSource,
    ]);
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_test_ground_item_death_receipt()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."operationType" = 'ground_item_death' THEN
          RAISE EXCEPTION 'forced_ground_item_death_receipt_failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_ground_item_death_receipt_trigger
      BEFORE INSERT ON operations_log
      FOR EACH ROW EXECUTE FUNCTION reject_test_ground_item_death_receipt();
    `);
    try {
      await expectErrorChain(
        databaseSystem.commitGroundItemDeathOperationAsync(rollbackDeath),
        "forced_ground_item_death_receipt_failure",
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_test_ground_item_death_receipt_trigger
          ON operations_log;
        DROP FUNCTION IF EXISTS reject_test_ground_item_death_receipt();
      `);
    }
    await expect(
      pool.query(
        `SELECT
           (SELECT quantity::int FROM inventory
             WHERE "playerId" = $1 AND "itemId" = 'air_rune') AS air_runes,
           (SELECT count(*)::int FROM operations_log WHERE id = $2) AS operation_count,
           (SELECT count(*)::int FROM player_deaths
             WHERE "playerId" = $1) AS death_count,
           (SELECT count(*)::int FROM ground_item_sources
             WHERE source_id = $3) AS source_count,
           (SELECT count(*)::int FROM ground_item_source_contributions
             WHERE contribution_id = $4) AS contribution_count`,
        [
          PLAYER_ID,
          rollbackOperationId,
          rollbackSource.preferredSourceId,
          rollbackSource.contributionId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          air_runes: 3,
          operation_count: 0,
          death_count: 0,
          source_count: 0,
          contribution_count: 0,
        },
      ],
    });
  });
});
