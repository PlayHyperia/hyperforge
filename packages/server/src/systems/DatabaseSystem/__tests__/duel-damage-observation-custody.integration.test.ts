import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type {
  StreamingDuelDamageObservationContext,
  World,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresClientDatabase } from "../../../database/postgres-transaction.js";
import * as schema from "../../../database/schema.js";
import type { StreamingDuelActionObservationDraft } from "../../StreamingDuelScheduler/public-action-observation-buffer.js";
import { PostgresDuelPreparationStore } from "../../StreamingDuelScheduler/preparation.js";
import { MatchmakingManager } from "../../StreamingDuelScheduler/managers/MatchmakingManager.js";
import {
  PostgresStreamingDuelActionObservationStore,
  StreamingDuelActionObservationLedger,
  type StreamingDuelActionObservationPool,
} from "../../StreamingDuelScheduler/public-action-observation-ledger.js";
import { DatabaseSystem } from "../index.js";
import { seedCompetitiveDamageFixture } from "./competitive-damage-fixture.js";

const baseDatabaseUrl =
  process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ?? "";
const describeDatabase = baseDatabaseUrl ? describe.sequential : describe.skip;

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

function attackStyleFor(
  observation: StreamingDuelDamageObservationContext,
): string {
  return observation.combatRole === "ranged"
    ? "ranged"
    : observation.combatRole === "mage"
      ? "magic"
      : "aggressive";
}

