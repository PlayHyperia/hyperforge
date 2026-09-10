-- Bind every preparation-bank custody receipt directly to its private session.
-- The public audit view intentionally exposes only committed action identity
-- and timing after a competitive snapshot exists; items and quantities remain
-- private strategy/custody data.

DROP TRIGGER IF EXISTS "agent_bank_operations_reject_mutation"
  ON "agent_bank_operations";
--> statement-breakpoint

ALTER TABLE "agent_bank_operations"
  ADD COLUMN IF NOT EXISTS "preparationId" text;
--> statement-breakpoint

UPDATE "agent_bank_operations" AS operation
SET "preparationId" = substring(
  operation."bankId" FROM length('duel-preparation:') + 1
)
WHERE operation."preparationId" IS NULL
  AND operation."bankId" LIKE 'duel-preparation:%'
  AND EXISTS (
    SELECT 1
    FROM "streaming_duel_preparations" AS preparation
    WHERE preparation."preparationId" = substring(
      operation."bankId" FROM length('duel-preparation:') + 1
    )
      AND operation."playerId" IN (
        preparation."agent1Id", preparation."agent2Id"
      )
  );
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_bank_operations" AS operation
    LEFT JOIN "streaming_duel_preparations" AS preparation
      ON preparation."preparationId" = operation."preparationId"
    WHERE
      (
        operation."preparationId" IS NULL
        AND operation."bankId" LIKE 'duel-preparation:%'
      )
      OR (
        operation."preparationId" IS NOT NULL
        AND (
          operation."bankId" <> 'duel-preparation:' || operation."preparationId"
          OR preparation."preparationId" IS NULL
          OR operation."playerId" NOT IN (
            preparation."agent1Id", preparation."agent2Id"
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'invalid historical duel preparation bank receipt identity'
      USING ERRCODE = '23514';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "agent_bank_operations"
  DROP CONSTRAINT IF EXISTS "agent_bank_operations_preparation_identity_check",
  ADD CONSTRAINT "agent_bank_operations_preparation_identity_check"
    CHECK (
      (
        "preparationId" IS NULL
        AND "bankId" NOT LIKE 'duel-preparation:%'
      )
      OR (
        "preparationId" IS NOT NULL
        AND length("preparationId") BETWEEN 1 AND 256
        AND "bankId" = 'duel-preparation:' || "preparationId"
      )
    );
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_bank_operations_preparationId_preparations_fk'
  ) THEN
    ALTER TABLE "agent_bank_operations"
      ADD CONSTRAINT "agent_bank_operations_preparationId_preparations_fk"
      FOREIGN KEY ("preparationId")
      REFERENCES "public"."streaming_duel_preparations"("preparationId")
      ON DELETE RESTRICT;
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_agent_bank_operation_preparation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."preparationId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "streaming_duel_preparations" AS preparation
    WHERE preparation."preparationId" = NEW."preparationId"
      AND NEW."playerId" IN (preparation."agent1Id", preparation."agent2Id")
  ) THEN
    RAISE EXCEPTION 'duel bank receipt player is not a preparation contestant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "agent_bank_operations_validate_preparation_insert"
  ON "agent_bank_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_bank_operations_validate_preparation_insert"
  BEFORE INSERT ON "agent_bank_operations"
  FOR EACH ROW EXECUTE FUNCTION validate_agent_bank_operation_preparation_insert();
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_agent_bank_operations_preparation_created"
  ON "agent_bank_operations" USING btree ("preparationId", "createdAt")
  WHERE "preparationId" IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE VIEW "streaming_duel_committed_bank_action_audit" AS
SELECT
  operation."operationId",
  operation."preparationId",
  snapshot."cycleId",
  snapshot."duelId",
  snapshot."snapshotDigest",
  operation."playerId",
  operation.action,
  operation."createdAt"
FROM "agent_bank_operations" AS operation
JOIN "streaming_duel_competitive_snapshots" AS snapshot
  ON snapshot."preparationId" = operation."preparationId"
WHERE operation."preparationId" IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER "agent_bank_operations_reject_mutation"
  BEFORE UPDATE OR DELETE ON "agent_bank_operations"
  FOR EACH ROW EXECUTE FUNCTION reject_agent_bank_operation_mutation();
