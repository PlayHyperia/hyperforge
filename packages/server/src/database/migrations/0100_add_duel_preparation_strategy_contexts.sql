-- Freeze the bounded public context shown to an authenticated external
-- contestant for one private preparation. The record deliberately excludes
-- prompts, decisions, bank/inventory contents, item identifiers, quantities,
-- routes, wallets, and credentials. It is append-only and may be created only
-- by the exact database-clock host lease that owns that contestant.

CREATE TABLE IF NOT EXISTS "streaming_duel_preparation_strategy_contexts" (
  "preparationId" text NOT NULL,
  "agentId" text NOT NULL,
  "hostOwnerId" text NOT NULL,
  "policyVersion" text NOT NULL,
  "protocolVersion" text NOT NULL,
  "agentName" text NOT NULL,
  "opponentName" text NOT NULL,
  "ownPublicProfile" jsonb,
  "opponentPublicProfile" jsonb,
  "boundAt" bigint NOT NULL,
  CONSTRAINT "streaming_duel_preparation_strategy_contexts_pk"
    PRIMARY KEY ("preparationId", "agentId"),
  CONSTRAINT "streaming_duel_preparation_strategy_contexts_preparation_fk"
    FOREIGN KEY ("preparationId")
    REFERENCES "public"."streaming_duel_preparations"("preparationId")
    ON DELETE RESTRICT,
  CONSTRAINT "streaming_duel_preparation_strategy_contexts_identity_check"
    CHECK (
      length("preparationId") BETWEEN 1 AND 128
      AND length("agentId") BETWEEN 1 AND 128
      AND "hostOwnerId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "streaming_duel_preparation_strategy_contexts_contract_check"
    CHECK (
      "policyVersion" = 'duel-preparation-role-v3'
      AND "protocolVersion" = 'external-duel-preparation-strategy-v3'
      AND length("agentName") BETWEEN 1 AND 128
      AND length("opponentName") BETWEEN 1 AND 128
      AND "agentName" !~ '[[:cntrl:]]'
      AND "opponentName" !~ '[[:cntrl:]]'
      AND ("ownPublicProfile" IS NULL OR jsonb_typeof("ownPublicProfile") = 'object')
      AND ("opponentPublicProfile" IS NULL OR jsonb_typeof("opponentPublicProfile") = 'object')
      AND "boundAt" >= 0
    )
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_streaming_duel_preparation_strategy_context()
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
    RAISE EXCEPTION 'strategy context has no duel preparation'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."agentId" NOT IN (
    preparation_record."agent1Id",
    preparation_record."agent2Id"
  ) THEN
    RAISE EXCEPTION 'strategy context agent is not a contestant'
      USING ERRCODE = '23514';
  END IF;

  database_now := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  IF preparation_record.status NOT IN ('preparing', 'ready')
    OR preparation_record."expiresAt" <= database_now
  THEN
    RAISE EXCEPTION 'duel preparation is not accepting strategy context'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "streaming_duel_preparation_unavailability_reports" AS unavailable
    WHERE unavailable."preparationId" = NEW."preparationId"
  ) THEN
    RAISE EXCEPTION 'strategy context contestant is unavailable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "streaming_duel_preparation_agent_host_leases" AS lease
    WHERE lease."preparationId" = NEW."preparationId"
      AND lease."agentId" = NEW."agentId"
      AND lease."ownerId" = NEW."hostOwnerId"
      AND lease."expiresAt" > database_now
  ) THEN
    RAISE EXCEPTION 'strategy context has no exact active contestant host lease'
      USING ERRCODE = '55000';
  END IF;

  NEW."boundAt" := database_now;
  IF NEW."boundAt" < preparation_record."selectedAt"
    OR NEW."boundAt" >= preparation_record."expiresAt"
  THEN
    RAISE EXCEPTION 'strategy context is outside its preparation window'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_strategy_contexts_validate"
  ON "streaming_duel_preparation_strategy_contexts";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_strategy_contexts_validate"
  BEFORE INSERT ON "streaming_duel_preparation_strategy_contexts"
  FOR EACH ROW EXECUTE FUNCTION validate_streaming_duel_preparation_strategy_context();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_streaming_duel_preparation_strategy_context_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'duel preparation strategy contexts are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_strategy_contexts_reject_mutation"
  ON "streaming_duel_preparation_strategy_contexts";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_strategy_contexts_reject_mutation"
  BEFORE UPDATE OR DELETE ON "streaming_duel_preparation_strategy_contexts"
  FOR EACH ROW EXECUTE FUNCTION reject_streaming_duel_preparation_strategy_context_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_strategy_contexts_reject_truncate"
  ON "streaming_duel_preparation_strategy_contexts";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_strategy_contexts_reject_truncate"
  BEFORE TRUNCATE ON "streaming_duel_preparation_strategy_contexts"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_streaming_duel_preparation_strategy_context_mutation();
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_streaming_duel_preparation_strategy_contexts_bound"
  ON "streaming_duel_preparation_strategy_contexts" USING btree (
    "preparationId", "boundAt", "agentId"
  );