function fingerprint(
  attackerId: string,
  targetPlayerId: string,
  requestedDamage: number,
  observation: StreamingDuelDamageObservationContext,
  competitiveAuthority?: {
    preparationId: string;
    fencingToken: string;
    snapshotDigest: string;
  },
  projectileCost?: {
    operationType: "ammunition_shot" | "projectile_rune_cost";
    operationId: string;
    playerId: string;
    requestFingerprint: string;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        attackerId,
        targetPlayerId,
        requestedDamage,
        attackStyle: attackStyleFor(observation),
        publicActionObservation: observation,
        ...(competitiveAuthority ? { competitiveAuthority } : {}),
        ...(projectileCost ? { projectileCost } : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

describeDatabase("duel damage custody and atomic public observation", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseSystem: DatabaseSystem;
  const attackerId = "damage-observation-attacker";
  const targetPlayerId = "damage-observation-target";

  beforeAll(async () => {
    databaseName = `hyperia_damage_${process.pid}_${Date.now().toString(36)}`;
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
    await db.insert(schema.users).values([
      {
        id: "damage-attacker-account",
        name: "Damage Attacker Account",
        roles: "user",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
      {
        id: "damage-target-account",
        name: "Damage Target Account",
        roles: "user",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    ]);
    await db.insert(schema.characters).values([
      {
        id: attackerId,
        accountId: "damage-attacker-account",
        name: "Damage Observation Attacker",
        isAgent: 1,
        health: 30,
        maxHealth: 30,
      },
      {
        id: targetPlayerId,
        accountId: "damage-target-account",
        name: "Damage Observation Target",
        isAgent: 1,
        health: 25,
        maxHealth: 25,
      },
    ]);
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

  it("co-commits target health, the idempotency receipt, and one exact hit", async () => {
    const observation = {
      operationId: randomUUID(),
      tick: 14,
      observedAt: 1_800_000_000_314,
      cycleId: "cycle-damage-atomic",
      duelId: "duel-damage-atomic",
      actorId: attackerId,
      opponentId: targetPlayerId,
      phase: "FIGHTING",
      combatRole: "ranged",
      tacticalMacro: "kite",
      requestedDamage: 9,
    } satisfies StreamingDuelDamageObservationContext;
    const request = {
      operationId: observation.operationId,
      attackerId,
      targetPlayerId,
      requestedDamage: observation.requestedDamage,
      attackStyle: attackStyleFor(observation),
      publicActionObservation: observation,
      requestFingerprint: fingerprint(
        attackerId,
        targetPlayerId,
        observation.requestedDamage,
        observation,
      ),
    };

    await expect(
      databaseSystem.commitDuelDamageOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: false,
      appliedDamage: 9,
      healthBefore: 25,
      healthAfter: 16,
      targetDied: false,
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT health FROM characters WHERE id = $1) AS health,
           (SELECT count(*)::int FROM operations_log WHERE id = $2 AND completed = true) AS receipt_rows,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "operationId" = $2) AS observation_rows`,
        [targetPlayerId, observation.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ health: 16, receipt_rows: 1, observation_rows: 1 }],
    });

    const store = new PostgresStreamingDuelActionObservationStore(
      pool as unknown as StreamingDuelActionObservationPool,
    );
    const replacementLedger = new StreamingDuelActionObservationLedger(store, {
      retryDelay: async () => {},
    });
    replacementLedger.activateCycle(observation.cycleId);
    await replacementLedger.waitForIdle();
    expect(replacementLedger.getSnapshot(observation.cycleId)).toEqual([
      expect.objectContaining({
        sequence: 1,
        action: "damage",
        outcome: "committed",
        value: "hit",
        amount: 9,
        actorId: attackerId,
      }),
    ]);

    const delayedDraft = {
      tick: observation.tick,
      cycleId: observation.cycleId,
      duelId: observation.duelId,
      actorId: observation.actorId,
      opponentId: observation.opponentId,
      phase: observation.phase,
      combatRole: observation.combatRole,
      tacticalMacro: observation.tacticalMacro,
      action: "damage",
      outcome: "committed",
      value: "hit",
      amount: 9,
    } satisfies StreamingDuelActionObservationDraft;
    expect(
      replacementLedger.record(delayedDraft, {
        operationId: observation.operationId,
        observedAt: observation.observedAt,
      }),
    ).toBe(true);
    await replacementLedger.waitForIdle();
    expect(replacementLedger.getSnapshot(observation.cycleId)).toHaveLength(1);

    await expect(
      databaseSystem.commitDuelDamageOperationAsync(request),
    ).resolves.toMatchObject({ replayed: true, healthAfter: 16 });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM streaming_duel_action_observations WHERE "operationId" = $1`,
        [observation.operationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const invalidObservation = {
      ...observation,
      operationId: randomUUID(),
      actorId: "wrong-attacker",
    } satisfies StreamingDuelDamageObservationContext;
    await expect(
      databaseSystem.commitDuelDamageOperationAsync({
        ...request,
        operationId: invalidObservation.operationId,
        publicActionObservation: invalidObservation,
        requestFingerprint: fingerprint(
          attackerId,
          targetPlayerId,
          invalidObservation.requestedDamage,
          invalidObservation,
        ),
      }),
    ).rejects.toThrow("duel_damage_request_invalid");

    const missingObservation = {
      ...observation,
      operationId: randomUUID(),
      tick: observation.tick + 1,
      observedAt: observation.observedAt + 1,
      requestedDamage: 5,
    } satisfies StreamingDuelDamageObservationContext;
    const missingRequest = {
      ...request,
      operationId: missingObservation.operationId,
      requestedDamage: missingObservation.requestedDamage,
      publicActionObservation: missingObservation,
      requestFingerprint: fingerprint(
        attackerId,
        targetPlayerId,
        missingObservation.requestedDamage,
        missingObservation,
      ),
    };
    await pool.query(
      `INSERT INTO operations_log (
         id, "playerId", "operationType", "operationState", completed,
         timestamp, "completedAt"
       ) VALUES ($1, $2, 'duel_damage', $3::jsonb, true, $4, $4)`,
      [
        missingRequest.operationId,
        targetPlayerId,
        JSON.stringify({
          version: 2,
          requestFingerprint: missingRequest.requestFingerprint,
          attackerId,
          attackStyle: missingRequest.attackStyle,
          requestedDamage: 5,
          appliedDamage: 5,
          healthBefore: 16,
          healthAfter: 11,
          publicActionObservation: missingObservation,
          competitiveTerminal: null,
          xpDamageAuthority: null,
          combatProgress: [],
        }),
        Date.now(),
      ],
    );
    await expect(
      databaseSystem.commitDuelDamageOperationAsync(missingRequest),
    ).rejects.toThrow("streaming_duel_public_observation_conflict");
  });

  it("records no public hit from an already-dead attacker", async () => {
    await pool.query(`UPDATE characters SET health = 0 WHERE id = $1`, [
      attackerId,
    ]);
    const observation = {
      operationId: randomUUID(),
      tick: 15,
      observedAt: 1_800_000_000_315,
      cycleId: "cycle-damage-postmortem",
      duelId: "duel-damage-postmortem",
      actorId: attackerId,
      opponentId: targetPlayerId,
      phase: "FIGHTING",
      combatRole: "melee",
      tacticalMacro: "finish",
      requestedDamage: 5,
    } satisfies StreamingDuelDamageObservationContext;
    const request = {
      operationId: observation.operationId,
      attackerId,
      targetPlayerId,
      requestedDamage: observation.requestedDamage,
      attackStyle: attackStyleFor(observation),
      publicActionObservation: observation,
      requestFingerprint: fingerprint(
        attackerId,
        targetPlayerId,
        observation.requestedDamage,
        observation,
      ),
    };
    await expect(
      databaseSystem.commitDuelDamageOperationAsync(request),
    ).resolves.toMatchObject({ appliedDamage: 0, targetDied: false });
    await expect(
      pool.query(
        `SELECT
           (SELECT health FROM characters WHERE id = $1) AS health,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "operationId" = $2) AS observation_rows`,
        [targetPlayerId, observation.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ health: 16, observation_rows: 0 }],
    });
  });

  it("co-commits a lethal hit with exact competitive terminal and transition truth", async () => {
    const lethalAttackerId = "damage-terminal-attacker";
    const lethalTargetId = "damage-terminal-target";
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent", health, "maxHealth")
       VALUES ($1, 'damage-attacker-account', 'Terminal Attacker', 1, 12, 12),
              ($2, 'damage-target-account', 'Terminal Target', 1, 7, 7)`,
      [lethalAttackerId, lethalTargetId],
    );
    const preparationId = randomUUID();
    const fencingToken = "87";
    const frozenAt = 1_800_000_100_000;
    const duelStartedAt = frozenAt + 5_000;
    const cycleId = "cycle-damage-terminal";
    const duelId = "duel-damage-terminal";
    const { snapshotDigest } = await seedCompetitiveDamageFixture(pool, {
      preparationId,
      fencingToken,
      cycleId,
      duelId,
      duelKey: "71".repeat(32),
      agent1Id: lethalAttackerId,
      agent2Id: lethalTargetId,
      agent1Name: "Terminal Attacker",
      agent2Name: "Terminal Target",
      agent1MaxHp: 12,
      agent2MaxHp: 7,
      frozenAt,
      duelStartedAt,
    });
    const competitiveAuthority = {
      preparationId,
      fencingToken,
      snapshotDigest,
    };
    const observation = {
      operationId: randomUUID(),
      tick: 21,
      observedAt: duelStartedAt + 25,
      cycleId,
      duelId,
      actorId: lethalAttackerId,
      opponentId: lethalTargetId,
      phase: "FIGHTING",
      combatRole: "melee",
      tacticalMacro: "finish",
      requestedDamage: 9,
    } satisfies StreamingDuelDamageObservationContext;
    const request = {
      operationId: observation.operationId,
      attackerId: lethalAttackerId,
      targetPlayerId: lethalTargetId,
      requestedDamage: observation.requestedDamage,
      attackStyle: attackStyleFor(observation),
      publicActionObservation: observation,
      competitiveAuthority,
      requestFingerprint: fingerprint(
        lethalAttackerId,
        lethalTargetId,
        observation.requestedDamage,
        observation,
        competitiveAuthority,
      ),
    };

    const receipt =
      await databaseSystem.commitDuelDamageOperationAsync(request);
    expect(receipt).toMatchObject({
      replayed: false,
      appliedDamage: 7,
      healthBefore: 7,
      healthAfter: 0,
      targetDied: true,
      xpDamageAuthority: 7,
      combatProgress: [
        {
          skill: "strength",
          xpAmount: 28,
          awardedXp: 28,
          operationCommittedXp: 28,
          currentXp: 28,
          currentLevel: 1,
        },
        {
          skill: "constitution",
          xpAmount: 9,
          awardedXp: 9,
          operationCommittedXp: 1_163,
          currentXp: 1_163,
          currentLevel: 10,
        },
      ],
      competitiveTerminal: {
        outcome: "win",
        winnerId: lethalAttackerId,
        loserId: lethalTargetId,
        winReason: "kill",
        terminalAt: observation.observedAt,
        seed: expect.stringMatching(/^(0|[1-9][0-9]{0,19})$/),
        replayHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    await expect(
      pool.query(
        `SELECT
           (SELECT health FROM characters WHERE id = $1) AS health,
           (SELECT count(*)::int FROM operations_log WHERE id = $2 AND completed = true) AS receipt_rows,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "operationId" = $2) AS observation_rows,
           (SELECT "lifecycleStatus" FROM streaming_duel_competitive_snapshots WHERE "preparationId" = $3) AS lifecycle_status,
           (SELECT "terminalWinnerId" FROM streaming_duel_competitive_snapshots WHERE "preparationId" = $3) AS winner_id,
           (SELECT "strengthXp" FROM characters WHERE id = $4) AS strength_xp,
           (SELECT "constitutionXp" FROM characters WHERE id = $4) AS constitution_xp,
           (SELECT count(*)::int FROM streaming_duel_transition_events WHERE "eventKey" = $3 || ':terminal_committed') AS terminal_events`,
        [
          lethalTargetId,
          observation.operationId,
          preparationId,
          lethalAttackerId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          health: 0,
          receipt_rows: 1,
          observation_rows: 1,
          lifecycle_status: "terminal",
          winner_id: lethalAttackerId,
          strength_xp: 28,
          constitution_xp: 1_163,
          terminal_events: 1,
        },
      ],
    });

    const replacementStore = new PostgresDuelPreparationStore(pool);
    await expect(
      replacementStore.getCompetitiveSnapshot(preparationId),
    ).resolves.toMatchObject({
      lifecycleStatus: "terminal",
      terminal: {
        outcome: "win",
        winnerId: lethalAttackerId,
        winReason: "kill",
        terminalAt: observation.observedAt,
        seed: receipt.competitiveTerminal?.seed,
        replayHash: receipt.competitiveTerminal?.replayHash,
      },
    });
    await expect(
      databaseSystem.commitDuelDamageOperationAsync(request),
    ).resolves.toEqual({ ...receipt, replayed: true });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "operationId" = $1) AS observation_rows,
           (SELECT count(*)::int FROM streaming_duel_transition_events WHERE "eventKey" = $2 || ':terminal_committed') AS terminal_events`,
        [observation.operationId, preparationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ observation_rows: 1, terminal_events: 1 }],
    });

    await pool.query(
      `DELETE FROM streaming_duel_history WHERE "cycleId" = $1`,
      [cycleId],
    );
    const replacementHistory = new MatchmakingManager(
      {} as World,
      () => databaseSystem.getDb() as never,
      {
        minAgents: 2,
        maxRecentDuels: 8,
        persistStatsToDatabase: false,
        maxAgentStats: 16,
        insufficientAgentsRetryInterval: 30_000,
        maxInsufficientAgentWarnings: 5,
      },
    );
    await expect(
      replacementHistory.hydrateRecentDuelsFromDatabase(),
    ).resolves.toBe(1);
    expect(
      replacementHistory.getOpponentHistory(lethalAttackerId, lethalTargetId),
    ).toEqual([
      {
        cycleId,
        finishedAt: observation.observedAt,
        result: "win",
        ownOpeningStyle: "melee",
        opponentOpeningStyle: "melee",
        ownDamage: 7,
        opponentDamage: 0,
        winReason: "kill",
      },
    ]);

    await pool.query(
      `ALTER TABLE streaming_duel_transition_events DISABLE TRIGGER USER`,
    );
    try {
      await pool.query(
        `DELETE FROM streaming_duel_transition_events WHERE "eventKey" = $1 || ':terminal_committed'`,
        [preparationId],
      );
    } finally {
      await pool.query(
        `ALTER TABLE streaming_duel_transition_events ENABLE TRIGGER USER`,
      );
    }
    await expect(
      databaseSystem.commitDuelDamageOperationAsync(request),
    ).rejects.toThrow("duel_damage_competitive_terminal_event_missing");
  });

  it("rolls lethal health, progression, action, and terminal truth back together on a late failure", async () => {
    const suffix = randomUUID();
    const rollbackAttackerId = `damage-rollback-attacker-${suffix}`;
    const rollbackTargetId = `damage-rollback-target-${suffix}`;
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent", health, "maxHealth")
       VALUES ($1, 'damage-attacker-account', 'Rollback Attacker', 1, 12, 12),
              ($2, 'damage-target-account', 'Rollback Target', 1, 7, 7)`,
      [rollbackAttackerId, rollbackTargetId],
    );
    const preparationId = randomUUID();
    const fencingToken = "91";
    const frozenAt = 1_800_000_200_000;
    const duelStartedAt = frozenAt + 5_000;
    const cycleId = `cycle-damage-rollback-${suffix}`;
    const duelId = `duel-damage-rollback-${suffix}`;
    const { snapshotDigest } = await seedCompetitiveDamageFixture(pool, {
      preparationId,
      fencingToken,
      cycleId,
      duelId,
      duelKey: "72".repeat(32),
      agent1Id: rollbackAttackerId,
      agent2Id: rollbackTargetId,
      agent1Name: "Rollback Attacker",
      agent2Name: "Rollback Target",
      agent1MaxHp: 12,
      agent2MaxHp: 7,
      frozenAt,
      duelStartedAt,
    });
    const competitiveAuthority = {
      preparationId,
      fencingToken,
      snapshotDigest,
    };
    const observation = {
      operationId: randomUUID(),
      tick: 22,
      observedAt: duelStartedAt + 25,
      cycleId,
      duelId,
      actorId: rollbackAttackerId,
      opponentId: rollbackTargetId,
      phase: "FIGHTING",
      combatRole: "melee",
      tacticalMacro: "finish",
      requestedDamage: 9,
    } satisfies StreamingDuelDamageObservationContext;
    const request = {
      operationId: observation.operationId,
      attackerId: rollbackAttackerId,
      targetPlayerId: rollbackTargetId,
      requestedDamage: observation.requestedDamage,
      attackStyle: attackStyleFor(observation),
      publicActionObservation: observation,
      competitiveAuthority,
      requestFingerprint: fingerprint(
        rollbackAttackerId,
        rollbackTargetId,
        observation.requestedDamage,
        observation,
        competitiveAuthority,
      ),
    };

    await pool.query(`
      CREATE FUNCTION reject_duel_terminal_stats_for_test()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced_duel_terminal_stat_failure';
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER reject_duel_terminal_stats_for_test
      BEFORE INSERT OR UPDATE ON player_combat_stats
      FOR EACH ROW EXECUTE FUNCTION reject_duel_terminal_stats_for_test()
    `);
    try {
      await expectErrorChain(
        databaseSystem.commitDuelDamageOperationAsync(request),
        "forced_duel_terminal_stat_failure",
      );
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS reject_duel_terminal_stats_for_test ON player_combat_stats`,
      );
      await pool.query(
        `DROP FUNCTION IF EXISTS reject_duel_terminal_stats_for_test()`,
      );
    }

    await expect(
      pool.query(
        `SELECT
           (SELECT health FROM characters WHERE id = $1) AS target_health,
           (SELECT "strengthXp" FROM characters WHERE id = $2) AS strength_xp,
           (SELECT "constitutionXp" FROM characters WHERE id = $2) AS constitution_xp,
           (SELECT count(*)::int FROM operations_log WHERE id = $3) AS receipt_rows,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "operationId" = $3) AS observation_rows,
           (SELECT "lifecycleStatus" FROM streaming_duel_competitive_snapshots WHERE "preparationId" = $4) AS lifecycle_status,
           (SELECT count(*)::int FROM streaming_duel_transition_events WHERE "eventKey" = $4 || ':terminal_committed') AS terminal_events`,
        [
          rollbackTargetId,
          rollbackAttackerId,
          observation.operationId,
          preparationId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          target_health: 7,
          strength_xp: 0,
          constitution_xp: 1_154,
          receipt_rows: 0,
          observation_rows: 0,
          lifecycle_status: "frozen",
          terminal_events: 0,
        },
      ],
    });
  });

  it("co-commits an exact fired projectile cost with its durable hit", async () => {
    const suffix = randomUUID();
    const projectileAttackerId = `projectile-attacker-${suffix}`;
    const projectileTargetId = `projectile-target-${suffix}`;
    const attackerAccountId = `projectile-attacker-account-${suffix}`;
    const targetAccountId = `projectile-target-account-${suffix}`;
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt") VALUES
         ($1, 'Projectile Attacker', 'user', '2026-08-30T00:00:00.000Z'),
         ($2, 'Projectile Target', 'user', '2026-08-30T00:00:00.000Z')`,
      [attackerAccountId, targetAccountId],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent", health, "maxHealth") VALUES
         ($1, $2, 'Projectile Attacker', 1, 30, 30),
         ($3, $4, 'Projectile Target', 1, 25, 25)`,
      [
        projectileAttackerId,
        attackerAccountId,
        projectileTargetId,
        targetAccountId,
      ],
    );
    const projectileCost = {
      operationType: "projectile_rune_cost" as const,
      operationId: "spell-runes:1234567890abcdefghij",
      playerId: projectileAttackerId,
      requestFingerprint: "ab".repeat(32),
    };
    await pool.query(
      `INSERT INTO operations_log
         (id, "playerId", "operationType", "operationState", completed, timestamp, "completedAt")
       VALUES ($1, $2, $3, $4::jsonb, true, $5, $5)`,
      [
        projectileCost.operationId,
        projectileCost.playerId,
        projectileCost.operationType,
        JSON.stringify({
          version: 1,
          requestFingerprint: projectileCost.requestFingerprint,
          requirements: [
            { itemId: "air_rune", quantity: 1 },
            { itemId: "mind_rune", quantity: 1 },
          ],
          committed: [],
          status: "fired",
          refundDestination: null,
        }),
        1_800_000_000_700,
      ],
    );
    const observation = {
      operationId: randomUUID(),
      tick: 31,
      observedAt: 1_800_000_000_731,
      cycleId: `cycle-projectile-${suffix}`,
      duelId: `duel-projectile-${suffix}`,
      actorId: projectileAttackerId,
      opponentId: projectileTargetId,
      phase: "FIGHTING",
      combatRole: "mage",
      tacticalMacro: "kite",
      requestedDamage: 7,
    } satisfies StreamingDuelDamageObservationContext;
    const request = {
      operationId: observation.operationId,
      attackerId: projectileAttackerId,
      targetPlayerId: projectileTargetId,
      requestedDamage: observation.requestedDamage,
      attackStyle: attackStyleFor(observation),
      publicActionObservation: observation,
      projectileCost,
      requestFingerprint: fingerprint(
        projectileAttackerId,
        projectileTargetId,
        observation.requestedDamage,
        observation,
        undefined,
        projectileCost,
      ),
    };

    await expect(
      databaseSystem.commitDuelDamageOperationAsync(request),
    ).resolves.toMatchObject({
      replayed: false,
      appliedDamage: 7,
      healthAfter: 18,
    });
    await expect(
      databaseSystem.commitDuelDamageOperationAsync(request),
    ).resolves.toMatchObject({ replayed: true, appliedDamage: 7 });
    const conflictingObservation = {
      ...observation,
      operationId: randomUUID(),
      tick: observation.tick + 1,
      observedAt: observation.observedAt + 1,
    };
    await expect(
      databaseSystem.commitDuelDamageOperationAsync({
        ...request,
        operationId: conflictingObservation.operationId,
        publicActionObservation: conflictingObservation,
        requestFingerprint: fingerprint(
          projectileAttackerId,
          projectileTargetId,
          conflictingObservation.requestedDamage,
          conflictingObservation,
          undefined,
          projectileCost,
        ),
      }),
    ).rejects.toThrow("duel_damage_projectile_cost_invalid");
    await expect(
      pool.query(
        `SELECT
           (SELECT "operationState"->>'status' FROM operations_log WHERE id = $1) AS cost_status,
           (SELECT "operationState"->>'damageOperationId' FROM operations_log WHERE id = $1) AS damage_operation_id,
           (SELECT "operationState"->'projectileCost'->>'operationId' FROM operations_log WHERE id = $2) AS receipt_cost_operation_id,
           (SELECT health FROM characters WHERE id = $3) AS health`,
        [
          projectileCost.operationId,
          observation.operationId,
          projectileTargetId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          cost_status: "resolved",
          damage_operation_id: observation.operationId,
          receipt_cost_operation_id: projectileCost.operationId,
          health: 18,
        },
      ],
    });
  });

  it("serializes simultaneous lethal hits without a postmortem counter-hit", async () => {
    const leftId = "damage-simultaneous-left";
    const rightId = "damage-simultaneous-right";
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent", health, "maxHealth")
       VALUES ($1, 'damage-attacker-account', 'Damage Left', 1, 5, 5),
              ($2, 'damage-target-account', 'Damage Right', 1, 5, 5)`,
      [leftId, rightId],
    );
    const preparationId = randomUUID();
    const fencingToken = "113";
    const cycleId = "cycle-damage-simultaneous";
    const duelId = "duel-damage-simultaneous";
    const { snapshotDigest } = await seedCompetitiveDamageFixture(pool, {
      preparationId,
      fencingToken,
      cycleId,
      duelId,
      duelKey: "95".repeat(32),
      agent1Id: leftId,
      agent2Id: rightId,
      agent1Name: "Damage Left",
      agent2Name: "Damage Right",
      agent1MaxHp: 5,
      agent2MaxHp: 5,
      frozenAt: 1_800_000_000_000,
      duelStartedAt: 1_800_000_000_100,
    });
    const competitiveAuthority = {
      preparationId,
      fencingToken,
      snapshotDigest,
    };
    const makeRequest = (actorId: string, opponentId: string, tick: number) => {
      const observation = {
        operationId: randomUUID(),
        tick,
        observedAt: 1_800_000_000_400 + tick,
        cycleId,
        duelId,
        actorId,
        opponentId,
        phase: "FIGHTING",
        combatRole: "melee",
        tacticalMacro: "finish",
        requestedDamage: 5,
      } satisfies StreamingDuelDamageObservationContext;
      return {
        operationId: observation.operationId,
        attackerId: actorId,
        targetPlayerId: opponentId,
        requestedDamage: 5,
        attackStyle: attackStyleFor(observation),
        publicActionObservation: observation,
        competitiveAuthority,
        requestFingerprint: fingerprint(
          actorId,
          opponentId,
          5,
          observation,
          competitiveAuthority,
        ),
      };
    };
    const secondDatabaseSystem = new DatabaseSystem({
      drizzleDb: drizzle(pool, { schema }),
      pgPool: pool,
    } as never);
    await secondDatabaseSystem.init();

    const receipts = await Promise.all([
      databaseSystem.commitDuelDamageOperationAsync(
        makeRequest(leftId, rightId, 20),
      ),
      secondDatabaseSystem.commitDuelDamageOperationAsync(
        makeRequest(rightId, leftId, 20),
      ),
    ]);
    expect(receipts.map(({ appliedDamage }) => appliedDamage).sort()).toEqual([
      0, 5,
    ]);
    expect(
      receipts.filter(({ competitiveTerminal }) => competitiveTerminal),
    ).toEqual([
      expect.objectContaining({
        targetDied: true,
        competitiveTerminal: expect.objectContaining({
          outcome: "win",
          winReason: "kill",
        }),
      }),
    ]);
    await expect(
      pool.query(
        `SELECT
           (SELECT array_agg(health ORDER BY id) FROM characters WHERE id IN ($1, $2)) AS health,
           (SELECT count(*)::int FROM streaming_duel_action_observations WHERE "cycleId" = $3) AS observation_rows,
           (SELECT count(*)::int FROM streaming_duel_transition_events WHERE "eventKey" = $4 || ':terminal_committed') AS terminal_events,
           (SELECT "lifecycleStatus" FROM streaming_duel_competitive_snapshots WHERE "preparationId" = $4) AS lifecycle_status`,
        [leftId, rightId, cycleId, preparationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          health: expect.arrayContaining([0, 5]),
          observation_rows: 1,
          terminal_events: 1,
          lifecycle_status: "terminal",
        },
      ],
    });
  });
});
