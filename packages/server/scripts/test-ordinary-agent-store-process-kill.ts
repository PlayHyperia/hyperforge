import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ITEMS } from "@hyperforge/shared";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import {
  beginAgentAutonomyProgressionAttempt,
  recoverOpenAgentAutonomyProgressionAttempt,
} from "../src/eliza/agentAutonomyProgression.js";
import type { AgentInstance } from "../src/eliza/managers/AgentBehaviorTicker.js";
import {
  getOrdinaryStoreBuyOperationId,
  resolveOrdinaryStoreRecovery,
} from "../src/eliza/ordinaryAgentStore.js";
import { handleStoreBuy } from "../src/systems/ServerNetwork/handlers/store.js";

const BEFORE_ATTEMPT_ID = "2e05bce3-02a5-496f-a5ee-aafc98a89a76";
const PURCHASE_ATTEMPT_ID = "f25771e1-7472-46c6-820f-31537bc7533d";
const CHARACTER_ID = "ordinary-store-process-kill-agent";
const ACCOUNT_ID = "ordinary-store-process-kill-account";
const ITEM_ID = "ordinary_store_process_tool";
const STORE_ID = "ordinary_store_process_shop";
const TARGET_ID = "ordinary-store-process-shopkeeper";

type WriterMode = "before-action" | "after-commit" | "replay";

function makeInstance(): AgentInstance {
  return {
    config: {
      characterId: CHARACTER_ID,
      accountId: ACCOUNT_ID,
      name: "Ordinary Store Process Kill Agent",
    },
    goal: { type: "provisioning", description: "Buy a verified tool" },
    memories: [],
    recentActionLog: [],
    tickCounter: 0,
    pendingLlmResult: undefined,
  } as unknown as AgentInstance;
}

function registerItem(): void {
  ITEMS.set(ITEM_ID, {
    id: ITEM_ID,
    name: "Process Tool",
    type: "tool",
    stackable: false,
    value: 10,
  } as never);
}

async function runWriter(
  connectionString: string,
  mode: WriterMode,
): Promise<never> {
  registerItem();
  const pool = new pg.Pool({ connectionString, max: 4 });
  const attemptId =
    mode === "before-action" ? BEFORE_ATTEMPT_ID : PURCHASE_ATTEMPT_ID;
  await beginAgentAutonomyProgressionAttempt(pool, {
    attemptId,
    characterId: CHARACTER_ID,
    goalType: "provisioning",
    actionType: "storeBuy",
    decisionSource: "scripted",
    startedAt: mode === "before-action" ? 10_000 : 11_000,
  });
  if (mode === "before-action") {
    process.stdout.write("STORE_ATTEMPT_COMMITTED_BEFORE_MUTATION\n");
    await new Promise<never>(() => {});
  }

  const inventorySystem = {
    queueOperation: async (
      _playerId: string,
      operation: () => Promise<boolean>,
    ) => operation(),
    lockForTransaction: () => true,
    unlockTransaction: () => undefined,
    persistInventoryImmediate: async () => undefined,
    reloadFromDatabase: async () => undefined,
  };
  const target = {
    id: TARGET_ID,
    position: { x: 1, y: 0, z: 1 },
  };
  const world = {
    entities: new Map([[TARGET_ID, target]]),
    interactionSessionManager: {
      getSession: () => ({
        playerId: CHARACTER_ID,
        sessionType: "store",
        targetEntityId: TARGET_ID,
        targetStoreId: STORE_ID,
        openedAtTick: 0,
      }),
    },
    drizzleDb: createPostgresClientDatabase(pool),
    pgPool: pool,
    getSystem: (name: string) => {
      if (name === "inventory") return inventorySystem;
      if (name === "store") {
        return {
          getStore: () => ({
            id: STORE_ID,
            name: "Process Shop",
            items: [
              {
                id: ITEM_ID,
                itemId: ITEM_ID,
                price: 10,
                stockQuantity: -1,
              },
            ],
            buyback: true,
            buybackRate: 0.5,
          }),
        };
      }
      return undefined;
    },
    emit: () => undefined,
  };
  const socket = {
    id: `ordinary-store-process-${mode}`,
    player: {
      id: CHARACTER_ID,
      position: { x: 1, y: 0, z: 1 },
    },
    send: () => undefined,
  };
  const result = await handleStoreBuy(
    socket as never,
    {
      storeId: STORE_ID,
      itemId: ITEM_ID,
      quantity: 1,
      operationId: getOrdinaryStoreBuyOperationId(PURCHASE_ATTEMPT_ID),
    },
    world as never,
  );
  if (
    result.status !== "committed" ||
    result.replayed !== (mode === "replay")
  ) {
    throw new Error(`store writer result mismatch: ${JSON.stringify(result)}`);
  }
  process.stdout.write(
    mode === "replay"
      ? "STORE_RECEIPT_REPLAYED_WITHOUT_MUTATION\n"
      : "STORE_RECEIPT_AND_CUSTODY_COMMITTED\n",
  );
  await new Promise<never>(() => {});
}

async function waitForWriterReady(
  child: ReturnType<typeof spawn>,
  marker: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(
      () => reject(new Error(`store writer readiness timeout: ${errors}`)),
      20_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!output.includes(marker)) {
        clearTimeout(timeout);
        reject(
          new Error(
            `store writer exited before readiness: ${code ?? signal}: ${errors}`,
          ),
        );
      }
    });
  });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function spawnAndKill(
  connectionString: string,
  mode: WriterMode,
  marker: string,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--writer", connectionString, mode],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await waitForWriterReady(child, marker);
    if (!child.kill("SIGKILL")) {
      throw new Error(`failed to kill ${mode} store writer`);
    }
    await waitForExit(child);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
  }
}

