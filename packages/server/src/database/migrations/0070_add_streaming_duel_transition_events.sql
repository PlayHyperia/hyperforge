-- Preserve an ordered, privacy-safe, append-only history of every durable
-- preparation and competitive-snapshot transition. Runtime events are written
-- in the same transaction as their authoritative state mutation. Older rows
-- are backfilled only from evidence already present in durable state and are
-- explicitly marked so missing pre-ledger authority handoffs are never
-- presented as observed history.

CREATE TABLE IF NOT EXISTS "streaming_duel_transition_events" (
  "eventSequence" bigserial PRIMARY KEY NOT NULL,
  "eventKey" text NOT NULL,
  "eventSource" text NOT NULL,
  "eventType" text NOT NULL,
  "preparationId" text NOT NULL,
  "occurredAt" bigint NOT NULL,
  "fencingToken" bigint,
  "preparationVersion" integer,
  "agent1Id" text NOT NULL,
  "agent2Id" text NOT NULL,
  "actorAgentId" text,
  "cycleId" text,
  "duelId" text,
  "snapshotDigest" text,
  "terminalOutcome" text,
  "winnerId" text,
  "winReason" text,
  "reason" text,
  "terminalSeed" text,
  "replayHash" text,
  CONSTRAINT "streaming_duel_transition_events_event_key_unique"
    UNIQUE ("eventKey"),
  CONSTRAINT "streaming_duel_transition_events_source_check"
    CHECK (
      ("eventSource" = 'runtime'
        AND "fencingToken" IS NOT NULL
        AND "fencingToken" > 0
        AND "preparationVersion" IS NOT NULL
        AND "preparationVersion" > 0)
      OR
      ("eventSource" = 'migration_backfill'
        AND "fencingToken" IS NULL
        AND "preparationVersion" IS NULL)
    ),
  CONSTRAINT "streaming_duel_transition_events_type_check"
    CHECK (
      "eventType" IN (
        'preparation_selected',
        'contestant_ready',
        'preparation_frozen',
        'competitive_snapshot_frozen',
        'authority_claimed',
        'market_locked',
        'duel_started',
        'terminal_committed',
        'recovery_committed',
        'preparation_cancelled',
        'preparation_expired'
      )
    ),
  CONSTRAINT "streaming_duel_transition_events_identity_check"
    CHECK (
      length("eventKey") BETWEEN 1 AND 1024
      AND length("preparationId") BETWEEN 1 AND 128
      AND "occurredAt" >= 0
      AND "agent1Id" <> "agent2Id"
      AND (
        "actorAgentId" IS NULL
        OR "actorAgentId" IN ("agent1Id", "agent2Id")
      )
    ),
  CONSTRAINT "streaming_duel_transition_events_actor_check"
    CHECK (
      ("eventType" = 'contestant_ready' AND "actorAgentId" IS NOT NULL)
      OR
      ("eventType" <> 'contestant_ready' AND "actorAgentId" IS NULL)
    ),
  CONSTRAINT "streaming_duel_transition_events_snapshot_check"
    CHECK (
      (
        "eventType" IN (
          'competitive_snapshot_frozen',
          'authority_claimed',
          'market_locked',
          'duel_started',
          'terminal_committed',
          'recovery_committed'
        )
        AND "cycleId" IS NOT NULL
        AND "duelId" IS NOT NULL
        AND "snapshotDigest" ~ '^[0-9a-f]{64}$'
      )
      OR
      (
        "eventType" NOT IN (
          'competitive_snapshot_frozen',
          'authority_claimed',
          'market_locked',
          'duel_started',
          'terminal_committed',
          'recovery_committed'
        )
        AND "cycleId" IS NULL
        AND "duelId" IS NULL
        AND "snapshotDigest" IS NULL
      )
    ),
  CONSTRAINT "streaming_duel_transition_events_terminal_check"
    CHECK (
      (
        "eventType" <> 'terminal_committed'
        AND "terminalOutcome" IS NULL
        AND "winnerId" IS NULL
        AND "winReason" IS NULL
        AND "terminalSeed" IS NULL
        AND "replayHash" IS NULL
        AND (
          ("eventType" = 'preparation_cancelled'
            AND "reason" ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$')
          OR
          ("eventType" <> 'preparation_cancelled' AND "reason" IS NULL)
        )
      )
      OR
      (
        "eventType" = 'terminal_committed'
        AND (
          ("terminalOutcome" = 'win'
            AND "winnerId" IN ("agent1Id", "agent2Id")
            AND "winReason" IN ('kill', 'forfeit', 'hp_advantage', 'damage_advantage')
            AND "reason" IS NULL
            AND "terminalSeed" ~ '^(0|[1-9][0-9]{0,19})$'
            AND "terminalSeed"::numeric <= 18446744073709551615
            AND "replayHash" ~ '^[0-9a-f]{64}$')
          OR
          ("terminalOutcome" = 'draw'
            AND "winnerId" IS NULL
            AND "winReason" = 'draw'
            AND "reason" = 'draw'
            AND "terminalSeed" ~ '^(0|[1-9][0-9]{0,19})$'
            AND "terminalSeed"::numeric <= 18446744073709551615
            AND "replayHash" ~ '^[0-9a-f]{64}$')
          OR
          ("terminalOutcome" = 'cancelled'
            AND "winnerId" IS NULL
            AND "winReason" IS NULL
            AND "reason" ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
            AND "terminalSeed" IS NULL
            AND "replayHash" IS NULL)
        )
      )
    )
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_transition_events_preparation"
  ON "streaming_duel_transition_events" USING btree ("preparationId", "eventSequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_transition_events_cycle"
  ON "streaming_duel_transition_events" USING btree ("cycleId", "eventSequence")
  WHERE "cycleId" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_transition_events_digest"
  ON "streaming_duel_transition_events" USING btree ("snapshotDigest")
  WHERE "snapshotDigest" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_transition_events_type_time"
  ON "streaming_duel_transition_events" USING btree ("eventType", "occurredAt");
--> statement-breakpoint

-- Backfill only transitions directly evidenced by existing columns. Null
-- authority/version fields intentionally distinguish reconstructed history
-- from events observed atomically by the runtime after this migration.
INSERT INTO "streaming_duel_transition_events" (
  "eventKey", "eventSource", "eventType", "preparationId", "occurredAt",
  "fencingToken", "preparationVersion", "agent1Id", "agent2Id"
)
SELECT
  preparation."preparationId" || ':preparation_selected',
  'migration_backfill', 'preparation_selected', preparation."preparationId",
  preparation."selectedAt", NULL, NULL,
  preparation."agent1Id", preparation."agent2Id"
FROM "streaming_duel_preparations" AS preparation
ON CONFLICT ("eventKey") DO NOTHING;
--> statement-breakpoint
INSERT INTO "streaming_duel_transition_events" (
  "eventKey", "eventSource", "eventType", "preparationId", "occurredAt",
  "fencingToken", "preparationVersion", "agent1Id", "agent2Id", "actorAgentId"
)
SELECT
  readiness."preparationId" || ':contestant_ready:' || readiness."actorAgentId",
  'migration_backfill', 'contestant_ready', readiness."preparationId",
  readiness."occurredAt", NULL, NULL,
  readiness."agent1Id", readiness."agent2Id", readiness."actorAgentId"
FROM (
  SELECT "preparationId", "agent1Id", "agent2Id",
         "agent1Id" AS "actorAgentId", "agent1ReadyAt" AS "occurredAt"
  FROM "streaming_duel_preparations" WHERE "agent1ReadyAt" IS NOT NULL
  UNION ALL
  SELECT "preparationId", "agent1Id", "agent2Id",
         "agent2Id" AS "actorAgentId", "agent2ReadyAt" AS "occurredAt"
  FROM "streaming_duel_preparations" WHERE "agent2ReadyAt" IS NOT NULL
) AS readiness
ORDER BY readiness."occurredAt", readiness."actorAgentId"
ON CONFLICT ("eventKey") DO NOTHING;
--> statement-breakpoint
INSERT INTO "streaming_duel_transition_events" (
  "eventKey", "eventSource", "eventType", "preparationId", "occurredAt",
  "fencingToken", "preparationVersion", "agent1Id", "agent2Id"
)
SELECT
  preparation."preparationId" || ':preparation_frozen',
  'migration_backfill', 'preparation_frozen', preparation."preparationId",
  preparation."frozenAt", NULL, NULL,
  preparation."agent1Id", preparation."agent2Id"
FROM "streaming_duel_preparations" AS preparation
LEFT JOIN "streaming_duel_competitive_snapshots" AS snapshot
  ON snapshot."preparationId" = preparation."preparationId"
WHERE preparation."frozenAt" IS NOT NULL
  AND snapshot."preparationId" IS NULL
ON CONFLICT ("eventKey") DO NOTHING;
--> statement-breakpoint
INSERT INTO "streaming_duel_transition_events" (
  "eventKey", "eventSource", "eventType", "preparationId", "occurredAt",
  "fencingToken", "preparationVersion", "agent1Id", "agent2Id",
  "cycleId", "duelId", "snapshotDigest"
)
SELECT
  preparation."preparationId" || ':competitive_snapshot_frozen',
  'migration_backfill', 'competitive_snapshot_frozen', preparation."preparationId",
  snapshot."frozenAt", NULL, NULL,
  preparation."agent1Id", preparation."agent2Id",
  snapshot."cycleId", snapshot."duelId", snapshot."snapshotDigest"
FROM "streaming_duel_competitive_snapshots" AS snapshot
JOIN "streaming_duel_preparations" AS preparation
  ON preparation."preparationId" = snapshot."preparationId"
ON CONFLICT ("eventKey") DO NOTHING;
--> statement-breakpoint
INSERT INTO "streaming_duel_transition_events" (
  "eventKey", "eventSource", "eventType", "preparationId", "occurredAt",
  "fencingToken", "preparationVersion", "agent1Id", "agent2Id",
  "cycleId", "duelId", "snapshotDigest"
)
SELECT
  preparation."preparationId" || ':market_locked',
  'migration_backfill', 'market_locked', preparation."preparationId",
  snapshot."lockedAt", NULL, NULL,
  preparation."agent1Id", preparation."agent2Id",
  snapshot."cycleId", snapshot."duelId", snapshot."snapshotDigest"
FROM "streaming_duel_competitive_snapshots" AS snapshot
JOIN "streaming_duel_preparations" AS preparation
  ON preparation."preparationId" = snapshot."preparationId"
WHERE snapshot."lockedAt" IS NOT NULL
ON CONFLICT ("eventKey") DO NOTHING;
--> statement-breakpoint
INSERT INTO "streaming_duel_transition_events" (
  "eventKey", "eventSource", "eventType", "preparationId", "occurredAt",
  "fencingToken", "preparationVersion", "agent1Id", "agent2Id",
  "cycleId", "duelId", "snapshotDigest"
)
SELECT
  preparation."preparationId" || ':duel_started',
  'migration_backfill', 'duel_started', preparation."preparationId",
  snapshot."duelStartedAt", NULL, NULL,
  preparation."agent1Id", preparation."agent2Id",
  snapshot."cycleId", snapshot."duelId", snapshot."snapshotDigest"
FROM "streaming_duel_competitive_snapshots" AS snapshot
JOIN "streaming_duel_preparations" AS preparation
  ON preparation."preparationId" = snapshot."preparationId"
WHERE snapshot."duelStartedAt" IS NOT NULL
ON CONFLICT ("eventKey") DO NOTHING;
--> statement-breakpoint
INSERT INTO "streaming_duel_transition_events" (
  "eventKey", "eventSource", "eventType", "preparationId", "occurredAt",
  "fencingToken", "preparationVersion", "agent1Id", "agent2Id",
  "cycleId", "duelId", "snapshotDigest", "terminalOutcome", "winnerId",
  "winReason", "reason", "terminalSeed", "replayHash"
)
SELECT
  preparation."preparationId" || ':terminal_committed',
  'migration_backfill', 'terminal_committed', preparation."preparationId",
  snapshot."terminalAt", NULL, NULL,
  preparation."agent1Id", preparation."agent2Id",
  snapshot."cycleId", snapshot."duelId", snapshot."snapshotDigest",
  snapshot."terminalOutcome", snapshot."terminalWinnerId",
  snapshot."terminalWinReason", snapshot."terminalCancellationReason",
  snapshot."terminalSeed", snapshot."terminalReplayHash"
FROM "streaming_duel_competitive_snapshots" AS snapshot
JOIN "streaming_duel_preparations" AS preparation
  ON preparation."preparationId" = snapshot."preparationId"
WHERE snapshot."terminalAt" IS NOT NULL
ON CONFLICT ("eventKey") DO NOTHING;
--> statement-breakpoint
INSERT INTO "streaming_duel_transition_events" (
  "eventKey", "eventSource", "eventType", "preparationId", "occurredAt",
  "fencingToken", "preparationVersion", "agent1Id", "agent2Id",
  "cycleId", "duelId", "snapshotDigest"
)
SELECT
  preparation."preparationId" || ':recovery_committed',
  'migration_backfill', 'recovery_committed', preparation."preparationId",
  snapshot."recoveredAt", NULL, NULL,
  preparation."agent1Id", preparation."agent2Id",
  snapshot."cycleId", snapshot."duelId", snapshot."snapshotDigest"
FROM "streaming_duel_competitive_snapshots" AS snapshot
JOIN "streaming_duel_preparations" AS preparation
  ON preparation."preparationId" = snapshot."preparationId"
WHERE snapshot."recoveredAt" IS NOT NULL
ON CONFLICT ("eventKey") DO NOTHING;
--> statement-breakpoint
INSERT INTO "streaming_duel_transition_events" (
  "eventKey", "eventSource", "eventType", "preparationId", "occurredAt",
  "fencingToken", "preparationVersion", "agent1Id", "agent2Id", "reason"
)
SELECT
  preparation."preparationId" || ':preparation_cancelled',
  'migration_backfill', 'preparation_cancelled', preparation."preparationId",
  preparation."cancelledAt", NULL, NULL,
  preparation."agent1Id", preparation."agent2Id",
  preparation."cancellationReason"
FROM "streaming_duel_preparations" AS preparation
WHERE preparation.status = 'cancelled'
  AND preparation."cancelledAt" IS NOT NULL
  AND preparation."cancellationReason" IS NOT NULL
ON CONFLICT ("eventKey") DO NOTHING;
--> statement-breakpoint
INSERT INTO "streaming_duel_transition_events" (
  "eventKey", "eventSource", "eventType", "preparationId", "occurredAt",
  "fencingToken", "preparationVersion", "agent1Id", "agent2Id"
)
SELECT
  preparation."preparationId" || ':preparation_expired',
  'migration_backfill', 'preparation_expired', preparation."preparationId",
  preparation."expiresAt", NULL, NULL,
  preparation."agent1Id", preparation."agent2Id"
FROM "streaming_duel_preparations" AS preparation
WHERE preparation.status = 'expired'
ON CONFLICT ("eventKey") DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_streaming_duel_transition_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'streaming duel transition events are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "streaming_duel_transition_events_no_mutation"
  ON "streaming_duel_transition_events";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_transition_events_no_mutation"
  BEFORE UPDATE OR DELETE ON "streaming_duel_transition_events"
  FOR EACH ROW EXECUTE FUNCTION reject_streaming_duel_transition_event_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "streaming_duel_transition_events_no_truncate"
  ON "streaming_duel_transition_events";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_transition_events_no_truncate"
  BEFORE TRUNCATE ON "streaming_duel_transition_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_streaming_duel_transition_event_mutation();
