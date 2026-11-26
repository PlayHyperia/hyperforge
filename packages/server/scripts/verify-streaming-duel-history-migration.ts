import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { normalizePersistedRecentDuel } from "../src/systems/StreamingDuelScheduler/managers/MatchmakingManager.js";

const connectionString = (
  process.env.STREAMING_MIGRATION_VERIFY_DATABASE_URL || ""
).trim();
const allowReset =
  process.env.STREAMING_MIGRATION_VERIFY_ALLOW_RESET === "true";

assert(
  connectionString,
  "STREAMING_MIGRATION_VERIFY_DATABASE_URL must point to a disposable database",
);
const databaseName = decodeURIComponent(
  new URL(connectionString).pathname.replace(/^\//, ""),
);
assert.match(
  databaseName,
  /^hyperia_streaming_history_verify_[a-z0-9_]+$/,
  "Verification database name must start with hyperia_streaming_history_verify_",
);
assert(
  allowReset,
  "Set STREAMING_MIGRATION_VERIFY_ALLOW_RESET=true to confirm the disposable database may be reset",
);

const migrations = [
  "0052_add_streaming_duel_history.sql",
  "0055_add_streaming_duel_outcomes.sql",
  "0058_add_streaming_duel_cancellations.sql",
  "0068_add_streaming_duel_opening_styles.sql",
];

const applyMigration = async (client: Client, filename: string) => {
  const sql = await readFile(
    new URL(`../src/database/migrations/${filename}`, import.meta.url),
    "utf8",
  );
  for (const statement of sql.split(/\s*-->\s*statement-breakpoint\s*/u)) {
    if (statement.trim()) await client.query(statement);
  }
};

const historyRows = async (client: Client) => {
  const result = await client.query(
    'SELECT * FROM "streaming_duel_history" ORDER BY "id"',
  );
  return result.rows.map((row) => ({
    ...row,
    finishedAt: Number(row.finishedAt),
  }));
};

const historyFingerprint = (rows: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(rows)).digest("hex");

const client = new Client({ connectionString });
await client.connect();

try {
  const existingTables = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  assert.deepEqual(
    existingTables.rows,
    [],
    "Disposable verification database must not contain public tables",
  );

  await applyMigration(client, migrations[0]);
  await client.query(`
    INSERT INTO "streaming_duel_history" (
      "cycleId", "duelId", "finishedAt",
      "winnerId", "winnerName", "loserId", "loserName", "winReason",
      "damageWinner", "damageLoser"
    ) VALUES (
      'legacy-before-migration', 'duel-legacy', 100,
      'agent-a', 'Astra', 'agent-b', 'Riven', 'kill', 25, 10
    )
  `);

  await applyMigration(client, migrations[1]);
  await client.query(`
    INSERT INTO "streaming_duel_history" (
      "cycleId", "duelId", "finishedAt", "outcome",
      "agent1Id", "agent1Name", "agent2Id", "agent2Name", "winReason",
      "damageAgent1", "damageAgent2"
    ) VALUES (
      'draw-after-migration', 'duel-draw', 200, 'draw',
      'agent-a', 'Astra', 'agent-b', 'Riven', 'draw', 14, 14
    )
  `);

  await applyMigration(client, migrations[2]);
  await applyMigration(client, migrations[2]);
  await client.query(`
    INSERT INTO "streaming_duel_history" (
      "cycleId", "duelId", "finishedAt", "outcome", "cancellationReason",
      "damageAgent1", "damageAgent2"
    ) VALUES (
      'cancel-after-migration', NULL, 300, 'cancelled', 'agents_missing', 0, 0
    )
  `);

  await applyMigration(client, migrations[3]);
  await applyMigration(client, migrations[3]);
  await client.query(`
    INSERT INTO "streaming_duel_history" (
      "cycleId", "duelId", "finishedAt", "outcome",
      "agent1Id", "agent1Name", "agent1OpeningStyle",
      "agent2Id", "agent2Name", "agent2OpeningStyle", "winReason",
      "winnerId", "winnerName", "loserId", "loserName",
      "damageAgent1", "damageAgent2", "damageWinner", "damageLoser"
    ) VALUES (
      'styled-after-migration', 'duel-styled', 350, 'win',
      'agent-a', 'Astra', 'ranged',
      'agent-b', 'Riven', 'melee', 'kill',
      'agent-a', 'Astra', 'agent-b', 'Riven',
      30, 12, 30, 12
    )
  `);
  await assert.rejects(
    client.query(`
      INSERT INTO "streaming_duel_history" (
        "cycleId", "finishedAt", "outcome", "cancellationReason",
        "agent1OpeningStyle"
      ) VALUES (
        'invalid-opening-style', 375, 'cancelled', 'verification', 'invalid'
      )
    `),
  );

  // Simulate a rollback to a pre-0055 binary. Its original insert remains
  // accepted because every new column is additive/defaulted/nullable.
  await client.query(`
    INSERT INTO "streaming_duel_history" (
      "cycleId", "duelId", "finishedAt",
      "winnerId", "winnerName", "loserId", "loserName", "winReason",
      "damageWinner", "damageLoser"
    ) VALUES (
      'legacy-writer-after-migration', 'duel-rollback', 400,
      'agent-c', 'Cinder', 'agent-d', 'Nova', 'forfeit', 9, 2
    )
  `);

  const beforeRecovery = await historyRows(client);
  const normalized = beforeRecovery.map(normalizePersistedRecentDuel);
  assert.equal(normalized.every(Boolean), true);
  assert.deepEqual(
    normalized.map((row) => row?.outcome),
    ["win", "draw", "cancelled", "win", "win"],
  );
  assert.deepEqual(normalized[3], {
    cycleId: "styled-after-migration",
    duelId: "duel-styled",
    finishedAt: 350,
    outcome: "win",
    agent1Id: "agent-a",
    agent1Name: "Astra",
    agent1OpeningStyle: "ranged",
    agent2Id: "agent-b",
    agent2Name: "Riven",
    agent2OpeningStyle: "melee",
    winnerId: "agent-a",
    winnerName: "Astra",
    loserId: "agent-b",
    loserName: "Riven",
    winReason: "kill",
    cancellationReason: null,
    damageAgent1: 30,
    damageAgent2: 12,
    damageWinner: 30,
    damageLoser: 12,
  });
  assert.deepEqual(normalized[4], {
    cycleId: "legacy-writer-after-migration",
    duelId: "duel-rollback",
    finishedAt: 400,
    outcome: "win",
    agent1Id: "agent-c",
    agent1Name: "Cinder",
    agent1OpeningStyle: null,
    agent2Id: "agent-d",
    agent2Name: "Nova",
    agent2OpeningStyle: null,
    winnerId: "agent-c",
    winnerName: "Cinder",
    loserId: "agent-d",
    loserName: "Nova",
    winReason: "forfeit",
    cancellationReason: null,
    damageAgent1: 9,
    damageAgent2: 2,
    damageWinner: 9,
    damageLoser: 2,
  });

  // Exercise an exact table-data recovery, including IDs and the serial
  // sequence, inside the disposable database.
  await client.query(
    'CREATE TEMP TABLE "streaming_duel_history_recovery" AS TABLE "streaming_duel_history"',
  );
  await client.query(
    'TRUNCATE TABLE "streaming_duel_history" RESTART IDENTITY',
  );
  assert.equal((await historyRows(client)).length, 0);
  await client.query(
    'INSERT INTO "streaming_duel_history" SELECT * FROM "streaming_duel_history_recovery" ORDER BY "id"',
  );
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('streaming_duel_history', 'id'),
      COALESCE(MAX("id"), 1),
      MAX("id") IS NOT NULL
    )
    FROM "streaming_duel_history"
  `);
  const afterRecovery = await historyRows(client);
  assert.deepEqual(afterRecovery, beforeRecovery);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      postgresVersion: (await client.query("SHOW server_version")).rows[0]
        .server_version,
      migrations,
      idempotentCancellationMigration: true,
      idempotentOpeningStyleMigration: true,
      rejectsInvalidOpeningStyle: true,
      legacyWriterAfterMigration: true,
      recoveredRows: afterRecovery.length,
      fingerprint: historyFingerprint(afterRecovery),
    })}\n`,
  );
} finally {
  await client.query('DROP TABLE IF EXISTS "streaming_duel_history" CASCADE');
  await client.end();
}