async function runParent(): Promise<void> {
  const baseUrl =
    process.env.AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      "Set AGENT_AUTONOMY_PROGRESSION_TEST_DATABASE_URL for the store process-kill proof",
    );
  }
  const databaseName = `hyperia_store_kill_${process.pid}_${Date.now().toString(36)}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const adminPool = new pg.Pool({
    connectionString: adminUrl.toString(),
    max: 2,
  });
  let pool: pg.Pool | null = null;

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
       VALUES ($1, 'Ordinary Store Kill Account', 'user', '2026-08-10T00:00:00.000Z')`,
      [ACCOUNT_ID],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name, "isAgent", coins)
       VALUES ($1, $2, 'Ordinary Store Kill Agent', 1, 100)`,
      [CHARACTER_ID, ACCOUNT_ID],
    );

    await spawnAndKill(
      testUrl.toString(),
      "before-action",
      "STORE_ATTEMPT_COMMITTED_BEFORE_MUTATION",
    );
    const beforeRecovery = await recoverOpenAgentAutonomyProgressionAttempt(
      pool,
      makeInstance(),
      10_500,
      resolveOrdinaryStoreRecovery,
    );
    if (
      beforeRecovery?.checkpoint.lastActionOutcome !==
        "unknown_after_restart" ||
      beforeRecovery.checkpoint.lastAppliedActionType !== null
    ) {
      throw new Error("pre-mutation kill was not recovered as unknown");
    }

    await spawnAndKill(
      testUrl.toString(),
      "after-commit",
      "STORE_RECEIPT_AND_CUSTODY_COMMITTED",
    );
    await spawnAndKill(
      testUrl.toString(),
      "replay",
      "STORE_RECEIPT_REPLAYED_WITHOUT_MUTATION",
    );

    const replacements = await Promise.all(
      Array.from({ length: 5 }, () =>
        recoverOpenAgentAutonomyProgressionAttempt(
          pool!,
          makeInstance(),
          11_500,
          resolveOrdinaryStoreRecovery,
        ),
      ),
    );
    const recovered = replacements.filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    if (
      recovered.length !== 1 ||
      recovered[0].checkpoint.lastActionOutcome !== "completed" ||
      recovered[0].checkpoint.lastAppliedActionType !== "storeBuy"
    ) {
      throw new Error(
        `store recovery winner mismatch: ${JSON.stringify(recovered)}`,
      );
    }

    const proof = await pool.query<{
      coins: number;
      item_quantity: string;
      receipt_count: string;
      terminal_source: string;
      terminal_outcome: string;
      applied_action: string;
      open_attempt_id: string | null;
    }>(
      `SELECT coins,
         COALESCE((SELECT sum(quantity)::text FROM inventory
          WHERE "playerId" = $1 AND "itemId" = $2), '0') AS item_quantity,
         (SELECT count(*)::text FROM agent_store_operations
          WHERE operation_id = $3) AS receipt_count,
         (SELECT event_source FROM agent_autonomy_progression_events
          WHERE attempt_id = $4 AND event_type = 'attempt_terminal') AS terminal_source,
         (SELECT action_outcome FROM agent_autonomy_progression_events
          WHERE attempt_id = $4 AND event_type = 'attempt_terminal') AS terminal_outcome,
         (SELECT applied_action_type FROM agent_autonomy_progression_events
          WHERE attempt_id = $4 AND event_type = 'attempt_terminal') AS applied_action,
         (SELECT open_attempt_id FROM agent_autonomy_progression_heads
          WHERE character_id = $1) AS open_attempt_id
       FROM characters WHERE id = $1`,
      [
        CHARACTER_ID,
        ITEM_ID,
        getOrdinaryStoreBuyOperationId(PURCHASE_ATTEMPT_ID),
        PURCHASE_ATTEMPT_ID,
      ],
    );
    const row = proof.rows[0];
    if (
      row.coins !== 90 ||
      row.item_quantity !== "1" ||
      row.receipt_count !== "1" ||
      row.terminal_source !== "restart_reconciliation" ||
      row.terminal_outcome !== "completed" ||
      row.applied_action !== "storeBuy" ||
      row.open_attempt_id !== null
    ) {
      throw new Error(
        `store process-kill proof mismatch: ${JSON.stringify(row)}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        killedBeforeMutationRecoveredUnknown: true,
        killedAfterReceiptAndCustodyCommit: true,
        replacementProcessReplayedReceipt: true,
        committedPurchaseNotReplayed: row.receipt_count === "1",
        exactCoinsAfter: row.coins,
        exactInventoryQuantityAfter: Number(row.item_quantity),
        oneOfFiveReplacementWorkersRecovered: recovered.length === 1,
        terminalSource: row.terminal_source,
        terminalOutcome: row.terminal_outcome,
      })}\n`,
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

if (process.argv[2] === "--writer") {
  const connectionString = process.argv[3];
  const mode = process.argv[4] as WriterMode;
  if (
    !connectionString ||
    !["before-action", "after-commit", "replay"].includes(mode)
  ) {
    throw new Error("writer requires connection string and valid mode");
  }
  await runWriter(connectionString, mode);
} else {
  await runParent();
}
