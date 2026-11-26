-- Persist successful preparation-bank opens without recording private bank
-- contents. The unified public view remains invisible until the corresponding
-- competitive snapshot exists.

CREATE TABLE IF NOT EXISTS "streaming_duel_bank_open_events" (
  "operationId" text PRIMARY KEY NOT NULL,
  "preparationId" text NOT NULL,
  "playerId" text NOT NULL,
  "bankId" text NOT NULL,
  "createdAt" bigint DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT NOT NULL,
  CONSTRAINT "streaming_duel_bank_open_events_preparation_fk"
    FOREIGN KEY ("preparationId")
    REFERENCES "public"."streaming_duel_preparations"("preparationId")
    ON DELETE RESTRICT,
  CONSTRAINT "streaming_duel_bank_open_events_player_fk"
    FOREIGN KEY ("playerId") REFERENCES "public"."characters"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "streaming_duel_bank_open_events_identity_check"
    CHECK (
      "operationId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND length("preparationId") BETWEEN 1 AND 256
      AND "bankId" = 'duel-preparation:' || "preparationId"
      AND "createdAt" >= 0
    )
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_streaming_duel_bank_open_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "streaming_duel_preparations" AS preparation
    WHERE preparation."preparationId" = NEW."preparationId"
      AND NEW."playerId" IN (preparation."agent1Id", preparation."agent2Id")
  ) THEN
    RAISE EXCEPTION 'bank-open event player is not a preparation contestant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_bank_open_events_validate_insert"
  ON "streaming_duel_bank_open_events";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_bank_open_events_validate_insert"
  BEFORE INSERT ON "streaming_duel_bank_open_events"
  FOR EACH ROW EXECUTE FUNCTION validate_streaming_duel_bank_open_event_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_streaming_duel_bank_open_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'streaming duel bank-open events are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_bank_open_events_reject_mutation"
  ON "streaming_duel_bank_open_events";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_bank_open_events_reject_mutation"
  BEFORE UPDATE OR DELETE ON "streaming_duel_bank_open_events"
  FOR EACH ROW EXECUTE FUNCTION reject_streaming_duel_bank_open_event_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_bank_open_events_reject_truncate"
  ON "streaming_duel_bank_open_events";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_bank_open_events_reject_truncate"
  BEFORE TRUNCATE ON "streaming_duel_bank_open_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_streaming_duel_bank_open_event_mutation();
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_streaming_duel_bank_open_events_preparation_created"
  ON "streaming_duel_bank_open_events" USING btree ("preparationId", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_bank_open_events_player_created"
  ON "streaming_duel_bank_open_events" USING btree ("playerId", "createdAt");
--> statement-breakpoint

CREATE OR REPLACE VIEW "streaming_duel_bank_action_audit" AS
SELECT
  action_event."operationId",
  action_event."preparationId",
  snapshot."cycleId",
  snapshot."duelId",
  snapshot."snapshotDigest",
  action_event."playerId",
  action_event.action,
  action_event."createdAt"
FROM (
  SELECT
    open_event."operationId",
    open_event."preparationId",
    open_event."playerId",
    'open'::text AS action,
    open_event."createdAt"
  FROM "streaming_duel_bank_open_events" AS open_event
  UNION ALL
  SELECT
    operation."operationId",
    operation."preparationId",
    operation."playerId",
    operation.action,
    operation."createdAt"
  FROM "agent_bank_operations" AS operation
  WHERE operation."preparationId" IS NOT NULL
) AS action_event
JOIN "streaming_duel_competitive_snapshots" AS snapshot
  ON snapshot."preparationId" = action_event."preparationId";
