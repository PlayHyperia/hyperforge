-- Bind ordinary bank custody to immutable autonomy attempts. A committed bank
-- receipt is exact restart evidence, so receipt rows must be append-only and a
-- recovery terminal may report completion only when that receipt is present.

ALTER TABLE "agent_bank_operations"
  DROP CONSTRAINT IF EXISTS "agent_bank_operations_identity_check",
  DROP CONSTRAINT IF EXISTS "agent_bank_operations_receipt_check",
  ADD CONSTRAINT "agent_bank_operations_identity_check"
    CHECK (
      "operationId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
      AND length("bankId") BETWEEN 1 AND 256
      AND "createdAt" >= 0
    ),
  ADD CONSTRAINT "agent_bank_operations_receipt_check"
    CHECK (
      action IN ('deposit', 'withdraw', 'deposit_all')
      AND "requestedQuantity" > 0
      AND "committedQuantity" > 0
      AND "committedQuantity" <= "requestedQuantity"
      AND "inventoryQuantityAfter" >= 0
      AND ("bankQuantityAfter" IS NULL OR "bankQuantityAfter" >= 0)
      AND (
        (action IN ('deposit', 'withdraw') AND "itemId" IS NOT NULL)
        OR
        (action = 'deposit_all' AND "itemId" IS NULL)
      )
    );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_agent_bank_operation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent bank operation receipts are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_bank_operations_reject_mutation"
  ON "agent_bank_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_bank_operations_reject_mutation"
  BEFORE UPDATE OR DELETE ON "agent_bank_operations"
  FOR EACH ROW EXECUTE FUNCTION reject_agent_bank_operation_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_bank_operations_reject_truncate"
  ON "agent_bank_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_bank_operations_reject_truncate"
  BEFORE TRUNCATE ON "agent_bank_operations"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_bank_operation_mutation();
--> statement-breakpoint

ALTER TABLE "agent_autonomy_progression_events"
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_events_edge_truth_check",
  ADD CONSTRAINT "agent_autonomy_progression_events_edge_truth_check"
    CHECK (
      (
        "event_type" = 'attempt_started'
        AND "event_source" = 'runtime'
        AND "action_outcome" IS NULL
        AND "applied_action_type" IS NULL
        AND "checkpoint_revision" IS NULL
      )
      OR (
        "event_type" = 'attempt_terminal'
        AND "event_source" IN (
          'runtime', 'restart_recovery', 'restart_reconciliation'
        )
        AND "action_outcome" IN (
          'completed', 'dispatched', 'rejected', 'failed',
          'unknown_after_restart'
        )
        AND "checkpoint_revision" IS NOT NULL
        AND "checkpoint_revision" > 0
        AND (
          (
            "action_outcome" IN ('completed', 'dispatched')
            AND "applied_action_type" IS NOT NULL
          )
          OR (
            "action_outcome" IN (
              'rejected', 'failed', 'unknown_after_restart'
            )
            AND "applied_action_type" IS NULL
          )
        )
        AND (
          (
            "event_source" = 'restart_recovery'
            AND "action_outcome" = 'unknown_after_restart'
            AND "applied_action_type" IS NULL
          )
          OR (
            "event_source" = 'restart_reconciliation'
            AND "action_outcome" = 'completed'
            AND "applied_action_type" = 'bankDepositAll'
          )
          OR (
            "event_source" = 'runtime'
            AND "action_outcome" <> 'unknown_after_restart'
          )
        )
      )
    );
