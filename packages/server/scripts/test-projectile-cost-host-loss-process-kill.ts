import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import {
  ITEMS,
  ammunitionShotIdentityFromRequest,
  serializeAmmunitionShotFingerprint,
  serializeGroundItemSourceRegistrationFingerprint,
} from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import * as schema from "../src/database/schema.js";
import type {
  AmmunitionShotCommitRequest,
  GroundItemSourceRegistrationRequest,
  ProjectileRuneCostCommitRequest,
} from "../src/shared/types/index.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";

const FIRE_CHILD = "--fire-child";
const RECOVER_CHILD = "--recover-child";
const UNFINISHED_CHILD = "--unfinished-child";
const CHILD_DATABASE_URL = "PROJECTILE_COST_HOST_LOSS_DATABASE_URL";
const PLAYER_ID = "projectile-cost-host-loss-agent";
const ACCOUNT_ID = "projectile-cost-host-loss-account";
const AMMUNITION_OPERATION_ID = "ammunition-shot:projectilehostloss01";
const RUNE_OPERATION_ID = "spell-runes:projectilehostloss01";
const SOURCE_ID = "ground_item_11111111-1111-4111-8111-111111111111";
const CONTRIBUTION_ID =
  "ground-item-source:22222222-2222-4222-8222-222222222222";
const execFileAsync = promisify(execFile);

type RecoveryKind = "ammunition" | "runes";

type ChildEvent = {
  event: "fired" | "recovery_blocked" | "transaction_aborted";
  kind?: RecoveryKind;
  error?: string;
  firedAmmunitionShots: number;
  firedRuneCosts: number;
  invalidOperations: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorCauseMessages(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current) && messages.length < 8) {
    seen.add(current);
    if (current instanceof Error) messages.push(current.message);
    if (typeof current !== "object" || !("cause" in current)) break;
    current = current.cause;
  }
  return messages.join(" | ");
}

function installTestItems(): void {
  ITEMS.set("bronze_arrow", {
    id: "bronze_arrow",
    name: "Bronze arrow",
    type: "ammunition",
    equipSlot: "arrows",
    stackable: true,
  } as never);
  for (const itemId of ["air_rune", "mind_rune"]) {
    ITEMS.set(itemId, {
      id: itemId,
      name: itemId,
      type: "misc",
      stackable: true,
    } as never);
  }
}

function ammunitionRequest(): AmmunitionShotCommitRequest {
  const sourceInput: Omit<
    GroundItemSourceRegistrationRequest,
    "requestFingerprint"
  > = {
    contributionId: CONTRIBUTION_ID,
    preferredSourceId: SOURCE_ID,
    itemId: "bronze_arrow",
    quantity: 1,
    stackable: true,
    position: { x: 4.5, y: 0.2, z: 7.5 },
    tile: { x: 4, z: 7 },
    droppedBy: PLAYER_ID,
    lifetimeMs: 120_000,
    lootProtectionMs: 0,
    allowMerge: false,
  };
  const source: GroundItemSourceRegistrationRequest = {
    ...sourceInput,
    requestFingerprint: createHash("sha256")
      .update(
        serializeGroundItemSourceRegistrationFingerprint(sourceInput),
        "utf8",
      )
      .digest("hex"),
  };
  const identity = {
    operationId: AMMUNITION_OPERATION_ID,
    playerId: PLAYER_ID,
    itemId: "bronze_arrow",
    quantity: 1 as const,
    recoveryDisposition: "recovered" as const,
    source,
  };
  return {
    ...identity,
    requestFingerprint: createHash("sha256")
      .update(
        serializeAmmunitionShotFingerprint(
          ammunitionShotIdentityFromRequest(identity),
        ),
        "utf8",
      )
      .digest("hex"),
  };
}

function runeRequest(): ProjectileRuneCostCommitRequest {
  const requirements = [
    { itemId: "air_rune", quantity: 2 },
    { itemId: "mind_rune", quantity: 1 },
  ];
  return {
    operationId: RUNE_OPERATION_ID,
    playerId: PLAYER_ID,
    requestFingerprint: createHash("sha256")
      .update(
        JSON.stringify({ version: 1, playerId: PLAYER_ID, requirements }),
        "utf8",
      )
      .digest("hex"),
    requirements,
  };
}

