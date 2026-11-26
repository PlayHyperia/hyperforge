import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ITEMS } from "@hyperforge/shared";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import { executeAuthoritativeAgentBankTransfer } from "../src/eliza/AuthoritativeAgentBanking.js";
import {
  acknowledgeExternalAgentBankOperation,
  claimExternalAgentBankOperation,
  recoverExternalAgentBankOperation,
} from "../src/eliza/externalAgentBanking.js";

const CHARACTER_ID = "external-bank-process-kill-agent";
const ACCOUNT_ID = "external-bank-process-kill-account";
const ITEM_ID = "external_bank_process_kill_item";
const BANK_ID = "external-bank-process-kill-bank";

function registerItem(): void {
  ITEMS.set(ITEM_ID, {
    id: ITEM_ID,
    name: "External Bank Process Kill Item",
    type: "resource",
    stackable: true,
    description: "External banking process-kill proof item",
    examine: "External banking process-kill proof item.",
    tradeable: false,
    rarity: "common",
    modelPath: null,
    iconPath: "",
  } as never);
}

function createWorld(pool: pg.Pool) {
  let inventoryLocked = false;
  const entities = new Map<string, unknown>([
    [
      CHARACTER_ID,
      {
        id: CHARACTER_ID,
        position: [10, 0, 10],
        data: { position: [10, 0, 10], inStreamingDuel: false },
      },
    ],
    [
      BANK_ID,
      {
        id: BANK_ID,
        entityType: "bank",
        position: [11, 0, 11],
        data: { entityType: "bank", position: [11, 0, 11] },
      },
    ],
  ]);
  const inventory = {
    isInventoryReady: () => true,
    queueOperation: async (
      _playerId: string,
      operation: () => Promise<boolean>,
    ) => operation(),
    lockForTransaction: () => {
      if (inventoryLocked) return false;
      inventoryLocked = true;
      return true;
    },
    unlockTransaction: () => {
      inventoryLocked = false;
    },
    persistInventoryImmediate: async () => undefined,
    reloadFromDatabase: async () => {
      await pool.query(
        `SELECT "itemId", quantity FROM inventory WHERE "playerId" = $1`,
        [CHARACTER_ID],
      );
    },
  };
  return {
    pgPool: pool,
    entities: { get: (id: string) => entities.get(id) },
    getSystem: (name: string) => {
      if (name === "inventory") return inventory;
      if (name === "duel") return { isPlayerInDuel: () => false };
      return null;
    },
  };
}

async function runWriter(
  connectionString: string,
  operationId: string,
): Promise<never> {
  registerItem();
  const pool = new pg.Pool({ connectionString, max: 4 });
  const receipt = await executeAuthoritativeAgentBankTransfer({
    world: createWorld(pool) as never,
    playerId: CHARACTER_ID,
    bankId: BANK_ID,
    action: "deposit_all",
    retainedItems: [{ itemId: ITEM_ID, quantity: 2 }],
    operationId,
  });
  if (
    !receipt.success ||
    receipt.commitState !== "committed" ||
    receipt.committedQuantity !== 5 ||
    receipt.inventoryQuantityAfter !== 2 ||
    receipt.replayed
  ) {
    throw new Error(
      `external bank writer mismatch: ${JSON.stringify(receipt)}`,
    );
  }
  process.stdout.write("EXTERNAL_BANK_RECEIPT_AND_CUSTODY_COMMITTED\n");
  await new Promise<never>(() => {});
}

