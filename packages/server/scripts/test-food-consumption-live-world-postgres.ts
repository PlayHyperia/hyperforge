#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import pg from "pg";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "../..");
const FRAMEWORK_PATH = path.join(
  REPO_ROOT,
  "packages/shared/build/framework.js",
);
const RUN_GENERIC_HEALTH_OUTAGE =
  process.env.TEST_GENERIC_HEALTH_OUTAGE === "true";
const REPORT_PATH = path.join(
  REPO_ROOT,
  RUN_GENERIC_HEALTH_OUTAGE
    ? "artifacts/player-health-live-world-outage-20260828/evidence.json"
    : "artifacts/food-consumption-live-world-outage-20260828/evidence.json",
);
const PLAYER_ID = "food-live-world-agent";
const CONTAINER_NAME = `hyperia-food-live-world-${process.pid}`;

type FoodReceipt = {
  ok: boolean;
  committed: boolean;
  consumed: boolean;
  operationId: string;
  reason?: string;
  healedAmount: number;
  newHealth: number | null;
};

function assert(
  condition: unknown,
  message: string,
  details?: unknown,
): asserts condition {
  if (condition) return;
  throw new Error(
    details === undefined ? message : `${message}: ${JSON.stringify(details)}`,
  );
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function docker(args: string[]): Promise<string> {
  const result = await execFileAsync(
    process.env.DOCKER_BIN?.trim() || "docker",
    args,
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return result.stdout.trim();
}

async function waitForPostgres(connectionString: string): Promise<pg.Pool> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 1_000,
      statement_timeout: 1_500,
      query_timeout: 2_500,
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
  throw new Error(`temporary PostgreSQL did not recover: ${String(lastError)}`);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function readDurableState(pool: pg.Pool): Promise<{
  health: number;
  inventoryRows: number;
  completedReceipts: number;
  pendingReceipts: number;
}> {
  const result = await pool.query<{
    health: number;
    inventory_rows: number;
    completed_receipts: number;
    pending_receipts: number;
  }>(
    `SELECT
       (SELECT health FROM characters WHERE id = $1) AS health,
       (SELECT count(*)::int FROM inventory WHERE "playerId" = $1) AS inventory_rows,
       (SELECT count(*)::int FROM operations_log
          WHERE "playerId" = $1 AND "operationType" = 'food_consumption'
            AND completed = true) AS completed_receipts,
       (SELECT count(*)::int FROM operations_log
          WHERE "playerId" = $1 AND "operationType" = 'food_consumption'
            AND completed = false) AS pending_receipts`,
    [PLAYER_ID],
  );
  const row = result.rows[0];
  assert(row, "durable food state was absent");
  return {
    health: Number(row.health),
    inventoryRows: Number(row.inventory_rows),
    completedReceipts: Number(row.completed_receipts),
    pendingReceipts: Number(row.pending_receipts),
  };
}

async function main(): Promise<void> {
  const databaseUser = "food_live_world";
  const databaseName = "food_live_world";
  const databasePassword = `food-${randomUUID()}`;
  let containerStarted = false;
  let containerPaused = false;
  let verificationPool: pg.Pool | null = null;
  let world: any = null;
  let worldDatabase: any = null;
  let closeDatabase: (() => Promise<void>) | null = null;
  let report: Record<string, unknown> | null = null;

  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(`Docker is required for the food outage gate: ${error}`);
    });
    await docker([
      "run",
      "--rm",
      "-d",
      "--name",
      CONTAINER_NAME,
      "-e",
      `POSTGRES_USER=${databaseUser}`,
      "-e",
      `POSTGRES_PASSWORD=${databasePassword}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      "127.0.0.1::5432",
      process.env.FOOD_LIVE_WORLD_POSTGRES_IMAGE?.trim() ||
        "postgres:16-alpine",
    ]);
    containerStarted = true;
    const port = Number(
      (await docker(["port", CONTAINER_NAME, "5432/tcp"])).split(":").pop(),
    );
    assert(Number.isSafeInteger(port) && port > 0, "invalid PostgreSQL port");
    const connectionString = `postgres://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${databaseName}`;
    verificationPool = await waitForPostgres(connectionString);

    process.chdir(path.join(SERVER_DIR, "world"));
    process.env.HYPERIA_DATA_DIR = path.join(SERVER_DIR, "world");
    process.env.ASSETS_DIR = path.join(SERVER_DIR, "world/assets");
    process.env.POSTGRES_CONNECTION_TIMEOUT_MS = "1000";
    process.env.POSTGRES_STATEMENT_TIMEOUT_MS = "1500";
    process.env.POSTGRES_QUERY_TIMEOUT_MS = "2500";

    const frameworkBytes = await readFile(FRAMEWORK_PATH);
    const frameworkStat = await stat(FRAMEWORK_PATH);
    assert(
      frameworkBytes.byteLength > 1_000_000,
      "production framework absent",
    );
    const framework = await import(pathToFileURL(FRAMEWORK_PATH).href);
    const [databaseModule, databaseClient, databaseAdapter] = await Promise.all(
      [
        import("../src/systems/DatabaseSystem/index.ts"),
        import("../src/database/client.ts"),
        import("../src/database/adapter.ts"),
      ],
    );
    const initialized =
      await databaseClient.initializeDatabase(connectionString);
    closeDatabase = databaseClient.closeDatabase;

    class LiveWorldServerBoundary extends framework.SystemClass {
      id = "food-live-world-server";
      isServer = true;
      isClient = false;
      send(): void {}
    }

    world = await framework.createServerWorld();
    world.register("database", databaseModule.DatabaseSystem);
    world.register("network", LiveWorldServerBoundary);
    world.pgPool = initialized.pool;
    world.drizzleDb = initialized.db;
    await world.init({
      assetsDir: path.join(SERVER_DIR, "world/assets"),
      storage: new framework.NodeStorage(),
      physics: false,
      renderer: "headless",
      db: databaseAdapter.createDrizzleAdapter(initialized.db),
    });
    worldDatabase = world.getSystem("database");

    await verificationPool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ('food-live-world-account', 'Food Live World', 'test', $1)`,
      [new Date().toISOString()],
    );
    await verificationPool.query(
      `INSERT INTO characters
         (id, "accountId", name, health, "maxHealth", "constitutionLevel", "isAgent")
       VALUES ($1, 'food-live-world-account', 'Food Recovery Agent', 4, 10, 10, 1)`,
      [PLAYER_ID],
    );
    await verificationPool.query(
      `INSERT INTO inventory
         ("playerId", "itemId", quantity, "slotIndex", metadata)
       VALUES ($1, 'shrimp', 1, 0, NULL), ($1, 'shrimp', 1, 1, NULL)`,
      [PLAYER_ID],
    );

    const player = world.entities.add({
      id: PLAYER_ID,
      type: "player",
      name: "Food Recovery Agent",
      playerId: PLAYER_ID,
      playerName: "Food Recovery Agent",
      position: [0, 40, 0],
      quaternion: [0, 0, 0, 1],
      isAgent: true,
      isEmbeddedAgent: true,
    });
    world.emit(framework.EventType.PLAYER_REGISTERED, { playerId: PLAYER_ID });
    world.emit(framework.EventType.PLAYER_JOINED, {
      playerId: PLAYER_ID,
      player,
      inventory: [
        { slotIndex: 0, itemId: "shrimp", quantity: 1 },
        { slotIndex: 1, itemId: "shrimp", quantity: 1 },
      ],
      equipment: [],
      isAgent: true,
    });

    const playerSystem = world.getSystem("player");
    const inventorySystem = world.getSystem("inventory");
    const healthRegenSystem = world.getSystem("health-regen");
    assert(playerSystem && inventorySystem, "live player systems were absent");
    assert(healthRegenSystem, "live health regeneration system was absent");
    healthRegenSystem.update = () => undefined;
    try {
      await waitFor(
        () =>
          playerSystem.getPlayerHealth(PLAYER_ID)?.current === 4 &&
          inventorySystem.getInventory(PLAYER_ID)?.items.length === 2,
        "live player health/inventory did not hydrate",
      );
    } catch (error) {
      throw new Error(
        `${String(error)}: ${JSON.stringify({
          health: playerSystem.getPlayerHealth(PLAYER_ID) ?? null,
          inventory:
            inventorySystem
              .getInventory(PLAYER_ID)
              ?.items.map(
                (item: { itemId: string; quantity: number; slot: number }) => ({
                  itemId: item.itemId,
                  quantity: item.quantity,
                  slot: item.slot,
                }),
              ) ?? null,
          durable: await readDurableState(verificationPool),
        })}`,
      );
    }
    await waitFor(
      () =>
        worldDatabase.pendingOperations?.size === 0 &&
        worldDatabase.pendingSaveBuffer?.size === 0,
      "initial live database writes did not quiesce",
      5_000,
    );
    const initialDurable = await readDurableState(verificationPool);
    assert(
      initialDurable.health === 4 &&
        initialDurable.inventoryRows === 2 &&
        initialDurable.completedReceipts === 0 &&
        initialDurable.pendingReceipts === 0,
      "initial durable food state was not quiescent",
      initialDurable,
    );

    world.currentTick = 100;
    const firstOperationId = `food-debit:${randomUUID()}`;
    await docker(["pause", CONTAINER_NAME]);
    containerPaused = true;
    const preCommitOutage = (await playerSystem.consumeFoodAtomic(
      PLAYER_ID,
      "shrimp",
      0,
      firstOperationId,
    )) as FoodReceipt;
    assert(
      preCommitOutage.ok === false &&
        preCommitOutage.committed === false &&
        preCommitOutage.consumed === false &&
        preCommitOutage.reason === "persistence_failed",
      "pre-commit outage did not fail ambiguously and closed",
      preCommitOutage,
    );
    assert(
      playerSystem.getPlayerHealth(PLAYER_ID)?.current === 4 &&
        inventorySystem.getInventory(PLAYER_ID)?.items.length === 2,
      "pre-commit outage mutated live health or inventory",
      {
        health: playerSystem.getPlayerHealth(PLAYER_ID) ?? null,
        inventory:
          inventorySystem
            .getInventory(PLAYER_ID)
            ?.items.map(
              (item: { itemId: string; quantity: number; slot: number }) => ({
                itemId: item.itemId,
                quantity: item.quantity,
                slot: item.slot,
              }),
            ) ?? null,
      },
    );

    await docker(["unpause", CONTAINER_NAME]);
    containerPaused = false;
    await verificationPool.end();
    verificationPool = await waitForPostgres(connectionString);
    try {
      await waitFor(async () => {
        world.currentTick += 1;
        playerSystem.update(0.6);
        const durable = await readDurableState(verificationPool!);
        return (
          playerSystem.getPlayerHealth(PLAYER_ID)?.current === 7 &&
          inventorySystem.getInventory(PLAYER_ID)?.items.length === 1 &&
          durable.health === 7 &&
          durable.inventoryRows === 1 &&
          durable.completedReceipts === 1 &&
          durable.pendingReceipts === 0
        );
      }, "same-world ambiguous custody recovery did not converge");
    } catch (error) {
      throw new Error(
        `${String(error)}: ${JSON.stringify({
          worldIsServer: world.isServer ?? null,
          networkIsServer: world.network?.isServer ?? null,
          pendingCustodyAttempts: Array.from(
            playerSystem.pendingFoodCustodyAttempts?.entries?.() ?? [],
          ),
          recoveryPlayersInFlight: Array.from(
            playerSystem.foodRecoveryPlayersInFlight?.values?.() ?? [],
          ),
          health: playerSystem.getPlayerHealth(PLAYER_ID) ?? null,
          inventory:
            inventorySystem
              .getInventory(PLAYER_ID)
              ?.items.map(
                (item: { itemId: string; quantity: number; slot: number }) => ({
                  itemId: item.itemId,
                  quantity: item.quantity,
                  slot: item.slot,
                }),
              ) ?? null,
          durable: await readDurableState(verificationPool),
        })}`,
      );
    }
    const afterPreCommitRecovery = await readDurableState(verificationPool);

    world.currentTick += 4;
    const secondSlot = inventorySystem.getInventory(PLAYER_ID)?.items[0]?.slot;
    assert(Number.isSafeInteger(secondSlot), "second shrimp slot was absent");
    const secondOperationId = `food-debit:${randomUUID()}`;
    const originalComplete =
      worldDatabase.completeFoodConsumptionOperationAsync.bind(worldDatabase);
    let completionFaultInjected = false;
    worldDatabase.completeFoodConsumptionOperationAsync = async (
      request: Record<string, unknown>,
    ) => {
      if (
        request.operationId === secondOperationId &&
        !completionFaultInjected
      ) {
        completionFaultInjected = true;
        await docker(["pause", CONTAINER_NAME]);
        containerPaused = true;
      }
      return originalComplete(request);
    };

    const postCommitOutage = (await playerSystem.consumeFoodAtomic(
      PLAYER_ID,
      "shrimp",
      secondSlot,
      secondOperationId,
    )) as FoodReceipt;
    assert(
      completionFaultInjected &&
        postCommitOutage.ok === false &&
        postCommitOutage.committed === true &&
        postCommitOutage.consumed === true &&
        postCommitOutage.reason === "effect_completion_pending" &&
        postCommitOutage.healedAmount === 3 &&
        postCommitOutage.newHealth === 10,
      "post-commit outage did not retain the exact pending live effect",
      postCommitOutage,
    );
    assert(
      playerSystem.getPlayerHealth(PLAYER_ID)?.current === 10 &&
        inventorySystem.getInventory(PLAYER_ID)?.items.length === 0,
      "post-commit outage did not preserve the live optimistic boundary",
    );

    // Force the ordinary 30-second autosave race deterministically. The full
    // character snapshot is queued while PostgreSQL is paused and before the
    // recovery transaction. It must save unrelated fields without persisting
    // the optimistic food delta independently of its custody receipt.
    const overlappingAutoSaveStartedAt = Date.now();
    const overlappingAutoSave = playerSystem.saveAllPlayersToDatabase();
    await new Promise((resolve) => setTimeout(resolve, 100));

    await docker(["unpause", CONTAINER_NAME]);
    containerPaused = false;
    await verificationPool.end();
    verificationPool = await waitForPostgres(connectionString);
    await overlappingAutoSave;
    const overlappingAutoSaveDurationMs =
      Date.now() - overlappingAutoSaveStartedAt;
    try {
      await waitFor(async () => {
        world.currentTick += 1;
        playerSystem.update(0.6);
        const durable = await readDurableState(verificationPool!);
        return (
          playerSystem.getPlayerHealth(PLAYER_ID)?.current === 10 &&
          inventorySystem.getInventory(PLAYER_ID)?.items.length === 0 &&
          durable.health === 10 &&
          durable.inventoryRows === 0 &&
          durable.completedReceipts === 2 &&
          durable.pendingReceipts === 0
        );
      }, "same-world pending health recovery did not converge");
    } catch (error) {
      const operation = await verificationPool.query(
        `SELECT completed, "operationState" FROM operations_log WHERE id = $1`,
        [secondOperationId],
      );
      throw new Error(
        `${String(error)}: ${JSON.stringify({
          pendingLiveEffects: Array.from(
            playerSystem.pendingFoodLiveEffects?.entries?.() ?? [],
          ),
          pendingOperationByPlayer: Array.from(
            playerSystem.pendingFoodOperationByPlayer?.entries?.() ?? [],
          ),
          recoveryPlayersInFlight: Array.from(
            playerSystem.foodRecoveryPlayersInFlight?.values?.() ?? [],
          ),
          foodActionsInFlight: Array.from(
            playerSystem.foodActionsInFlight?.values?.() ?? [],
          ),
          databaseOperationsInFlight: Array.from(
            worldDatabase.pendingOperations?.values?.() ?? [],
          ),
          health: playerSystem.getPlayerHealth(PLAYER_ID) ?? null,
          inventory:
            inventorySystem
              .getInventory(PLAYER_ID)
              ?.items.map(
                (item: { itemId: string; quantity: number; slot: number }) => ({
                  itemId: item.itemId,
                  quantity: item.quantity,
                  slot: item.slot,
                }),
              ) ?? null,
          durable: await readDurableState(verificationPool),
          operation: operation.rows,
        })}`,
      );
    }
    const final = await readDurableState(verificationPool);

    const replay = (await playerSystem.consumeFoodAtomic(
      PLAYER_ID,
      "shrimp",
      secondSlot,
      secondOperationId,
    )) as FoodReceipt;
    assert(
      replay.ok === true &&
        replay.operationId === secondOperationId &&
        replay.newHealth === 10,
      "same-world terminal replay was not exact",
      replay,
    );
    const afterReplay = await readDurableState(verificationPool);
    assert(
      JSON.stringify(afterReplay) === JSON.stringify(final),
      "terminal replay changed durable truth",
      { final, afterReplay },
    );

    let genericHealthOutage: Record<string, unknown> | undefined;
    if (RUN_GENERIC_HEALTH_OUTAGE) {
      const genericOutageStartedAt = Date.now();
      await docker(["pause", CONTAINER_NAME]);
      containerPaused = true;
      assert(
        playerSystem.damagePlayer(PLAYER_ID, 4) &&
          playerSystem.getPlayerHealth(PLAYER_ID)?.current === 6,
        "first generic health mutation was not applied",
      );
      await waitFor(
        () => worldDatabase.playerSaveFlushInFlight === true,
        "generic player save did not enter the outage boundary",
        5_000,
      );

      // Let the first snapshot remain in flight, then author a newer mixed
      // heal/damage state. The failed older batch must never overwrite it.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      assert(
        playerSystem.healPlayer(PLAYER_ID, 1) &&
          playerSystem.damagePlayer(PLAYER_ID, 2) &&
          playerSystem.getPlayerHealth(PLAYER_ID)?.current === 5,
        "newer generic health snapshot was not applied during the outage",
      );
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      await docker(["unpause", CONTAINER_NAME]);
      containerPaused = false;
      await verificationPool.end();
      verificationPool = await waitForPostgres(connectionString);
      await waitFor(async () => {
        const durable = await readDurableState(verificationPool!);
        return (
          durable.health === 5 &&
          durable.inventoryRows === 0 &&
          durable.completedReceipts === 2 &&
          durable.pendingReceipts === 0 &&
          worldDatabase.pendingSaveBuffer?.size === 0 &&
          worldDatabase.pendingSaveFieldRevisions?.size === 0 &&
          worldDatabase.playerSaveFlushInFlight === false
        );
      }, "latest generic health snapshot did not recover after PostgreSQL returned");
      const recovered = await readDurableState(verificationPool);
      genericHealthOutage = {
        firstInFlightSnapshot: { health: 6, maxHealth: 10 },
        newerLiveSnapshotDuringOutage: { health: 5, maxHealth: 10 },
        recoveredWithoutRestart: recovered,
        pendingSavePlayers: worldDatabase.pendingSaveBuffer?.size ?? null,
        pendingRevisionPlayers:
          worldDatabase.pendingSaveFieldRevisions?.size ?? null,
        durationMs: Date.now() - genericOutageStartedAt,
      };
    }

    report = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      scope: RUN_GENERIC_HEALTH_OUTAGE
        ? "production-built live world food custody plus latest generic health snapshot recovery across real PostgreSQL outages without a world restart"
        : "production-built live world food custody and health recovery across real PostgreSQL outages without a world restart",
      runtime: {
        bun: Bun.version,
        postgres: "16-alpine owned temporary container",
        framework: {
          path: path.relative(REPO_ROOT, FRAMEWORK_PATH),
          bytes: frameworkBytes.byteLength,
          modifiedAt: frameworkStat.mtime.toISOString(),
          sha256: sha256(frameworkBytes),
        },
        registeredSystems: {
          player: playerSystem.constructor.name,
          inventory: inventorySystem.constructor.name,
          database: worldDatabase.constructor.name,
        },
      },
      preCommitOutage: {
        operationId: firstOperationId,
        receipt: preCommitOutage,
        liveDuringOutage: { health: 4, inventoryRows: 2 },
        recoveredWithoutRestart: afterPreCommitRecovery,
      },
      postCommitOutage: {
        operationId: secondOperationId,
        receipt: postCommitOutage,
        liveDuringOutage: { health: 10, inventoryRows: 0 },
        recoveredWithoutRestart: final,
        exactReplayNoMutation: true,
      },
      ...(genericHealthOutage ? { genericHealthOutage } : {}),
      assertions: {
        exactFoodUnitsConserved: 2,
        exactHealthDelta: 6,
        completedReceipts: 2,
        pendingReceipts: 0,
        duplicateDebit: false,
        duplicateHeal: false,
        worldRestartRequired: false,
        ...(genericHealthOutage
          ? {
              genericLatestHealthSnapshot: 5,
              genericOlderSnapshotOverwroteNewer: false,
              genericPendingSavePlayers: 0,
            }
          : {}),
        externalValue: false,
        productionEquivalentInfrastructure: false,
      },
      controlledFaultIsolation: [
        RUN_GENERIC_HEALTH_OUTAGE
          ? "Passive health regeneration update disabled so every health mutation during bounded database timeouts is explicitly authored by the food and generic-health harness phases."
          : "Passive health regeneration update disabled so only food custody/effect may change health during bounded database timeouts.",
      ],
      forcedOverlap: {
        ordinaryCharacterAutoSaveQueuedDuringPostCommitOutage: true,
        completedAfterDatabaseRestore: true,
        durationMs: overlappingAutoSaveDurationMs,
      },
    };
  } finally {
    if (containerPaused) {
      await docker(["unpause", CONTAINER_NAME]).catch(() => undefined);
    }
    await worldDatabase?.waitForPendingOperations?.().catch(() => undefined);
    world?.destroy?.();
    await closeDatabase?.().catch(() => undefined);
    await verificationPool?.end().catch(() => undefined);
    if (containerStarted) {
      await docker(["rm", "-f", CONTAINER_NAME]);
      containerStarted = false;
    }
  }

  assert(report, "food outage evidence was not produced");
  report.cleanup = {
    ownedTemporaryContainerRemoved: !containerStarted,
    externalServicesTouched: false,
  };
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: "passed", report: REPORT_PATH }));
}

await main();