async function createDatabaseSystem(
  connectionString: string,
  applicationName?: string,
): Promise<{ databaseSystem: DatabaseSystem; pool: pg.Pool }> {
  installTestItems();
  const pool = new pg.Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 2_000,
    statement_timeout: applicationName ? 60_000 : 5_000,
    query_timeout: applicationName ? 61_000 : 6_000,
    application_name: applicationName,
  });
  const databaseSystem = new DatabaseSystem({
    drizzleDb: drizzle(pool, { schema }),
    pgPool: pool,
  } as never);
  await databaseSystem.init();
  return { databaseSystem, pool };
}

async function writeEvent(event: ChildEvent): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(`${JSON.stringify(event)}\n`, () => resolve());
  });
}

async function writeEventAndKill(event: ChildEvent): Promise<never> {
  await writeEvent(event);
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the child");
}

function unfinishedApplicationName(kind: RecoveryKind): string {
  return `projectile_cost_unfinished_${kind}`;
}

async function runUnfinishedChild(kind: RecoveryKind): Promise<void> {
  const connectionString = process.env[CHILD_DATABASE_URL]?.trim();
  assert(connectionString, "unfinished child database URL is required");
  const { databaseSystem, pool } = await createDatabaseSystem(
    connectionString,
    unfinishedApplicationName(kind),
  );
  try {
    if (kind === "ammunition") {
      await databaseSystem.commitAmmunitionShotOperationAsync(
        ammunitionRequest(),
      );
    } else {
      await databaseSystem.commitProjectileRuneCostOperationAsync(
        runeRequest(),
      );
    }
    throw new Error(`${kind}_unfinished_transaction_committed`);
  } catch (error) {
    const message = errorCauseMessages(error) || String(error);
    assert(
      /connection|ECONNRESET|server closed|terminating connection|57P01/iu.test(
        message,
      ),
      `${kind} unfinished transaction failed for an unexpected reason: ${message}`,
    );
    await pool.end().catch(() => undefined);
    await writeEvent({
      event: "transaction_aborted",
      kind,
      error: "database_process_lost",
      firedAmmunitionShots: 0,
      firedRuneCosts: 0,
      invalidOperations: 0,
    });
  }
}

