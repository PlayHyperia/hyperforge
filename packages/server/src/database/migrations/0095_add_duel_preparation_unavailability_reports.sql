-- Persist a contestant host's private-preparation unavailability without
-- granting that host scheduler cancellation authority. The scheduler consumes
-- this append-only report and performs the existing fenced cancellation.

CREATE TABLE IF NOT EXISTS "streaming_duel_preparation_unavailability_reports" (
  "preparationId" text NOT NULL,
  "agentId" text NOT NULL,
  "reason" text DEFAULT 'agent_unavailable' NOT NULL,
  "reportedAt" bigint DEFAULT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint NOT NULL,
  CONSTRAINT "streaming_duel_preparation_unavailability_reports_pk"
    PRIMARY KEY ("preparationId", "agentId"),
  CONSTRAINT "streaming_duel_preparation_unavailability_reports_preparation_fk"
    FOREIGN KEY ("preparationId")
    REFERENCES "public"."streaming_duel_preparations"("preparationId")
    ON DELETE RESTRICT,
  CONSTRAINT "streaming_duel_preparation_unavailability_reports_identity_check"
    CHECK (
      length("preparationId") BETWEEN 1 AND 128
      AND length("agentId") BETWEEN 1 AND 128
      AND "reportedAt" >= 0
    ),
  CONSTRAINT "streaming_duel_preparation_unavailability_reports_reason_check"
    CHECK ("reason" = 'agent_unavailable')
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_streaming_duel_preparation_unavailability_report_insert()
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
    preparation."expiresAt"
  INTO preparation_record
  FROM "streaming_duel_preparations" AS preparation
  WHERE preparation."preparationId" = NEW."preparationId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'duel preparation unavailability report has no preparation'
      USING ERRCODE = '23503';
  END IF;

  IF NEW."agentId" NOT IN (
    preparation_record."agent1Id",
    preparation_record."agent2Id"
  ) THEN
    RAISE EXCEPTION 'unavailability reporter is not a preparation contestant'
      USING ERRCODE = '23514';
  END IF;

  database_now := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  IF preparation_record.status NOT IN ('preparing', 'ready')
    OR preparation_record."expiresAt" <= database_now
  THEN
    RAISE EXCEPTION 'duel preparation is not reportable'
      USING ERRCODE = '55000';
  END IF;

  -- The caller cannot backdate or future-date availability evidence.
  NEW."reportedAt" := database_now;

  -- Touch the authority row while holding its lock. Every custody/readiness/
  -- freeze transaction locks the same row, so a report that wins this order is
  -- visible or causes a serializable retry before later work can commit.
  UPDATE "streaming_duel_preparations"
  SET version = version + 1
  WHERE "preparationId" = NEW."preparationId";

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_unavailability_reports_validate_insert"
  ON "streaming_duel_preparation_unavailability_reports";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_unavailability_reports_validate_insert"
  BEFORE INSERT ON "streaming_duel_preparation_unavailability_reports"
  FOR EACH ROW EXECUTE FUNCTION validate_streaming_duel_preparation_unavailability_report_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_streaming_duel_preparation_unavailability_report_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'duel preparation unavailability reports are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_unavailability_reports_reject_mutation"
  ON "streaming_duel_preparation_unavailability_reports";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_unavailability_reports_reject_mutation"
  BEFORE UPDATE OR DELETE ON "streaming_duel_preparation_unavailability_reports"
  FOR EACH ROW EXECUTE FUNCTION reject_streaming_duel_preparation_unavailability_report_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_unavailability_reports_reject_truncate"
  ON "streaming_duel_preparation_unavailability_reports";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_unavailability_reports_reject_truncate"
  BEFORE TRUNCATE ON "streaming_duel_preparation_unavailability_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_streaming_duel_preparation_unavailability_report_mutation();
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_streaming_duel_preparation_unavailability_reports_preparation_time"
  ON "streaming_duel_preparation_unavailability_reports" USING btree (
    "preparationId", "reportedAt", "agentId"
  );
