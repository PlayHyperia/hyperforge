-- Bound a still-private duel preparation to the exact embedded-agent host that
-- accepted each contestant. A lease cannot be revived or transferred: once a
-- host misses its database-clock deadline, the scheduler records the existing
-- agent_unavailable outcome and cancels before a public market can exist.

CREATE TABLE IF NOT EXISTS "streaming_duel_preparation_agent_host_leases" (
  "preparationId" text NOT NULL,
  "agentId" text NOT NULL,
  "ownerId" text NOT NULL,
  "claimedAt" bigint NOT NULL,
  "heartbeatAt" bigint NOT NULL,
  "expiresAt" bigint NOT NULL,
  CONSTRAINT "streaming_duel_preparation_agent_host_leases_pk"
    PRIMARY KEY ("preparationId", "agentId"),
  CONSTRAINT "streaming_duel_preparation_agent_host_leases_preparation_fk"
    FOREIGN KEY ("preparationId")
    REFERENCES "public"."streaming_duel_preparations"("preparationId")
    ON DELETE RESTRICT,
  CONSTRAINT "streaming_duel_preparation_agent_host_leases_identity_check"
    CHECK (
      length("preparationId") BETWEEN 1 AND 128
      AND length("agentId") BETWEEN 1 AND 128
      AND "ownerId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "streaming_duel_preparation_agent_host_leases_time_check"
    CHECK (
      "claimedAt" >= 0
      AND "heartbeatAt" >= "claimedAt"
      AND "expiresAt" > "heartbeatAt"
      AND "expiresAt" - "heartbeatAt" BETWEEN 5000 AND 60000
    )
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_streaming_duel_preparation_agent_host_lease()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  preparation_record record;
  database_now bigint;
  requested_duration bigint;
BEGIN
  requested_duration := NEW."expiresAt" - NEW."heartbeatAt";
  IF requested_duration < 5000 OR requested_duration > 60000 THEN
    RAISE EXCEPTION 'duel preparation host lease duration is out of bounds'
      USING ERRCODE = '22023';
  END IF;

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
    RAISE EXCEPTION 'duel preparation host lease has no preparation'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."agentId" NOT IN (
    preparation_record."agent1Id",
    preparation_record."agent2Id"
  ) THEN
    RAISE EXCEPTION 'duel preparation host lease agent is not a contestant'
      USING ERRCODE = '23514';
  END IF;

  database_now := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  IF preparation_record.status NOT IN ('preparing', 'ready')
    OR preparation_record."expiresAt" <= database_now
  THEN
    RAISE EXCEPTION 'duel preparation is not host-leaseable'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "streaming_duel_preparation_unavailability_reports" AS unavailable
    WHERE unavailable."preparationId" = NEW."preparationId"
  ) THEN
    RAISE EXCEPTION 'duel preparation contestant is unavailable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."preparationId" IS DISTINCT FROM OLD."preparationId"
      OR NEW."agentId" IS DISTINCT FROM OLD."agentId"
      OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId"
      OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
    THEN
      RAISE EXCEPTION 'duel preparation host lease identity is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD."expiresAt" <= database_now THEN
      RAISE EXCEPTION 'expired duel preparation host lease cannot be revived'
        USING ERRCODE = '55000';
    END IF;
    NEW."claimedAt" := OLD."claimedAt";
  ELSE
    NEW."claimedAt" := database_now;
  END IF;

  NEW."heartbeatAt" := database_now;
  NEW."expiresAt" := database_now + requested_duration;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_agent_host_leases_validate"
  ON "streaming_duel_preparation_agent_host_leases";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_agent_host_leases_validate"
  BEFORE INSERT OR UPDATE ON "streaming_duel_preparation_agent_host_leases"
  FOR EACH ROW EXECUTE FUNCTION validate_streaming_duel_preparation_agent_host_lease();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_streaming_duel_preparation_agent_host_lease_removal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'duel preparation host leases are retained for audit'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_agent_host_leases_reject_removal"
  ON "streaming_duel_preparation_agent_host_leases";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_agent_host_leases_reject_removal"
  BEFORE DELETE ON "streaming_duel_preparation_agent_host_leases"
  FOR EACH ROW EXECUTE FUNCTION reject_streaming_duel_preparation_agent_host_lease_removal();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_agent_host_leases_reject_truncate"
  ON "streaming_duel_preparation_agent_host_leases";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_agent_host_leases_reject_truncate"
  BEFORE TRUNCATE ON "streaming_duel_preparation_agent_host_leases"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_streaming_duel_preparation_agent_host_lease_removal();
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_streaming_duel_preparation_agent_host_leases_expiry"
  ON "streaming_duel_preparation_agent_host_leases" USING btree (
    "preparationId", "expiresAt", "agentId"
  );
