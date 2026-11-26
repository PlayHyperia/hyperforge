import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  StreamingDuelDamageObservationContext,
  World,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";
import { seedCompetitiveDamageFixture } from "../src/systems/DatabaseSystem/__tests__/competitive-damage-fixture.js";
import { MatchmakingManager } from "../src/systems/StreamingDuelScheduler/managers/MatchmakingManager.js";
import type { StreamingDuelActionObservationDraft } from "../src/systems/StreamingDuelScheduler/public-action-observation-buffer.js";
import { PostgresDuelPreparationStore } from "../src/systems/StreamingDuelScheduler/preparation.js";
import {
  PostgresStreamingDuelActionObservationStore,
  StreamingDuelActionObservationLedger,
  type StreamingDuelActionObservationPool,
} from "../src/systems/StreamingDuelScheduler/public-action-observation-ledger.js";

const CHILD_MODE = "--authority-child";
const CHILD_DATABASE_URL = "DUEL_DAMAGE_KILL_DATABASE_URL";
const CHILD_CONTEXT = "DUEL_DAMAGE_KILL_CONTEXT";
const ATTACKER_ID = "duel-damage-kill-attacker";
const TARGET_ID = "duel-damage-kill-target";
const execFileAsync = promisify(execFile);

type ChildContext = {
  observation: StreamingDuelDamageObservationContext;
  competitiveAuthority: {
    preparationId: string;
    fencingToken: string;
    snapshotDigest: string;
  };
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function docker(args: string[]): Promise<string> {
  const result = await execFileAsync(
    process.env.DOCKER_BIN?.trim() || "docker",
    args,
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return result.stdout.trim();
}

async function resolveDatabaseAuthority(): Promise<{
  baseDatabaseUrl: string;
  ownedContainerName: string | null;
}> {
  const configured =
    process.env.DUEL_DAMAGE_OBSERVATION_TEST_DATABASE_URL?.trim();
  if (configured) {
    return { baseDatabaseUrl: configured, ownedContainerName: null };
  }

  await docker(["info", "--format", "{{.ServerVersion}}"]);
  const ownedContainerName = `hyperia-duel-damage-chaos-${process.pid}`;
  const databaseUser = "duel_damage_test";
  const databasePassword = `duel-damage-${randomUUID()}`;
  const image =
    process.env.DUEL_DAMAGE_CHAOS_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  let started = false;
  try {
    await docker([
      "run",
      "--rm",
      "-d",
      "--name",
      ownedContainerName,
      "-e",
      `POSTGRES_USER=${databaseUser}`,
      "-e",
      `POSTGRES_PASSWORD=${databasePassword}`,
      "-p",
      "127.0.0.1::5432",
      image,
    ]);
    started = true;
    const port = Number(
      (await docker(["port", ownedContainerName, "5432/tcp"]))
        .split(":")
        .at(-1),
    );
    assert(
      Number.isSafeInteger(port) && port > 0,
      "owned PostgreSQL port missing",
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = await docker([
        "exec",
        ownedContainerName,
        "pg_isready",
        "-U",
        databaseUser,
      ]).then(
        () => true,
        () => false,
      );
      if (ready) {
        return {
          baseDatabaseUrl: `postgres://${databaseUser}:${databasePassword}@127.0.0.1:${port}/postgres`,
          ownedContainerName,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("owned PostgreSQL did not become ready within 30 seconds");
  } catch (error) {
    if (started) {
      await docker(["rm", "-f", ownedContainerName]).catch(() => undefined);
    }
    throw error;
  }
}

function requestFingerprint(
  observation: StreamingDuelDamageObservationContext,
  competitiveAuthority: ChildContext["competitiveAuthority"],
): string {
  const attackStyle = "aggressive";
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        attackerId: ATTACKER_ID,
        targetPlayerId: TARGET_ID,
        requestedDamage: observation.requestedDamage,
        attackStyle,
        publicActionObservation: observation,
        competitiveAuthority,
      }),
      "utf8",
    )
    .digest("hex");
}

function buildRequest(context: ChildContext) {
  return {
    operationId: context.observation.operationId,
    attackerId: ATTACKER_ID,
    targetPlayerId: TARGET_ID,
    requestedDamage: context.observation.requestedDamage,
    attackStyle: "aggressive",
    requestFingerprint: requestFingerprint(
      context.observation,
      context.competitiveAuthority,
    ),
    publicActionObservation: context.observation,
    competitiveAuthority: context.competitiveAuthority,
  };
}

function assertWinnerProgression(
  receipt: Awaited<
    ReturnType<DatabaseSystem["commitDuelDamageOperationAsync"]>
  >,
): void {
  const strength = receipt.combatProgress.find(
    (progress) => progress.skill === "strength",
  );
  const constitution = receipt.combatProgress.find(
    (progress) => progress.skill === "constitution",
  );
  assert(receipt.xpDamageAuthority === 7, "winner XP authority is not exact");
  assert(
    receipt.combatProgress.length === 2 &&
      strength?.xpAmount === 28 &&
      strength.awardedXp === 28 &&
      strength.operationCommittedXp === 28 &&
      strength.currentXp === 28 &&
      strength.currentLevel === 1 &&
      constitution?.xpAmount === 9 &&
      constitution.awardedXp === 9 &&
      constitution.operationCommittedXp === 1_163 &&
      constitution.currentXp === 1_163 &&
      constitution.currentLevel === 10,
    `winner progression is not exact: ${JSON.stringify(receipt.combatProgress)}`,
  );
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
  const receipt = await databaseSystem.commitDuelDamageOperationAsync(
    buildRequest(context),
  );
  assert(receipt.replayed === false, "damage custody unexpectedly replayed");
  assert(receipt.healthAfter === 0, "lethal damage did not commit exact HP");
  assert(
    receipt.competitiveTerminal?.winnerId === ATTACKER_ID,
    "lethal damage did not commit competitive winner",
  );
  assertWinnerProgression(receipt);

  await new Promise<void>((resolve) => {
    process.stdout.write("AUTHORITY_COMMITTED_BEFORE_PUBLICATION\n", resolve);
  });
  process.kill(process.pid, "SIGKILL");
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
      reject(new Error("authority child did not terminate within 30 seconds"));
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
            `authority child exited ${code}: ${stderr || stdout || "no output"}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, signal });
    });
  });
}

async function runParentAgainstDatabase(
  baseDatabaseUrl: string,
): Promise<void> {
  const databaseName = `hyperia_duel_damage_kill_${process.pid}_${Date.now().toString(36)}`;
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
    await db.insert(schema.users).values([
      {
        id: "duel-damage-kill-attacker-account",
        name: "Duel Damage Kill Attacker Account",
        roles: "user",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
      {
        id: "duel-damage-kill-target-account",
        name: "Duel Damage Kill Target Account",
        roles: "user",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    ]);
    await db.insert(schema.characters).values([
      {
        id: ATTACKER_ID,
        accountId: "duel-damage-kill-attacker-account",
        name: "Duel Damage Kill Attacker",
        isAgent: 1,
        health: 30,
        maxHealth: 30,
      },
      {
        id: TARGET_ID,
        accountId: "duel-damage-kill-target-account",
        name: "Duel Damage Kill Target",
        isAgent: 1,
        health: 7,
        maxHealth: 7,
      },
    ]);

    const preparationId = randomUUID();
    const fencingToken = "91";
    const frozenAt = Date.now() - 10_000;
    const duelStartedAt = frozenAt + 5_000;
    const cycleId = "cycle-damage-process-kill";
    const duelId = "duel-damage-process-kill";
    const { snapshotDigest } = await seedCompetitiveDamageFixture(pool, {
      preparationId,
      fencingToken,
      cycleId,
      duelId,
      duelKey: "83".repeat(32),
      agent1Id: ATTACKER_ID,
      agent2Id: TARGET_ID,
      agent1Name: "Duel Damage Kill Attacker",
      agent2Name: "Duel Damage Kill Target",
      agent1MaxHp: 30,
      agent2MaxHp: 7,
      frozenAt,
      duelStartedAt,
    });

    const context: ChildContext = {
      observation: {
        operationId: randomUUID(),
        tick: 17,
        observedAt: Math.max(Date.now(), duelStartedAt + 1),
        cycleId,
        duelId,
        actorId: ATTACKER_ID,
        opponentId: TARGET_ID,
        phase: "FIGHTING",
        combatRole: "melee",
        tacticalMacro: "finish",
        requestedDamage: 9,
      },
      competitiveAuthority: {
        preparationId,
        fencingToken,
        snapshotDigest,
      },
    };
    const childResult = await waitForChild(testUrl.toString(), context);
    assert(
      childResult.stdout.includes("AUTHORITY_COMMITTED_BEFORE_PUBLICATION"),
      `authority commit marker missing: ${childResult.stderr}`,
    );
    assert(
      childResult.signal === "SIGKILL",
      `authority child was not killed at the requested boundary (${String(childResult.signal)})`,
    );

    const authorityRows = await pool.query<{
      health: number;
      completed: boolean;
      observationRows: number;
      lifecycleStatus: string;
      terminalWinnerId: string;
      terminalEvents: number;
      strengthXp: number;
      strengthLevel: number;
      constitutionXp: number;
      constitutionLevel: number;
      combatLevel: number;
    }>(
      `SELECT
         (SELECT health FROM characters WHERE id = $1) AS health,
         (SELECT completed FROM operations_log WHERE id = $2) AS completed,
         (SELECT count(*) FROM streaming_duel_action_observations
           WHERE "operationId" = $2)::int AS "observationRows",
         (SELECT "lifecycleStatus" FROM streaming_duel_competitive_snapshots
           WHERE "preparationId" = $3) AS "lifecycleStatus",
         (SELECT "terminalWinnerId" FROM streaming_duel_competitive_snapshots
           WHERE "preparationId" = $3) AS "terminalWinnerId",
         (SELECT count(*) FROM streaming_duel_transition_events
           WHERE "eventKey" = $3 || ':terminal_committed')::int AS "terminalEvents",
         (SELECT "strengthXp" FROM characters WHERE id = $4) AS "strengthXp",
         (SELECT "strengthLevel" FROM characters WHERE id = $4) AS "strengthLevel",
         (SELECT "constitutionXp" FROM characters WHERE id = $4) AS "constitutionXp",
         (SELECT "constitutionLevel" FROM characters WHERE id = $4) AS "constitutionLevel",
         (SELECT "combatLevel" FROM characters WHERE id = $4) AS "combatLevel"`,
      [TARGET_ID, context.observation.operationId, preparationId, ATTACKER_ID],
    );
    assert(authorityRows.rows[0]?.health === 0, "durable health is not exact");
    assert(
      authorityRows.rows[0]?.completed === true,
      "receipt is not completed",
    );
    assert(
      authorityRows.rows[0]?.observationRows === 1,
      "atomic public observation is not exact-once",
    );
    assert(
      authorityRows.rows[0]?.lifecycleStatus === "terminal" &&
        authorityRows.rows[0]?.terminalWinnerId === ATTACKER_ID &&
        authorityRows.rows[0]?.terminalEvents === 1,
      "competitive terminal truth is not atomic",
    );
    assert(
      authorityRows.rows[0]?.strengthXp === 28 &&
        authorityRows.rows[0]?.strengthLevel === 1 &&
        authorityRows.rows[0]?.constitutionXp === 1_163 &&
        authorityRows.rows[0]?.constitutionLevel === 10 &&
        authorityRows.rows[0]?.combatLevel === 3,
      `winner progression did not survive SIGKILL exactly: ${JSON.stringify(authorityRows.rows[0])}`,
    );

    const readAggregateStats = () =>
      pool!.query<{
        playerId: string;
        totalDuelWins: number;
        totalDuelLosses: number;
        wins: number;
        losses: number;
        draws: number;
        currentStreak: number;
        killStreak: number;
        totalDamageDealt: number;
        totalDamageTaken: number;
      }>(
        `SELECT combat."playerId", combat."totalDuelWins", combat."totalDuelLosses",
                agent.wins, agent.losses, agent.draws,
                agent."currentStreak", agent."killStreak",
                agent."totalDamageDealt", agent."totalDamageTaken"
           FROM player_combat_stats AS combat
           JOIN agent_duel_stats AS agent
             ON agent."characterId" = combat."playerId"
          WHERE combat."playerId" = ANY($1::text[])
          ORDER BY combat."playerId"`,
        [[ATTACKER_ID, TARGET_ID]],
      );
    const exactAggregateStats = [
      {
        playerId: ATTACKER_ID,
        totalDuelWins: 1,
        totalDuelLosses: 0,
        wins: 1,
        losses: 0,
        draws: 0,
        currentStreak: 1,
        killStreak: 1,
        totalDamageDealt: 7,
        totalDamageTaken: 0,
      },
      {
        playerId: TARGET_ID,
        totalDuelWins: 0,
        totalDuelLosses: 1,
        wins: 0,
        losses: 1,
        draws: 0,
        currentStreak: 0,
        killStreak: 0,
        totalDamageDealt: 0,
        totalDamageTaken: 7,
      },
    ];
    const aggregateStatsAfterKill = await readAggregateStats();
    assert(
      JSON.stringify(aggregateStatsAfterKill.rows) ===
        JSON.stringify(exactAggregateStats),
      `competitive aggregates did not survive SIGKILL exactly: ${JSON.stringify(aggregateStatsAfterKill.rows)}`,
    );

    const replacementDatabase = new DatabaseSystem({
      drizzleDb: db,
      pgPool: pool,
    } as never);
    await replacementDatabase.init();
    const replay = await replacementDatabase.commitDuelDamageOperationAsync(
      buildRequest(context),
    );
    assert(replay.replayed, "replacement authority did not replay receipt");
    assert(
      replay.competitiveTerminal?.winnerId === ATTACKER_ID,
      "replacement damage replay lost competitive terminal",
    );
    assertWinnerProgression(replay);

    const preparationStore = new PostgresDuelPreparationStore(pool);
    const recoveredCompetitive =
      await preparationStore.claimLatestCompetitiveSnapshotForRecovery("92");
    assert(
      recoveredCompetitive?.lifecycleStatus === "terminal" &&
        recoveredCompetitive.terminal?.winnerId === ATTACKER_ID,
      "replacement lifecycle authority did not recover the terminal win",
    );
    const handoffReplay =
      await replacementDatabase.commitDuelDamageOperationAsync(
        buildRequest(context),
      );
    assert(
      handoffReplay.replayed &&
        handoffReplay.competitiveTerminal?.winnerId === ATTACKER_ID,
      "immutable damage receipt did not replay after authority handoff",
    );
    assertWinnerProgression(handoffReplay);
    const aggregateStatsAfterReplays = await readAggregateStats();
    assert(
      JSON.stringify(aggregateStatsAfterReplays.rows) ===
        JSON.stringify(exactAggregateStats),
      `competitive aggregate replay was not idempotent: ${JSON.stringify(aggregateStatsAfterReplays.rows)}`,
    );

    const store = new PostgresStreamingDuelActionObservationStore(
      pool as unknown as StreamingDuelActionObservationPool,
    );
    const ledger = new StreamingDuelActionObservationLedger(store, {
      retryDelay: async () => {},
    });
    ledger.activateCycle(context.observation.cycleId);
    await ledger.waitForIdle();
    const recovered = ledger.getSnapshot(context.observation.cycleId);
    assert(
      recovered.length === 1,
      "replacement ledger did not hydrate one row",
    );
    assert(recovered[0]?.action === "damage", "recovered action is not damage");
    assert(recovered[0]?.amount === 7, "recovered damage is not exact");

    const draft = {
      tick: context.observation.tick,
      cycleId: context.observation.cycleId,
      duelId: context.observation.duelId,
      actorId: context.observation.actorId,
      opponentId: context.observation.opponentId,
      phase: context.observation.phase,
      combatRole: context.observation.combatRole,
      tacticalMacro: context.observation.tacticalMacro,
      action: "damage",
      outcome: "committed",
      value: "hit",
      amount: 7,
    } satisfies StreamingDuelActionObservationDraft;
    assert(
      ledger.record(draft, {
        operationId: context.observation.operationId,
        observedAt: context.observation.observedAt,
      }),
      "delayed combat callback was rejected",
    );
    await ledger.waitForIdle();
    const replayRows = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM streaming_duel_action_observations
       WHERE "operationId" = $1`,
      [context.observation.operationId],
    );
    assert(
      replayRows.rows[0]?.count === 1,
      "delayed callback duplicated the row",
    );
    assert(
      ledger.getHealth().persistenceErrors === 0,
      `replacement ledger unhealthy: ${ledger.getHealth().lastError}`,
    );
    const legacyHistory = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM streaming_duel_history
        WHERE "cycleId" = $1`,
      [context.observation.cycleId],
    );
    assert(
      legacyHistory.rows[0]?.count === 0,
      "test boundary unexpectedly has a legacy history row",
    );
    const replacementHistory = new MatchmakingManager(
      {} as World,
      () => replacementDatabase.getDb() as never,
      {
        minAgents: 2,
        maxRecentDuels: 8,
        persistStatsToDatabase: false,
        maxAgentStats: 16,
        insufficientAgentsRetryInterval: 30_000,
        maxInsufficientAgentWarnings: 5,
      },
    );
    const hydratedHistory =
      await replacementHistory.hydrateRecentDuelsFromDatabase();
    const opponentHistory = replacementHistory.getOpponentHistory(
      ATTACKER_ID,
      TARGET_ID,
    );
    assert(
      hydratedHistory === 1 &&
        opponentHistory.length === 1 &&
        opponentHistory[0]?.result === "win" &&
        opponentHistory[0]?.ownOpeningStyle === "melee" &&
        opponentHistory[0]?.opponentOpeningStyle === "melee" &&
        opponentHistory[0]?.ownDamage === 7 &&
        opponentHistory[0]?.opponentDamage === 0 &&
        opponentHistory[0]?.winReason === "kill",
      `replacement opponent history is not authoritative: ${JSON.stringify(opponentHistory)}`,
    );

    console.log(
      JSON.stringify({
        status: "passed",
        boundary:
          "lethal_damage_health_terminal_commit_before_publication_process_kill",
        signal: childResult.signal,
        targetHealth: authorityRows.rows[0].health,
        operationCompleted: authorityRows.rows[0].completed,
        observationRows: replayRows.rows[0].count,
        recoveredSequence: recovered[0]?.sequence,
        recoveredDamage: recovered[0]?.amount,
        authorityReplayed: replay.replayed,
        authorityHandoffReplayed: handoffReplay.replayed,
        terminalOutcome: recoveredCompetitive.terminal?.outcome,
        terminalWinnerId: recoveredCompetitive.terminal?.winnerId,
        terminalEvents: authorityRows.rows[0].terminalEvents,
        aggregateStatsCommittedBeforeKill: true,
        aggregateStatsExactAfterReplays: true,
        winnerProgressionExactAfterReplays: true,
        strengthXp: authorityRows.rows[0].strengthXp,
        constitutionXp: authorityRows.rows[0].constitutionXp,
        combatLevel: authorityRows.rows[0].combatLevel,
        aggregateStats: aggregateStatsAfterReplays.rows,
        legacyHistoryRows: legacyHistory.rows[0].count,
        authoritativeHistoryRows: hydratedHistory,
        opponentHistory,
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

async function runParent(): Promise<void> {
  const authority = await resolveDatabaseAuthority();
  try {
    await runParentAgainstDatabase(authority.baseDatabaseUrl);
  } finally {
    if (authority.ownedContainerName) {
      await docker(["rm", "-f", authority.ownedContainerName]);
    }
  }
}

if (process.argv[2] === CHILD_MODE) {
  await runAuthorityChild();
} else {
  await runParent();
}