async function runFireChild(): Promise<never> {
  const connectionString = process.env[CHILD_DATABASE_URL]?.trim();
  assert(connectionString, "fire child database URL is required");
  const { databaseSystem, pool } = await createDatabaseSystem(connectionString);
  try {
    const ammunition = ammunitionRequest();
    const stagedAmmunition =
      await databaseSystem.commitAmmunitionShotOperationAsync(ammunition);
    assert(
      stagedAmmunition.status === "pending" &&
        stagedAmmunition.replayed === false,
      "ammunition did not stage exactly once",
    );
    const firedAmmunition =
      await databaseSystem.completeAmmunitionShotOperationAsync({
        operationId: ammunition.operationId,
        playerId: ammunition.playerId,
        requestFingerprint: ammunition.requestFingerprint,
      });
    assert(
      firedAmmunition.status === "fired" && firedAmmunition.replayed === false,
      "ammunition did not reach durable fired state",
    );

    const runes = runeRequest();
    const stagedRunes =
      await databaseSystem.commitProjectileRuneCostOperationAsync(runes);
    assert(
      stagedRunes.status === "pending" && stagedRunes.replayed === false,
      "runes did not stage exactly once",
    );
    const firedRunes =
      await databaseSystem.completeProjectileRuneCostOperationAsync({
        operationId: runes.operationId,
        playerId: runes.playerId,
        requestFingerprint: runes.requestFingerprint,
      });
    assert(
      firedRunes.status === "fired" && firedRunes.replayed === false,
      "runes did not reach durable fired state",
    );

    const stats = await databaseSystem.getProjectileCostCustodyStatsAsync();
    assert(
      stats.firedAmmunitionShots === 1 &&
        stats.firedRuneCosts === 1 &&
        stats.invalidOperations === 0,
      `fired custody aggregate is not exact: ${JSON.stringify(stats)}`,
    );
    return writeEventAndKill({
      event: "fired",
      firedAmmunitionShots: stats.firedAmmunitionShots,
      firedRuneCosts: stats.firedRuneCosts,
      invalidOperations: stats.invalidOperations,
    });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

async function runRecoveryChild(kind: RecoveryKind): Promise<never> {
  const connectionString = process.env[CHILD_DATABASE_URL]?.trim();
  assert(connectionString, "recovery child database URL is required");
  const { databaseSystem, pool } = await createDatabaseSystem(connectionString);
  const expectedError =
    kind === "ammunition"
      ? "ammunition_shot_fired_reconciliation_required"
      : "projectile_rune_cost_fired_reconciliation_required";
  try {
    let observedError = "";
    try {
      if (kind === "ammunition") {
        await databaseSystem.recoverPendingAmmunitionShotOperationsAsync(
          PLAYER_ID,
        );
      } else {
        await databaseSystem.recoverPendingProjectileRuneCostOperationsAsync(
          PLAYER_ID,
        );
      }
    } catch (error) {
      observedError = error instanceof Error ? error.message : String(error);
    }
    assert(
      observedError.includes(expectedError),
      `${kind} replacement did not fail closed: ${observedError || "no error"}`,
    );
    const stats = await databaseSystem.getProjectileCostCustodyStatsAsync();
    assert(
      stats.firedAmmunitionShots === 1 &&
        stats.firedRuneCosts === 1 &&
        stats.invalidOperations === 0,
      `${kind} replacement changed aggregate custody: ${JSON.stringify(stats)}`,
    );
    return writeEventAndKill({
      event: "recovery_blocked",
      kind,
      error: expectedError,
      firedAmmunitionShots: stats.firedAmmunitionShots,
      firedRuneCosts: stats.firedRuneCosts,
      invalidOperations: stats.invalidOperations,
    });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
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
    process.env.PROJECTILE_COST_HOST_LOSS_TEST_DATABASE_URL?.trim();
  if (configured) {
    return { baseDatabaseUrl: configured, ownedContainerName: null };
  }

  await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
    throw new Error(
      `Docker is required for projectile custody chaos: ${error}`,
    );
  });
  const ownedContainerName = `hyperia-projectile-cost-chaos-${process.pid}`;
  const databaseUser = "projectile_cost_chaos";
  const databasePassword = `projectile-${randomUUID()}`;
  const image =
    process.env.PROJECTILE_COST_HOST_LOSS_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  let started = false;
  try {
    await docker([
      "run",
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

async function runKilledChild(
  connectionString: string,
  args: string[],
): Promise<ChildEvent> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, ...args], {
      env: { ...process.env, [CHILD_DATABASE_URL]: connectionString },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let event: ChildEvent | null = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as ChildEvent;
          if (parsed.event === "fired" || parsed.event === "recovery_blocked") {
            event = parsed;
          }
        } catch {
          // Runtime diagnostics may share stdout; retain them for failures.
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not terminate within 30 seconds: ${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (signal !== "SIGKILL" || !event) {
        reject(
          new Error(
            `child exited without committed SIGKILL evidence (${code ?? signal}): ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve(event);
    });
  });
}

type RunningUnfinishedChild = {
  completion: Promise<ChildEvent>;
  terminate: () => void;
};

function startUnfinishedChild(
  connectionString: string,
  kind: RecoveryKind,
): RunningUnfinishedChild {
  const child = spawn(
    process.execPath,
    [import.meta.filename, UNFINISHED_CHILD, kind],
    {
      env: { ...process.env, [CHILD_DATABASE_URL]: connectionString },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let event: ChildEvent | null = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ChildEvent;
        if (parsed.event === "transaction_aborted") event = parsed;
      } catch {
        // Runtime diagnostics may share stdout; retain them for failures.
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<ChildEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `unfinished child did not terminate within 30 seconds: ${stderr}`,
        ),
      );
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || signal !== null || !event) {
        reject(
          new Error(
            `unfinished child exited without database-loss evidence (${code ?? signal}): ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve(event);
    });
  });
  void completion.catch(() => undefined);
  return {
    completion,
    terminate: () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    },
  };
}

const TRANSACTION_BLOCK_TRIGGER = "projectile_cost_chaos_block_trigger";
const TRANSACTION_BLOCK_FUNCTION = "projectile_cost_chaos_block_function";

async function installTransactionBlock(
  pool: pg.Pool,
  kind: RecoveryKind,
): Promise<void> {
  const operationType =
    kind === "ammunition" ? "ammunition_shot" : "projectile_rune_cost";
  await pool.query(`
    CREATE FUNCTION ${TRANSACTION_BLOCK_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $projectile_cost_chaos$
    BEGIN
      IF NEW."operationType" = '${operationType}' THEN
        PERFORM pg_sleep(60);
      END IF;
      RETURN NEW;
    END
    $projectile_cost_chaos$
  `);
  await pool.query(`
    CREATE TRIGGER ${TRANSACTION_BLOCK_TRIGGER}
    BEFORE INSERT ON operations_log
    FOR EACH ROW
    EXECUTE FUNCTION ${TRANSACTION_BLOCK_FUNCTION}()
  `);
}

async function removeTransactionBlock(pool: pg.Pool): Promise<void> {
  await pool.query(
    `DROP TRIGGER IF EXISTS ${TRANSACTION_BLOCK_TRIGGER} ON operations_log`,
  );
  await pool.query(`DROP FUNCTION IF EXISTS ${TRANSACTION_BLOCK_FUNCTION}()`);
}

async function waitForBlockedTransaction(
  connectionString: string,
  kind: RecoveryKind,
): Promise<void> {
  const pool = await openReadyPool(connectionString, 1);
  const deadline = Date.now() + 10_000;
  let lastActivity: unknown = null;
  try {
    while (Date.now() < deadline) {
      const activity = await pool.query<{
        state: string;
        waitEventType: string | null;
        waitEvent: string | null;
        query: string;
      }>(
        `SELECT state,
                wait_event_type AS "waitEventType",
                wait_event AS "waitEvent",
                query
         FROM pg_stat_activity
         WHERE application_name = $1`,
        [unfinishedApplicationName(kind)],
      );
      lastActivity = activity.rows;
      const blocked = activity.rows.some(
        (row) =>
          row.state === "active" &&
          row.waitEventType === "Timeout" &&
          row.waitEvent === "PgSleep" &&
          row.query.includes('insert into "operations_log"'),
      );
      if (blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
  throw new Error(
    `${kind} transaction never reached the blocked post-debit insert: ${JSON.stringify(lastActivity)}`,
  );
}

async function custodyDigest(pool: pg.Pool): Promise<string> {
  const [operations, equipment, inventory] = await Promise.all([
    pool.query(
      `SELECT id, "operationType", completed, "operationState"::text AS state
       FROM operations_log
       WHERE "playerId" = $1
         AND "operationType" IN ('ammunition_shot', 'projectile_rune_cost')
       ORDER BY "operationType", id`,
      [PLAYER_ID],
    ),
    pool.query(
      `SELECT "slotType", "itemId", quantity
       FROM equipment WHERE "playerId" = $1 ORDER BY "slotType"`,
      [PLAYER_ID],
    ),
    pool.query(
      `SELECT "itemId", quantity, "slotIndex", metadata
       FROM inventory WHERE "playerId" = $1 ORDER BY "slotIndex"`,
      [PLAYER_ID],
    ),
  ]);
  return createHash("sha256")
    .update(
      JSON.stringify({
        operations: operations.rows,
        equipment: equipment.rows,
        inventory: inventory.rows,
      }),
      "utf8",
    )
    .digest("hex");
}

async function openReadyPool(
  connectionString: string,
  max: number,
): Promise<pg.Pool> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const pool = new pg.Pool({
      connectionString,
      max,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 5_000,
      query_timeout: 6_000,
    });
    try {
      await pool.query("SELECT 1");
      return pool;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(
    `PostgreSQL connection did not stabilize: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function ensureDatabaseCreated(
  adminConnectionString: string,
  databaseName: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const pool = await openReadyPool(adminConnectionString, 1);
    try {
      const existing = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
        [databaseName],
      );
      if (existing.rows[0]?.exists === true) return;
      await pool.query(`CREATE DATABASE "${databaseName}"`);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await pool.end().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `test database creation did not stabilize: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function assertFinalCustody(pool: pg.Pool): Promise<void> {
  const operations = await pool.query<{
    operationType: string;
    completed: boolean;
    status: string;
  }>(
    `SELECT "operationType", completed,
            "operationState"->>'status' AS status
     FROM operations_log
     WHERE "playerId" = $1
       AND "operationType" IN ('ammunition_shot', 'projectile_rune_cost')
     ORDER BY "operationType"`,
    [PLAYER_ID],
  );
  assert(
    operations.rowCount === 2 &&
      operations.rows.every(
        (row) => row.completed === true && row.status === "fired",
      ),
    `projectile operation states changed: ${JSON.stringify(operations.rows)}`,
  );
  const arrows = await pool.query<{ quantity: number }>(
    `SELECT quantity FROM equipment
     WHERE "playerId" = $1 AND "slotType" = 'arrows'
       AND "itemId" = 'bronze_arrow'`,
    [PLAYER_ID],
  );
  assert(
    arrows.rowCount === 1 && arrows.rows[0]?.quantity === 2,
    `ammunition custody changed: ${JSON.stringify(arrows.rows)}`,
  );
  const runes = await pool.query<{ itemId: string; quantity: number }>(
    `SELECT "itemId", quantity FROM inventory
     WHERE "playerId" = $1 AND "itemId" IN ('air_rune', 'mind_rune')
     ORDER BY "itemId"`,
    [PLAYER_ID],
  );
  assert(
    JSON.stringify(runes.rows) ===
      JSON.stringify([
        { itemId: "air_rune", quantity: 8 },
        { itemId: "mind_rune", quantity: 4 },
      ]),
    `rune custody changed: ${JSON.stringify(runes.rows)}`,
  );
}

async function runParentAgainstDatabase(
  baseDatabaseUrl: string,
  restartDatabaseProcess: (() => Promise<string>) | null,
): Promise<void> {
  const databaseName = `hyperia_projectile_cost_chaos_${process.pid}_${Date.now().toString(36)}`;
  let adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = "/postgres";
  let testUrl = new URL(baseDatabaseUrl);
  testUrl.pathname = `/${databaseName}`;
  let pool: pg.Pool | null = null;
  let activeUnfinishedChild: RunningUnfinishedChild | null = null;
  const applyRestartedBaseUrl = (restartedBaseDatabaseUrl: string): void => {
    adminUrl = new URL(restartedBaseDatabaseUrl);
    adminUrl.pathname = "/postgres";
    testUrl = new URL(restartedBaseDatabaseUrl);
    testUrl.pathname = `/${databaseName}`;
  };
  const openTestPool = (): Promise<pg.Pool> =>
    openReadyPool(testUrl.toString(), 6);
  let stage = "create_database";
  try {
    await ensureDatabaseCreated(adminUrl.toString(), databaseName);
    pool = await openTestPool();
    stage = "migrate";
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
    stage = "seed";
    const db = drizzle(pool, { schema });
    await db.insert(schema.users).values({
      id: ACCOUNT_ID,
      name: "Projectile Cost Host Loss Account",
      roles: "user",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    await db.insert(schema.characters).values({
      id: PLAYER_ID,
      accountId: ACCOUNT_ID,
      name: "Projectile Cost Host Loss Agent",
      isAgent: 1,
      health: 10,
      maxHealth: 10,
    });
    await db.insert(schema.equipment).values([
      {
        playerId: PLAYER_ID,
        slotType: "weapon",
        itemId: "shortbow",
        quantity: 1,
      },
      {
        playerId: PLAYER_ID,
        slotType: "arrows",
        itemId: "bronze_arrow",
        quantity: 3,
      },
    ]);
    await db.insert(schema.inventory).values([
      {
        playerId: PLAYER_ID,
        itemId: "air_rune",
        quantity: 10,
        slotIndex: 0,
        metadata: null,
      },
      {
        playerId: PLAYER_ID,
        itemId: "mind_rune",
        quantity: 5,
        slotIndex: 1,
        metadata: null,
      },
    ]);
    const initialDigest = await custodyDigest(pool);

    // No parent observer connection may survive a database or authority kill.
    // Every assertion below comes from a connection established afterward.
    await pool.end();
    pool = null;

    const unfinishedEvents: ChildEvent[] = [];
    if (restartDatabaseProcess) {
      for (const kind of ["ammunition", "runes"] as const) {
        stage = `unfinished_${kind}_install_block`;
        pool = await openTestPool();
        await installTransactionBlock(pool, kind);
        await pool.end();
        pool = null;

        stage = `unfinished_${kind}_child`;
        activeUnfinishedChild = startUnfinishedChild(testUrl.toString(), kind);
        stage = `unfinished_${kind}_blocked`;
        await waitForBlockedTransaction(testUrl.toString(), kind);
        stage = `unfinished_${kind}_database_restart`;
        applyRestartedBaseUrl(await restartDatabaseProcess());
        stage = `unfinished_${kind}_child_result`;
        const event = await activeUnfinishedChild.completion;
        activeUnfinishedChild = null;
        assert(
          event.event === "transaction_aborted" &&
            event.kind === kind &&
            event.error === "database_process_lost",
          `${kind} unfinished transaction evidence is incomplete: ${JSON.stringify(event)}`,
        );

        stage = `unfinished_${kind}_rollback_observer`;
        pool = await openTestPool();
        await removeTransactionBlock(pool);
        assert(
          (await custodyDigest(pool)) === initialDigest,
          `${kind} unfinished transaction did not roll back atomically`,
        );
        unfinishedEvents.push(event);
        await pool.end();
        pool = null;
      }
    }

    stage = "fire_child";
    const fired = await runKilledChild(testUrl.toString(), [FIRE_CHILD]);
    assert(
      fired.event === "fired" &&
        fired.firedAmmunitionShots === 1 &&
        fired.firedRuneCosts === 1,
      `fire child evidence is incomplete: ${JSON.stringify(fired)}`,
    );
    if (restartDatabaseProcess) {
      stage = "database_process_restart";
      applyRestartedBaseUrl(await restartDatabaseProcess());
    }
    stage = "first_replacement_observer";
    pool = await openTestPool();
    const committedDigest = await custodyDigest(pool);

    const replacementEvents: ChildEvent[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      for (const kind of ["runes", "ammunition"] as const) {
        await pool.end();
        pool = null;
        stage = `replacement_${attempt}_${kind}_child`;
        const event = await runKilledChild(testUrl.toString(), [
          RECOVER_CHILD,
          kind,
        ]);
        stage = `replacement_${attempt}_${kind}_observer`;
        pool = await openTestPool();
        replacementEvents.push(event);
        assert(
          event.event === "recovery_blocked" &&
            event.kind === kind &&
            event.firedAmmunitionShots === 1 &&
            event.firedRuneCosts === 1 &&
            event.invalidOperations === 0,
          `replacement ${attempt}/${kind} evidence is incomplete: ${JSON.stringify(event)}`,
        );
        assert(
          (await custodyDigest(pool)) === committedDigest,
          `replacement ${attempt}/${kind} mutated fired custody`,
        );
      }
    }
    stage = "final_custody";
    await assertFinalCustody(pool);

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        fireSignal: "SIGKILL",
        replacementSignals: replacementEvents.length,
        firedAmmunitionShots: 1,
        firedRuneCosts: 1,
        databaseProcessRestarted: restartDatabaseProcess !== null,
        databaseProcessRestarts: restartDatabaseProcess ? 3 : 0,
        unfinishedTransactionRollbacks: unfinishedEvents.length,
        unfinishedRollbackDigest:
          restartDatabaseProcess === null ? null : initialDigest,
        custodyDigest: committedDigest,
      })}\n`,
    );
  } catch (error) {
    throw new Error(
      `projectile custody chaos failed at ${stage}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    activeUnfinishedChild?.terminate();
    await pool?.end().catch(() => undefined);
    const cleanupPool = await openReadyPool(adminUrl.toString(), 1).catch(
      () => null,
    );
    if (cleanupPool) {
      await cleanupPool
        .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        .catch(() => undefined);
      await cleanupPool.end().catch(() => undefined);
    }
  }
}

async function runParent(): Promise<void> {
  const authority = await resolveDatabaseAuthority();
  try {
    const restartDatabaseProcess = authority.ownedContainerName
      ? async (): Promise<string> => {
          await docker([
            "kill",
            "--signal=KILL",
            authority.ownedContainerName!,
          ]);
          await docker(["start", authority.ownedContainerName!]);
          const port = Number(
            (await docker(["port", authority.ownedContainerName!, "5432/tcp"]))
              .split(":")
              .at(-1),
          );
          assert(
            Number.isSafeInteger(port) && port > 0,
            "restarted PostgreSQL port missing",
          );
          const restartedBaseDatabaseUrl = new URL(authority.baseDatabaseUrl);
          restartedBaseDatabaseUrl.port = String(port);
          const readinessPool = await openReadyPool(
            restartedBaseDatabaseUrl.toString(),
            1,
          );
          await readinessPool.end();
          return restartedBaseDatabaseUrl.toString();
        }
      : null;
    await runParentAgainstDatabase(
      authority.baseDatabaseUrl,
      restartDatabaseProcess,
    );
  } finally {
    if (authority.ownedContainerName) {
      await docker(["rm", "-f", authority.ownedContainerName]).catch(
        () => undefined,
      );
    }
  }
}

if (process.argv.includes(FIRE_CHILD)) {
  await runFireChild();
} else if (process.argv.includes(UNFINISHED_CHILD)) {
  const kind = process.argv.at(-1);
  assert(
    kind === "ammunition" || kind === "runes",
    "unfinished child kind is invalid",
  );
  await runUnfinishedChild(kind);
} else if (process.argv.includes(RECOVER_CHILD)) {
  const kind = process.argv.at(-1);
  assert(
    kind === "ammunition" || kind === "runes",
    "recovery child kind is invalid",
  );
  await runRecoveryChild(kind);
} else {
  await runParent();
}
