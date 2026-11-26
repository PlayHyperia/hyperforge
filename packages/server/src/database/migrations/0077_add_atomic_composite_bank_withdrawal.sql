-- Commit multi-item ordinary preparation batches as one all-or-nothing bank
-- operation. Parent receipts remain privacy-safe aggregates; exact private
-- components are append-only children in the same transaction.

DROP TRIGGER IF EXISTS "agent_bank_operations_reject_mutation"
  ON "agent_bank_operations";
--> statement-breakpoint

ALTER TABLE "agent_bank_operations"
  ADD COLUMN IF NOT EXISTS "itemCount" integer;
--> statement-breakpoint
UPDATE "agent_bank_operations"
SET "itemCount" = COALESCE(
  "itemCount",
  CASE WHEN "itemId" IS NULL THEN 0 ELSE 1 END
);
--> statement-breakpoint
ALTER TABLE "agent_bank_operations"
  ALTER COLUMN "itemCount" SET DEFAULT 1,
  ALTER COLUMN "itemCount" SET NOT NULL,
  DROP CONSTRAINT IF EXISTS "agent_bank_operations_receipt_check",
  ADD CONSTRAINT "agent_bank_operations_receipt_check"
    CHECK (
      action IN ('deposit', 'withdraw', 'deposit_all')
      AND "requestedQuantity" > 0
      AND "committedQuantity" > 0
      AND "committedQuantity" <= "requestedQuantity"
      AND "inventoryQuantityAfter" >= 0
      AND ("bankQuantityAfter" IS NULL OR "bankQuantityAfter" >= 0)
      AND (
        (
          action IN ('deposit', 'withdraw')
          AND "itemId" IS NOT NULL
          AND "itemCount" = 1
        )
        OR (
          action = 'deposit_all'
          AND "itemId" IS NULL
          AND "itemCount" = 0
        )
        OR (
          action = 'withdraw'
          AND "itemId" IS NULL
          AND "itemCount" BETWEEN 2 AND 28
          AND "bankQuantityAfter" IS NULL
          AND "requestedQuantity" = "committedQuantity"
        )
      )
    );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_bank_operation_items" (
  "operationId" text NOT NULL,
  "itemId" text NOT NULL,
  "requestedQuantity" integer NOT NULL,
  "committedQuantity" integer NOT NULL,
  "inventoryQuantityAfter" integer NOT NULL,
  "bankQuantityAfter" integer NOT NULL,
  CONSTRAINT "agent_bank_operation_items_pk"
    PRIMARY KEY ("operationId", "itemId"),
  CONSTRAINT "agent_bank_operation_items_operation_fk"
    FOREIGN KEY ("operationId")
    REFERENCES "agent_bank_operations"("operationId")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "agent_bank_operation_items_quantity_check"
    CHECK (
      length("itemId") BETWEEN 1 AND 256
      AND "requestedQuantity" > 0
      AND "committedQuantity" = "requestedQuantity"
      AND "inventoryQuantityAfter" >= "committedQuantity"
      AND "bankQuantityAfter" >= 0
    )
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_agent_bank_operation_item_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_action text;
  parent_item_id text;
  parent_item_count integer;
  existing_count integer;
BEGIN
  SELECT action, "itemId", "itemCount"
  INTO parent_action, parent_item_id, parent_item_count
  FROM "agent_bank_operations"
  WHERE "operationId" = NEW."operationId"
  FOR UPDATE;

  IF NOT FOUND
     OR parent_action <> 'withdraw'
     OR parent_item_id IS NOT NULL
     OR parent_item_count < 2 THEN
    RAISE EXCEPTION 'bank operation items require a composite withdrawal parent'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO existing_count
  FROM "agent_bank_operation_items"
  WHERE "operationId" = NEW."operationId";
  IF existing_count >= parent_item_count THEN
    RAISE EXCEPTION 'bank operation item count exceeds immutable parent receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_bank_operation_items_validate_insert"
  ON "agent_bank_operation_items";
--> statement-breakpoint
CREATE TRIGGER "agent_bank_operation_items_validate_insert"
  BEFORE INSERT ON "agent_bank_operation_items"
  FOR EACH ROW EXECUTE FUNCTION validate_agent_bank_operation_item_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_agent_bank_composite_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  component_count integer;
  requested_total bigint;
  committed_total bigint;
BEGIN
  SELECT count(*)::integer,
         COALESCE(sum("requestedQuantity"), 0),
         COALESCE(sum("committedQuantity"), 0)
  INTO component_count, requested_total, committed_total
  FROM "agent_bank_operation_items"
  WHERE "operationId" = NEW."operationId";

  IF NEW.action = 'withdraw' AND NEW."itemId" IS NULL THEN
    IF component_count <> NEW."itemCount"
       OR requested_total <> NEW."requestedQuantity"
       OR committed_total <> NEW."committedQuantity" THEN
      RAISE EXCEPTION 'composite bank receipt does not match its components'
        USING ERRCODE = '23514';
    END IF;
  ELSIF component_count <> 0 THEN
    RAISE EXCEPTION 'single-item bank receipt cannot have components'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_bank_operations_validate_components"
  ON "agent_bank_operations";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_bank_operations_validate_components"
  AFTER INSERT ON "agent_bank_operations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_agent_bank_composite_receipt();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_agent_bank_operation_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent bank operation item receipts are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_bank_operation_items_reject_mutation"
  ON "agent_bank_operation_items";
--> statement-breakpoint
CREATE TRIGGER "agent_bank_operation_items_reject_mutation"
  BEFORE UPDATE OR DELETE ON "agent_bank_operation_items"
  FOR EACH ROW EXECUTE FUNCTION reject_agent_bank_operation_item_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_bank_operation_items_reject_truncate"
  ON "agent_bank_operation_items";
--> statement-breakpoint
CREATE TRIGGER "agent_bank_operation_items_reject_truncate"
  BEFORE TRUNCATE ON "agent_bank_operation_items"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_bank_operation_item_mutation();
--> statement-breakpoint

CREATE TRIGGER "agent_bank_operations_reject_mutation"
  BEFORE UPDATE OR DELETE ON "agent_bank_operations"
  FOR EACH ROW EXECUTE FUNCTION reject_agent_bank_operation_mutation();
