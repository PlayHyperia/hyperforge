-- Make server-owned agent store trades retry-safe across lost responses and
-- process restarts. The receipt and coin/inventory mutation share one commit.

CREATE TABLE IF NOT EXISTS "agent_store_operations" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "player_id" text NOT NULL,
  "action" text NOT NULL,
  "store_id" text NOT NULL,
  "item_id" text NOT NULL,
  "requested_quantity" integer NOT NULL,
  "unit_price" integer NOT NULL,
  "total_value" integer NOT NULL,
  "coin_balance_after" integer NOT NULL,
  "inventory_quantity_after" integer NOT NULL,
  "request_fingerprint" text NOT NULL,
  "created_at" bigint DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT NOT NULL,
  CONSTRAINT "agent_store_operations_player_id_characters_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "public"."characters"("id")
    ON DELETE CASCADE,
  CONSTRAINT "agent_store_operations_identity_check"
    CHECK (
      "operation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND length("store_id") BETWEEN 1 AND 256
      AND length("item_id") BETWEEN 1 AND 256
      AND "request_fingerprint" ~ '^[0-9a-f]{64}$'
      AND "created_at" >= 0
    ),
  CONSTRAINT "agent_store_operations_receipt_check"
    CHECK (
      "action" IN ('buy', 'sell')
      AND "requested_quantity" > 0
      AND "unit_price" >= 0
      AND "total_value" >= 0
      AND "total_value" = "unit_price" * "requested_quantity"
      AND "coin_balance_after" >= 0
      AND "inventory_quantity_after" >= 0
    )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_store_operations_player_created"
  ON "agent_store_operations" USING btree ("player_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_agent_store_operation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent store operation receipts are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_store_operations_reject_mutation"
  ON "agent_store_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_store_operations_reject_mutation"
  BEFORE UPDATE OR DELETE ON "agent_store_operations"
  FOR EACH ROW EXECUTE FUNCTION reject_agent_store_operation_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_store_operations_reject_truncate"
  ON "agent_store_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_store_operations_reject_truncate"
  BEFORE TRUNCATE ON "agent_store_operations"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_store_operation_mutation();
--> statement-breakpoint

-- A store receipt is exact synchronous proof for a process-killed purchase,
-- just like the existing bank and burial receipts.
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
            AND "applied_action_type" IN (
              'bankDepositAll', 'bankWithdraw', 'bury', 'storeBuy'
            )
          )
          OR (
            "event_source" = 'runtime'
            AND "action_outcome" <> 'unknown_after_restart'
          )
        )
      )
    );
