import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import pg from "pg";

const execFileAsync = promisify(execFile);
const { Pool } = pg;

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
  throw new Error(`temporary PostgreSQL was not ready: ${String(lastError)}`);
}

async function applyMigration(pool: pg.Pool): Promise<void> {
  const sql = await readFile(
    new URL(
      "../src/database/migrations/0061_add_prayer_point_units.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const statement of sql.split(/\s*-->\s*statement-breakpoint\s*/u)) {
    if (statement.trim()) await pool.query(statement);
  }
}

async function snapshot(pool: pg.Pool): Promise<unknown[]> {
  const result = await pool.query(
    `SELECT
      id, "prayerPoints", "prayerPointUnits", "prayerMaxPoints", "activePrayers"
     FROM characters ORDER BY id`,
  );
  return result.rows;
}

async function run(): Promise<void> {
  const containerName = `hyperia-prayer-migration-${process.pid}`;
  const databaseUser = "prayer_migration_test";
  const databaseName = "prayer_migration_test";
  const databasePassword = `prayer-migration-${randomUUID()}`;
  const image =
    process.env.PRAYER_MIGRATION_POSTGRES_IMAGE?.trim() || "postgres:16-alpine";
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]).catch((error) => {
      throw new Error(
        `Docker is required for prayer migration verification: ${error}`,
      );
    });
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
    const port = Number(
      (await docker(["port", containerName, "5432/tcp"]))
        .trim()
        .split(":")
        .pop(),
    );
    assert(Number.isSafeInteger(port) && port > 0);
    const connectionString = `postgres://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${databaseName}`;
    pool = await waitForPostgres(connectionString);

    await pool.query(`
      CREATE TABLE characters (
        id text PRIMARY KEY,
        "prayerLevel" integer DEFAULT 1,
        "prayerPoints" integer DEFAULT 1,
        "prayerMaxPoints" integer DEFAULT 1,
        "activePrayers" jsonb DEFAULT '[]'::jsonb
      );
      INSERT INTO characters VALUES
        ('healthy', 5, 4, 5, '["battle_focus"]'::jsonb),
        ('zero-active', 5, 0, 5, '["battle_focus"]'::jsonb),
        ('overflow', 2, 99, 2,
          '["first_one","second_two","first_one","THIRD","fourth_four","fifth_five","sixth_six","seventh_seven"]'::jsonb),
        ('invalid-container', 3, 2, 3, '{"battle_focus":true}'::jsonb),
        ('invalid-max', 4, 4, 400, '[]'::jsonb);
    `);

    await applyMigration(pool);
    const first = await snapshot(pool);
    const firstHash = createHash("sha256")
      .update(JSON.stringify(first))
      .digest("hex");
    await applyMigration(pool);
    const second = await snapshot(pool);
    const secondHash = createHash("sha256")
      .update(JSON.stringify(second))
      .digest("hex");
    assert.deepEqual(second, first, "reapplying migration changed custody");

    const byId = new Map(
      second.map((row) => [
        (row as { id: string }).id,
        row as Record<string, unknown>,
      ]),
    );
    assert.deepEqual(byId.get("healthy"), {
      id: "healthy",
      prayerPoints: 4,
      prayerPointUnits: 4_000_000,
      prayerMaxPoints: 5,
      activePrayers: ["battle_focus"],
    });
    assert.deepEqual(byId.get("zero-active"), {
      id: "zero-active",
      prayerPoints: 0,
      prayerPointUnits: 0,
      prayerMaxPoints: 5,
      activePrayers: [],
    });
    assert.deepEqual(byId.get("overflow"), {
      id: "overflow",
      prayerPoints: 2,
      prayerPointUnits: 2_000_000,
      prayerMaxPoints: 2,
      activePrayers: [
        "first_one",
        "second_two",
        "fourth_four",
        "fifth_five",
        "sixth_six",
      ],
    });
    assert.deepEqual(byId.get("invalid-container")?.activePrayers, []);
    assert.equal(byId.get("invalid-max")?.prayerMaxPoints, 99);
    assert.equal(byId.get("invalid-max")?.prayerPointUnits, 4_000_000);

    await assert.rejects(
      pool.query(
        `UPDATE characters SET "prayerPointUnits" = 5000001 WHERE id = 'healthy'`,
      ),
      /characters_prayer_units_within_max/u,
    );
    await assert.rejects(
      pool.query(
        `UPDATE characters SET "prayerPointUnits" = -1 WHERE id = 'healthy'`,
      ),
      /characters_prayer_point_units_range/u,
    );

    process.stdout.write(
      `${JSON.stringify({
        migration: "0061_add_prayer_point_units",
        applied: true,
        idempotentReapply: firstHash === secondHash,
        legacyRowsNormalized: true,
        zeroPointPrayersDeactivated: true,
        exactUnitsBoundedByMax: true,
        structuralActivePrayerRepair: true,
        rowCount: second.length,
        fingerprint: secondHash,
      })}\n`,
    );
  } finally {
    await pool?.end().catch(() => undefined);
    if (containerStarted) {
      await docker(["rm", "-f", containerName]).catch(() => undefined);
    }
  }
}

await run();
