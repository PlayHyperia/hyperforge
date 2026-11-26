-- Retain only the bounded, bettor-safe preparation categories needed to
-- reconstruct the public journey after a process restart. This ledger stores
-- no item, quantity, target, route, prompt, plan, bank, inventory, wallet, or
-- failure detail. Records are append-only and bound to an active contestant.

CREATE TABLE IF NOT EXISTS "streaming_duel_preparation_public_activities" (
  "activitySequence" bigserial PRIMARY KEY NOT NULL,
  "preparationId" text NOT NULL,
  "agentId" text NOT NULL,
  activity text NOT NULL,
  mode text NOT NULL,
  "occurredAt" bigint NOT NULL,
  CONSTRAINT "streaming_duel_preparation_public_activities_preparation_fk"
    FOREIGN KEY ("preparationId")
    REFERENCES "public"."streaming_duel_preparations"("preparationId")
    ON DELETE RESTRICT,
  CONSTRAINT "streaming_duel_preparation_public_activities_identity_check"
    CHECK (
      length("preparationId") BETWEEN 1 AND 128
      AND length("agentId") BETWEEN 1 AND 128
      AND "occurredAt" >= 0
    ),
  CONSTRAINT "streaming_duel_preparation_public_activities_category_check"
    CHECK (
      activity IN (
        'planning', 'gathering', 'training', 'crafting',
        'provisioning', 'questing', 'exploring', 'reassessing'
      )
      AND mode IN ('working', 'traveling')
      AND (
        activity NOT IN ('planning', 'reassessing')
        OR mode = 'working'
      )
    )
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_streaming_duel_preparation_public_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  preparation_record record;
  database_now bigint;
BEGIN
  SELECT
    preparation."agent1Id",
    preparation."agent2Id",
    preparation.status,
    preparation."selectedAt",
    preparation."expiresAt"
  INTO preparation_record
  FROM "streaming_duel_preparations" AS preparation
  WHERE preparation."preparationId" = NEW."preparationId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'public preparation activity has no preparation'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."agentId" NOT IN (
    preparation_record."agent1Id",
    preparation_record."agent2Id"
  ) THEN
    RAISE EXCEPTION 'public preparation activity agent is not a contestant'
      USING ERRCODE = '23514';
  END IF;

  database_now := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  IF preparation_record.status NOT IN ('preparing', 'ready')
    OR preparation_record."expiresAt" <= database_now
  THEN
    RAISE EXCEPTION 'duel preparation is not accepting public activity'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "streaming_duel_preparation_agent_host_leases" AS lease
    WHERE lease."preparationId" = NEW."preparationId"
      AND lease."agentId" = NEW."agentId"
      AND lease."expiresAt" > database_now
  ) THEN
    RAISE EXCEPTION 'public preparation activity has no active contestant host lease'
      USING ERRCODE = '55000';
  END IF;

  NEW."occurredAt" := database_now;
  IF NEW."occurredAt" < preparation_record."selectedAt"
    OR NEW."occurredAt" >= preparation_record."expiresAt"
  THEN
    RAISE EXCEPTION 'public preparation activity is outside its preparation window'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_public_activities_validate"
  ON "streaming_duel_preparation_public_activities";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_public_activities_validate"
  BEFORE INSERT ON "streaming_duel_preparation_public_activities"
  FOR EACH ROW EXECUTE FUNCTION validate_streaming_duel_preparation_public_activity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_streaming_duel_preparation_public_activity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'public preparation activity records are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_public_activities_reject_mutation"
  ON "streaming_duel_preparation_public_activities";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_public_activities_reject_mutation"
  BEFORE UPDATE OR DELETE ON "streaming_duel_preparation_public_activities"
  FOR EACH ROW EXECUTE FUNCTION reject_streaming_duel_preparation_public_activity_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_public_activities_reject_truncate"
  ON "streaming_duel_preparation_public_activities";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_public_activities_reject_truncate"
  BEFORE TRUNCATE ON "streaming_duel_preparation_public_activities"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_streaming_duel_preparation_public_activity_mutation();
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_streaming_duel_preparation_public_activities_recent"
  ON "streaming_duel_preparation_public_activities" USING btree (
    "preparationId", "agentId", "activitySequence" DESC
  );
