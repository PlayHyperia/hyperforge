import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../src/database/schema.js";
import { DatabaseSystem } from "../src/systems/DatabaseSystem/index.js";
import { canonicalCompetitiveSnapshotJson } from "../src/systems/StreamingDuelScheduler/competitive-snapshot.js";
import type { DuelPreparationPlanCommitRequest } from "../src/shared/types/index.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const PLAYER_ID = "duel-preparation-plan-chaos-agent";
const OPPONENT_ID = "duel-preparation-plan-chaos-opponent";
const ROLLBACK_PLAYER_ID = "duel-preparation-plan-rollback-agent";
const BASE_FINGERPRINT = "selected-contestant-plan:v1";
const RECOVERY_EVIDENCE = {
  agentPolicyFingerprint:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  availableStyles: ["ranged"],
  decisionLatencyMs: 0,
  decisionOutcome: "deterministic_runtime_unavailable",
  model: "deterministic",
  modelProvider: "deterministic",
  planningPolicyVersion: "duel-preparation-v1",
  planningSource: "deterministic",
  primaryStyle: "ranged",
};

const requestFor = (
  operationId: string,
  preparationId: string,
  requestFingerprint = BASE_FINGERPRINT,
  violateCustody = false,
  playerId = PLAYER_ID,
  forgeRecoveryEvidence = false,
): DuelPreparationPlanCommitRequest => ({
  operationId,
  preparationId,
  playerId,
  requestFingerprint,
  expected: {
    bank: [
      { itemId: "shortbow", quantity: 1, slot: 0, tabIndex: 0 },
      { itemId: "bronze_arrow", quantity: 50, slot: 1, tabIndex: 0 },
      { itemId: "lobster", quantity: 4, slot: 2, tabIndex: 0 },
      { itemId: "wizard_robe_top", quantity: 1, slot: 3, tabIndex: 0 },
    ],
    inventory: [
      {
        itemId: "test_junk",
        quantity: 1,
        slotIndex: 0,
        metadata: null,
      },
    ],
    equipment: [
      { slotType: "body", itemId: "bronze_platebody", quantity: 1 },
      { slotType: "weapon", itemId: "bronze_longsword", quantity: 1 },
    ],
    selectedSpell: null,
  },
  committed: {
    bank: [
      { itemId: "test_junk", quantity: 1, slot: 0, tabIndex: 0 },
      { itemId: "bronze_longsword", quantity: 1, slot: 1, tabIndex: 0 },
      { itemId: "bronze_platebody", quantity: 1, slot: 2, tabIndex: 0 },
    ],
    inventory: [
      { itemId: "lobster", quantity: 1, slotIndex: 0, metadata: null },
      { itemId: "lobster", quantity: 1, slotIndex: 1, metadata: null },
      { itemId: "lobster", quantity: 1, slotIndex: 2, metadata: null },
      ...(violateCustody
        ? []
        : [
            {
              itemId: "lobster",
              quantity: 1,
              slotIndex: 3,
              metadata: null,
            },
          ]),
    ],
    equipment: [
      { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
      { slotType: "body", itemId: "wizard_robe_top", quantity: 1 },
      { slotType: "weapon", itemId: "shortbow", quantity: 1 },
    ],
    selectedSpell: null,
  },
  recoveryEvidence: forgeRecoveryEvidence
    ? { ...RECOVERY_EVIDENCE, decisionOutcome: "deterministic_model_failed" }
    : RECOVERY_EVIDENCE,
});

type WorkerEvent = {
  event: "committed" | "error";
  replayed?: boolean;
  message?: string;
  recoveryEvidence?: Record<string, unknown>;
};

function errorMessageChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return messages.join(" | ");
}