async function waitForMarker(
  child: ChildProcess,
  marker: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`external bank writer timeout: ${stderr}`)),
      20_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(marker)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!stdout.includes(marker)) {
        clearTimeout(timeout);
        reject(
          new Error(
            `external bank writer exited before commit: ${code ?? signal}: ${stderr}`,
          ),
        );
      }
    });
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function runParent(): Promise<void> {
  const baseUrl =
    process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      "Set AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL for the external bank process-kill proof",
    );
  }
  const databaseName = `hyperia_external_bank_kill_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const adminPool = new pg.Pool({ connectionString: adminUrl.toString() });
  let pool: pg.Pool | null = null;
  let child: ChildProcess | null = null;
  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(baseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 12 });
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../src/database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, 'External Bank Kill Account', 'user', '2026-08-10T00:00:00.000Z')`,
      [ACCOUNT_ID],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent")
       VALUES ($1, $2, 'External Bank Kill Agent', 1)`,
      [CHARACTER_ID, ACCOUNT_ID],
    );
    await pool.query(
      `INSERT INTO inventory ("playerId", "itemId", quantity, "slotIndex")
       VALUES ($1, $2, 7, 0)`,
      [CHARACTER_ID, ITEM_ID],
    );

    registerItem();
    const world = createWorld(pool) as never;
    const claim = await claimExternalAgentBankOperation(world, CHARACTER_ID, {
      action: "deposit_all",
      bankId: BANK_ID,
      itemId: null,
      quantity: 0,
      retainedItems: [{ itemId: ITEM_ID, quantity: 2 }],
    });
    if (claim.kind !== "claimed") {
      throw new Error("external bank writer could not claim durable waiter");
    }

    child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--writer",
        testUrl.toString(),
        claim.waiter.operationId,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForMarker(child, "EXTERNAL_BANK_RECEIPT_AND_CUSTODY_COMMITTED");
    if (!child.kill("SIGKILL")) {
      throw new Error("failed to kill external bank writer");
    }
    await waitForExit(child);

    const replacements = await Promise.all(
      Array.from({ length: 5 }, () =>
        recoverExternalAgentBankOperation(world, CHARACTER_ID),
      ),
    );
    if (
      replacements.some(
        (waiter) =>
          waiter?.operationId !== claim.waiter.operationId ||
          waiter.status !== "committed" ||
          waiter.receipt?.commitState !== "committed" ||
          waiter.receipt.committedQuantity !== 5,
      )
    ) {
      throw new Error(
        `external bank replacement mismatch: ${JSON.stringify(replacements)}`,
      );
    }
    if (
      !(await acknowledgeExternalAgentBankOperation(
        world,
        CHARACTER_ID,
        claim.waiter.operationId,
      ))
    ) {
      throw new Error("external bank terminal acknowledgement failed");
    }
    if (
      (await recoverExternalAgentBankOperation(world, CHARACTER_ID)) !== null
    ) {
      throw new Error("external bank waiter remained replayable after ack");
    }

    const proof = await pool.query<{
      receipt_count: string;
      carried: string;
      banked: string;
      waiter_completed: boolean;
      waiter_status: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM agent_bank_operations
           WHERE "operationId" = $2) AS receipt_count,
         COALESCE((SELECT SUM(quantity)::text FROM inventory
           WHERE "playerId" = $1 AND "itemId" = $3), '0') AS carried,
         COALESCE((SELECT SUM(quantity)::text FROM bank_storage
           WHERE "playerId" = $1 AND "itemId" = $3), '0') AS banked,
         (SELECT completed FROM operations_log WHERE id = $4) AS waiter_completed,
         (SELECT "operationState"->>'status' FROM operations_log
           WHERE id = $4) AS waiter_status`,
      [
        CHARACTER_ID,
        claim.waiter.operationId,
        ITEM_ID,
        `external-agent-bank-waiter:${CHARACTER_ID}`,
      ],
    );
    const row = proof.rows[0];
    if (
      row.receipt_count !== "1" ||
      row.carried !== "2" ||
      row.banked !== "5" ||
      row.waiter_completed !== true ||
      row.waiter_status !== "committed"
    ) {
      throw new Error(`external bank proof mismatch: ${JSON.stringify(row)}`);
    }
    process.stdout.write(
      `${JSON.stringify({
        writerKilledAfterCommit: true,
        exactReceiptRecoveredAfterRestart: true,
        fiveReplacementQueriesConverged: true,
        committedMutationNotReplayed: row.receipt_count === "1",
        exactCarriedQuantity: Number(row.carried),
        exactBankedQuantity: Number(row.banked),
        terminalAcknowledged: row.waiter_completed,
      })}\n`,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    ITEMS.delete(ITEM_ID);
    await pool?.end();
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [databaseName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  }
}

if (process.argv[2] === "--writer") {
  const connectionString = process.argv[3];
  const operationId = process.argv[4];
  if (!connectionString || !operationId) {
    throw new Error("external bank writer arguments missing");
  }
  await runWriter(connectionString, operationId);
} else {
  await runParent();
}
