import pg from "pg";

import { buildCompetitiveStrategyOutcomeReport } from "../src/systems/StreamingDuelScheduler/competitive-strategy-outcome-metrics.js";
import {
  readCompetitiveStrategyAuditOptions,
  resolveCompetitiveStrategyAuditDiagnosticScope,
} from "./competitive-strategy-audit-policy.js";

const { help, queryLimit, includeDiagnostics } =
  readCompetitiveStrategyAuditOptions(process.argv.slice(2));
if (help) {
  process.stdout.write(
    "Usage: bun scripts/audit-competitive-strategy-outcomes.ts [--limit N] [--include-diagnostics]\n",
  );
  process.exit(0);
}
const connectionString = (
  process.env.COMPETITIVE_STRATEGY_AUDIT_DATABASE_URL ??
  process.env.DATABASE_URL ??
  ""
).trim();
if (!connectionString) {
  throw new Error(
    "COMPETITIVE_STRATEGY_AUDIT_DATABASE_URL or DATABASE_URL is required",
  );
}

const diagnosticScope = resolveCompetitiveStrategyAuditDiagnosticScope({
  includeDiagnostics,
  connectionString,
  configuredBoundary:
    process.env.COMPETITIVE_STRATEGY_AUDIT_DIAGNOSTIC_BOUNDARY,
});

const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  application_name: "hyperia-competitive-strategy-audit",
});

await client.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '30s'");
  const terminalResult = await client.query(
    `SELECT
       "preparationId", "snapshotVersion", "cycleId", "duelId", "duelKey",
       "snapshotDigest", "snapshot", "frozenAt", "lockedAt", "duelStartedAt",
       "recoveredAt", "lifecycleStatus", "terminalOutcome",
       "terminalWinnerId", "terminalWinReason", "terminalCancellationReason",
       "terminalSeed", "terminalReplayHash", "terminalAt"
     FROM streaming_duel_competitive_snapshots
     WHERE "lifecycleStatus" IN ('terminal', 'retired')
       AND "terminalOutcome" IN ('win', 'draw')
       AND ($2::boolean OR "snapshot" @> '{"diagnostic":false}'::jsonb)
     ORDER BY "terminalAt" DESC, "cycleId" ASC
     LIMIT $1`,
    [queryLimit + 1, includeDiagnostics],
  );
  const truncated = terminalResult.rows.length > queryLimit;
  const terminalRows = terminalResult.rows.slice(0, queryLimit);
  const cycleIds = terminalRows.map((row) => String(row.cycleId));
  const observationRows =
    cycleIds.length === 0
      ? []
      : (
          await client.query(
            `SELECT
               "cycleId", "duelId", "sequence", "observedAt",
               "actorId", "opponentId", "action", "observation"
             FROM streaming_duel_action_observations
             WHERE "cycleId" = ANY($1::text[])
             ORDER BY "cycleId" ASC, "sequence" ASC`,
            [cycleIds],
          )
        ).rows;
  const report = buildCompetitiveStrategyOutcomeReport(
    terminalRows,
    observationRows,
    { allowDiagnosticSnapshots: includeDiagnostics },
  );
  await client.query("COMMIT");

  process.stdout.write(
    `${JSON.stringify(
      {
        audit: "competitive_strategy_outcomes",
        generatedAt: new Date().toISOString(),
        databaseAccess: "repeatable_read_read_only",
        descriptiveOnly: true,
        diagnosticScope,
        queryLimit,
        truncated,
        terminalRows: terminalRows.length,
        actionObservationRows: observationRows.length,
        report,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original audit failure.
  }
  throw error;
} finally {
  await client.end();
}