async function runWorker(): Promise<void> {
  const connectionString = process.env.DUEL_PREPARATION_PLAN_TEST_DATABASE_URL;
  const operationId = process.env.DUEL_PREPARATION_PLAN_TEST_OPERATION_ID;
  const preparationId = process.env.DUEL_PREPARATION_PLAN_TEST_PREPARATION_ID;
  const requestFingerprint =
    process.env.DUEL_PREPARATION_PLAN_TEST_REQUEST_FINGERPRINT ??
    BASE_FINGERPRINT;
  const hold = process.argv.includes("--hold");
  const recover = process.argv.includes("--recover");
  const violateCustody = process.argv.includes("--violate-custody");
  const forgeRecoveryEvidence = process.argv.includes("--forged-evidence");
  if (!connectionString || !operationId || !preparationId) {
    throw new Error("duel preparation plan worker configuration is incomplete");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const databaseSystem = new DatabaseSystem({} as never);
    (databaseSystem as unknown as { db: typeof db }).db = db;
    (databaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    const receipt = recover
      ? await databaseSystem.getDuelPreparationPlanOperationAsync({
          operationId,
          preparationId,
          playerId: PLAYER_ID,
        })
      : await databaseSystem.commitDuelPreparationPlanOperationAsync(
          requestFor(
            operationId,
            preparationId,
            requestFingerprint,
            violateCustody,
            PLAYER_ID,
            forgeRecoveryEvidence,
          ),
        );
    if (!receipt) throw new Error("duel_preparation_plan_receipt_not_found");
    process.stdout.write(
      `${JSON.stringify({ event: "committed", replayed: receipt.replayed, recoveryEvidence: receipt.recoveryEvidence } satisfies WorkerEvent)}\n`,
    );
    if (hold) await new Promise<never>(() => undefined);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        event: "error",
        message: error instanceof Error ? error.message : String(error),
      } satisfies WorkerEvent)}\n`,
    );
  } finally {
    if (!hold) await pool.end();
  }
}

async function docker(args: string[]): Promise<string> {
  const binary = process.env.DOCKER_BIN?.trim() || "docker";
  const result = await execFileAsync(binary, args, {
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function waitForPostgres(connectionString: string): Promise<pg.Pool> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString, max: 2 });
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
    `temporary PostgreSQL did not become ready: ${String(lastError)}`,
  );
}

function spawnWorker(input: {
  connectionString: string;
  operationId: string;
  preparationId: string;
  requestFingerprint?: string;
  hold?: boolean;
  violateCustody?: boolean;
  recover?: boolean;
  forgeRecoveryEvidence?: boolean;
}): { child: ChildProcess; event: Promise<WorkerEvent> } {
  const args = [scriptPath, "--worker"];
  if (input.hold) args.push("--hold");
  if (input.violateCustody) args.push("--violate-custody");
  if (input.recover) args.push("--recover");
  if (input.forgeRecoveryEvidence) args.push("--forged-evidence");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      DUEL_PREPARATION_PLAN_TEST_DATABASE_URL: input.connectionString,
      DUEL_PREPARATION_PLAN_TEST_OPERATION_ID: input.operationId,
      DUEL_PREPARATION_PLAN_TEST_PREPARATION_ID: input.preparationId,
      DUEL_PREPARATION_PLAN_TEST_REQUEST_FINGERPRINT:
        input.requestFingerprint ?? BASE_FINGERPRINT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("worker pipes were not created");
  }
  const event = new Promise<WorkerEvent>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`worker timed out: ${stderr}`)),
      20_000,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (parsed.event === "committed" || parsed.event === "error") {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          // Build/runtime diagnostics may share stdout.
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGKILL") return;
      clearTimeout(timer);
      reject(new Error(`worker exited ${code ?? signal}: ${stderr}`));
    });
  });
  return { child, event };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("worker did not exit")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runParent(): Promise<void> {
  const containerName = `hyperia-duel-preparation-plan-${process.pid}`;
  const databaseUser = "preparation_test";
  const databaseName = "preparation_test";
  const databasePassword = `preparation-${randomUUID()}`;
  const preparationId = randomUUID();
  const operationId = randomUUID();
  const image =
    process.env.DUEL_PREPARATION_PLAN_TEST_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]);
    await docker([
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-e",
      `POSTGRES_USER=${databaseUser}`,
      "-e",
      `POSTGRES_PASSWORD=${databasePassword}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      "127.0.0.1::5432",
      image,
    ]);
    containerStarted = true;
    const portOutput = await docker(["port", containerName, "5432/tcp"]);
    const port = Number(portOutput.trim().split(":").pop());
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw new Error("could not resolve temporary PostgreSQL port");
    }
    const connectionString = `postgres://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${databaseName}`;
    pool = await waitForPostgres(connectionString);
    await pool.query(`
      CREATE TABLE characters (id text PRIMARY KEY, "selectedSpell" text);
      CREATE TABLE inventory (
        id serial PRIMARY KEY, "playerId" text NOT NULL, "itemId" text NOT NULL,
        quantity integer DEFAULT 1, "slotIndex" integer DEFAULT -1, metadata text
      );
      CREATE UNIQUE INDEX inventory_player_slot_unique
        ON inventory ("playerId", "slotIndex") WHERE "slotIndex" >= 0;
      CREATE TABLE equipment (
        id serial PRIMARY KEY, "playerId" text NOT NULL, "slotType" text NOT NULL,
        "itemId" text, quantity integer DEFAULT 1, UNIQUE ("playerId", "slotType")
      );
      CREATE TABLE bank_storage (
        id serial PRIMARY KEY, "playerId" text NOT NULL, "itemId" text NOT NULL,
        quantity integer NOT NULL, slot integer NOT NULL, "tabIndex" integer NOT NULL,
        UNIQUE ("playerId", "tabIndex", slot)
      );
      CREATE TABLE streaming_duel_preparations (
        "preparationId" text PRIMARY KEY, "fencingToken" bigint NOT NULL,
        "agent1Id" text NOT NULL, "agent2Id" text NOT NULL,
        "allowedBankActions" text[] NOT NULL, status text NOT NULL,
        "selectedAt" bigint NOT NULL, "expiresAt" bigint NOT NULL,
        "agent1ReadyAt" bigint, "agent2ReadyAt" bigint,
        "frozenAt" bigint, "cancelledAt" bigint,
        "cancellationReason" text, version integer NOT NULL DEFAULT 1
      );
      CREATE TABLE operations_log (
        id text PRIMARY KEY, "playerId" text NOT NULL, "operationType" text NOT NULL,
        "operationState" jsonb NOT NULL, completed boolean DEFAULT false,
        timestamp bigint NOT NULL, "completedAt" bigint
      );
    `);
    await pool.query(
      `INSERT INTO characters (id, "selectedSpell") VALUES ($1, NULL), ($2, NULL)`,
      [PLAYER_ID, OPPONENT_ID],
    );
    await pool.query(
      `INSERT INTO streaming_duel_preparations
        ("preparationId", "fencingToken", "agent1Id", "agent2Id",
         "allowedBankActions", status, "selectedAt", "expiresAt")
       VALUES ($1, 1, $2, $3, ARRAY['open','deposit','withdraw'], 'preparing', $4, $5)`,
      [preparationId, PLAYER_ID, OPPONENT_ID, Date.now(), Date.now() + 60_000],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'test_junk', 1, 0)`,
      [PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
       VALUES ($1, 'body', 'bronze_platebody', 1),
              ($1, 'weapon', 'bronze_longsword', 1)`,
      [PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO bank_storage ("playerId", "itemId", quantity, slot, "tabIndex")
       VALUES ($1, 'shortbow', 1, 0, 0),
              ($1, 'bronze_arrow', 50, 1, 0),
              ($1, 'lobster', 4, 2, 0),
              ($1, 'wizard_robe_top', 1, 3, 0)`,
      [PLAYER_ID],
    );

    const first = spawnWorker({
      connectionString,
      operationId,
      preparationId,
      hold: true,
    });
    const firstEvent = await first.event;
    if (firstEvent.event !== "committed" || firstEvent.replayed !== false) {
      throw new Error(
        `initial whole-plan commit failed: ${JSON.stringify(firstEvent)}`,
      );
    }
    first.child.kill("SIGKILL");
    await waitForExit(first.child);

    const recovered = spawnWorker({
      connectionString,
      operationId,
      preparationId,
      recover: true,
    });
    const recoveredEvent = await recovered.event;
    await waitForExit(recovered.child);
    if (
      recoveredEvent.event !== "committed" ||
      recoveredEvent.replayed !== true ||
      canonicalCompetitiveSnapshotJson(recoveredEvent.recoveryEvidence) !==
        canonicalCompetitiveSnapshotJson(RECOVERY_EVIDENCE)
    ) {
      throw new Error(
        `post-kill recovery receipt was not exact: ${JSON.stringify(recoveredEvent)}`,
      );
    }

    const evidenceCollision = spawnWorker({
      connectionString,
      operationId,
      preparationId,
      forgeRecoveryEvidence: true,
    });
    const evidenceCollisionEvent = await evidenceCollision.event;
    await waitForExit(evidenceCollision.child);
    if (
      evidenceCollisionEvent.event !== "error" ||
      !evidenceCollisionEvent.message?.includes(
        "duel_preparation_plan_operation_id_conflict",
      )
    ) {
      throw new Error(
        `recovery evidence collision was not rejected: ${JSON.stringify(evidenceCollisionEvent)}`,
      );
    }

    const stale = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      preparationId,
    });
    const staleEvent = await stale.event;
    await waitForExit(stale.child);
    if (
      staleEvent.event !== "error" ||
      !staleEvent.message?.includes("duel_preparation_plan_state_conflict")
    ) {
      throw new Error(
        `stale planner was not fenced: ${JSON.stringify(staleEvent)}`,
      );
    }

    await pool.query(
      `UPDATE streaming_duel_preparations
       SET status = 'ready', "agent1ReadyAt" = $2 WHERE "preparationId" = $1`,
      [preparationId, Date.now()],
    );
    const replay = spawnWorker({
      connectionString,
      operationId,
      preparationId,
    });
    const replayEvent = await replay.event;
    await waitForExit(replay.child);
    if (replayEvent.event !== "committed" || replayEvent.replayed !== true) {
      throw new Error(
        `durable replay after readiness failed: ${JSON.stringify(replayEvent)}`,
      );
    }

    const collision = spawnWorker({
      connectionString,
      operationId,
      preparationId,
      requestFingerprint: "forged-fingerprint",
    });
    const collisionEvent = await collision.event;
    await waitForExit(collision.child);
    if (
      collisionEvent.event !== "error" ||
      !collisionEvent.message?.includes(
        "duel_preparation_plan_operation_id_conflict",
      )
    ) {
      throw new Error(
        `operation collision was not rejected: ${JSON.stringify(collisionEvent)}`,
      );
    }

    const custodyViolation = spawnWorker({
      connectionString,
      operationId: randomUUID(),
      preparationId,
      violateCustody: true,
    });
    const custodyEvent = await custodyViolation.event;
    await waitForExit(custodyViolation.child);
    if (
      custodyEvent.event !== "error" ||
      !custodyEvent.message?.includes("duel_preparation_plan_custody_violation")
    ) {
      throw new Error(
        `custody violation was not rejected: ${JSON.stringify(custodyEvent)}`,
      );
    }

    const rollbackPreparationId = randomUUID();
    const rollbackOperationId = randomUUID();
    await pool.query(
      `INSERT INTO characters (id, "selectedSpell") VALUES ($1, NULL)`,
      [ROLLBACK_PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO streaming_duel_preparations
        ("preparationId", "fencingToken", "agent1Id", "agent2Id",
         "allowedBankActions", status, "selectedAt", "expiresAt")
       VALUES ($1, 2, $2, $3, ARRAY['open','deposit','withdraw'], 'preparing', $4, $5)`,
      [
        rollbackPreparationId,
        ROLLBACK_PLAYER_ID,
        OPPONENT_ID,
        Date.now(),
        Date.now() + 60_000,
      ],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, 'test_junk', 1, 0)`,
      [ROLLBACK_PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO equipment ("playerId", "slotType", "itemId", quantity)
       VALUES ($1, 'body', 'bronze_platebody', 1),
              ($1, 'weapon', 'bronze_longsword', 1)`,
      [ROLLBACK_PLAYER_ID],
    );
    await pool.query(
      `INSERT INTO bank_storage ("playerId", "itemId", quantity, slot, "tabIndex")
       VALUES ($1, 'shortbow', 1, 0, 0),
              ($1, 'bronze_arrow', 50, 1, 0),
              ($1, 'lobster', 4, 2, 0),
              ($1, 'wizard_robe_top', 1, 3, 0)`,
      [ROLLBACK_PLAYER_ID],
    );
    await pool.query(`
      CREATE FUNCTION reject_duel_plan_bank_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW."playerId" = '${ROLLBACK_PLAYER_ID}'
           AND NEW."itemId" = 'bronze_longsword' THEN
          RAISE EXCEPTION 'forced_duel_preparation_plan_rollback';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_duel_plan_bank_insert_trigger
      BEFORE INSERT ON bank_storage FOR EACH ROW
      EXECUTE FUNCTION reject_duel_plan_bank_insert();
    `);
    const rollbackDb = drizzle(pool, { schema });
    const rollbackDatabaseSystem = new DatabaseSystem({} as never);
    (rollbackDatabaseSystem as unknown as { db: typeof rollbackDb }).db =
      rollbackDb;
    (rollbackDatabaseSystem as unknown as { pool: pg.Pool }).pool = pool;
    let rollbackRejected = false;
    try {
      await rollbackDatabaseSystem.commitDuelPreparationPlanOperationAsync(
        requestFor(
          rollbackOperationId,
          rollbackPreparationId,
          BASE_FINGERPRINT,
          false,
          ROLLBACK_PLAYER_ID,
        ),
      );
    } catch (error) {
      rollbackRejected = errorMessageChain(error).includes(
        "forced_duel_preparation_plan_rollback",
      );
      if (!rollbackRejected) {
        process.stderr.write(
          `rollback rejection: ${errorMessageChain(error)}\n`,
        );
      }
    }
    if (!rollbackRejected) {
      throw new Error(
        "forced mid-transaction preparation failure was not rejected",
      );
    }

    await pool.query(
      `UPDATE streaming_duel_preparations
       SET "expiresAt" = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint - 1
       WHERE "preparationId" = $1`,
      [rollbackPreparationId],
    );
    let expiredRejected = false;
    try {
      await rollbackDatabaseSystem.commitDuelPreparationPlanOperationAsync(
        requestFor(
          randomUUID(),
          rollbackPreparationId,
          BASE_FINGERPRINT,
          false,
          ROLLBACK_PLAYER_ID,
        ),
      );
    } catch (error) {
      expiredRejected = errorMessageChain(error).includes(
        "duel_preparation_plan_preparation_expired",
      );
    }
    if (!expiredRejected) {
      throw new Error("database-clock preparation expiry was not enforced");
    }

    await pool.query(
      `UPDATE streaming_duel_preparations
       SET "expiresAt" = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 60000,
           "allowedBankActions" = ARRAY['open']
       WHERE "preparationId" = $1`,
      [rollbackPreparationId],
    );
    let actionPermissionRejected = false;
    try {
      await rollbackDatabaseSystem.commitDuelPreparationPlanOperationAsync(
        requestFor(
          randomUUID(),
          rollbackPreparationId,
          BASE_FINGERPRINT,
          false,
          ROLLBACK_PLAYER_ID,
        ),
      );
    } catch (error) {
      actionPermissionRejected = errorMessageChain(error).includes(
        "duel_preparation_plan_action_not_allowed",
      );
    }
    if (!actionPermissionRejected) {
      throw new Error("preparation bank action permission was not enforced");
    }

    const [rollbackInventory, rollbackEquipment, rollbackBank, rollbackOps] =
      await Promise.all([
        pool.query(
          `SELECT "itemId", quantity, "slotIndex" FROM inventory
           WHERE "playerId" = $1 ORDER BY "slotIndex"`,
          [ROLLBACK_PLAYER_ID],
        ),
        pool.query(
          `SELECT "slotType", "itemId", quantity FROM equipment
           WHERE "playerId" = $1 ORDER BY "slotType"`,
          [ROLLBACK_PLAYER_ID],
        ),
        pool.query(
          `SELECT "itemId", quantity, slot, "tabIndex" FROM bank_storage
           WHERE "playerId" = $1 ORDER BY "tabIndex", slot`,
          [ROLLBACK_PLAYER_ID],
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM operations_log
           WHERE "playerId" = $1`,
          [ROLLBACK_PLAYER_ID],
        ),
      ]);
    const midTransactionRollbackExact =
      JSON.stringify(rollbackInventory.rows) ===
        JSON.stringify([{ itemId: "test_junk", quantity: 1, slotIndex: 0 }]) &&
      JSON.stringify(rollbackEquipment.rows) ===
        JSON.stringify([
          { slotType: "body", itemId: "bronze_platebody", quantity: 1 },
          { slotType: "weapon", itemId: "bronze_longsword", quantity: 1 },
        ]) &&
      JSON.stringify(rollbackBank.rows) ===
        JSON.stringify([
          { itemId: "shortbow", quantity: 1, slot: 0, tabIndex: 0 },
          { itemId: "bronze_arrow", quantity: 50, slot: 1, tabIndex: 0 },
          { itemId: "lobster", quantity: 4, slot: 2, tabIndex: 0 },
          { itemId: "wizard_robe_top", quantity: 1, slot: 3, tabIndex: 0 },
        ]) &&
      rollbackOps.rows[0]?.count === "0";
    if (!midTransactionRollbackExact) {
      process.stderr.write(
        `${JSON.stringify({
          rollbackInventory: rollbackInventory.rows,
          rollbackEquipment: rollbackEquipment.rows,
          rollbackBank: rollbackBank.rows,
          rollbackOps: rollbackOps.rows,
        })}\n`,
      );
      throw new Error("mid-transaction failure left partial preparation state");
    }

    const [inventory, equipment, bank, character, operations] =
      await Promise.all([
        pool.query(
          `SELECT "itemId", quantity, "slotIndex" FROM inventory
           WHERE "playerId" = $1 ORDER BY "slotIndex"`,
          [PLAYER_ID],
        ),
        pool.query(
          `SELECT "slotType", "itemId", quantity FROM equipment
           WHERE "playerId" = $1 ORDER BY "slotType"`,
          [PLAYER_ID],
        ),
        pool.query(
          `SELECT "itemId", quantity, slot, "tabIndex" FROM bank_storage
           WHERE "playerId" = $1 ORDER BY "tabIndex", slot`,
          [PLAYER_ID],
        ),
        pool.query(`SELECT "selectedSpell" FROM characters WHERE id = $1`, [
          PLAYER_ID,
        ]),
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM operations_log WHERE id = $1`,
          [operationId],
        ),
      ]);
    const exactInventory =
      JSON.stringify(inventory.rows) ===
      JSON.stringify([
        { itemId: "lobster", quantity: 1, slotIndex: 0 },
        { itemId: "lobster", quantity: 1, slotIndex: 1 },
        { itemId: "lobster", quantity: 1, slotIndex: 2 },
        { itemId: "lobster", quantity: 1, slotIndex: 3 },
      ]);
    const exactEquipment =
      JSON.stringify(equipment.rows) ===
      JSON.stringify([
        { slotType: "arrows", itemId: "bronze_arrow", quantity: 50 },
        { slotType: "body", itemId: "wizard_robe_top", quantity: 1 },
        { slotType: "weapon", itemId: "shortbow", quantity: 1 },
      ]);
    const exactBank =
      JSON.stringify(bank.rows) ===
      JSON.stringify([
        { itemId: "test_junk", quantity: 1, slot: 0, tabIndex: 0 },
        { itemId: "bronze_longsword", quantity: 1, slot: 1, tabIndex: 0 },
        { itemId: "bronze_platebody", quantity: 1, slot: 2, tabIndex: 0 },
      ]);
    const exactAutocast = character.rows[0]?.selectedSpell === null;
    if (
      !exactInventory ||
      !exactEquipment ||
      !exactBank ||
      !exactAutocast ||
      operations.rows[0]?.count !== "1"
    ) {
      throw new Error("post-kill whole-plan custody was not exact");
    }

    process.stdout.write(
      `${JSON.stringify({
        processKilledAfterCommit: true,
        exactRecoveryReceiptAfterProcessKill: true,
        recoveryEvidenceCollisionRejected: true,
        durableReplayAfterReadiness: true,
        stalePlannerFenced: true,
        operationCollisionRejected: true,
        custodyViolationRejected: true,
        midTransactionRollbackExact,
        databaseClockExpiryRejected: expiredRejected,
        actionPermissionRejected,
        inventoryConserved: exactInventory,
        equipmentConserved: exactEquipment,
        bankConserved: exactBank,
        autocastExact: exactAutocast,
        receiptCount: Number(operations.rows[0]?.count ?? 0),
      })}\n`,
    );
  } finally {
    await pool?.end().catch(() => undefined);
    if (containerStarted) {
      await docker(["rm", "-f", containerName]).catch(() => undefined);
    }
  }
}

if (process.argv.includes("--worker")) {
  await runWorker();
} else {
  await runParent();
}
