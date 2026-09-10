-- Preserve permanent prayer-operation replay identity while allowing an
-- explicitly approved operator job to remove the larger historical WAL body.
-- No retention duration or automatic deletion policy is encoded here.

CREATE TABLE "compacted_prayer_state_receipts" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "player_id" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "transition" text NOT NULL,
  "public_observation_operation_id" text,
  "retention_approval_id" text NOT NULL,
  "compaction_batch_id" text NOT NULL,
  "operation_timestamp" bigint NOT NULL,
  "completed_at" bigint NOT NULL,
  "compacted_at" bigint NOT NULL,
  CONSTRAINT "compacted_prayer_state_receipts_operation_id_check"
    CHECK (length("operation_id") BETWEEN 1 AND 256),
  CONSTRAINT "compacted_prayer_state_receipts_player_id_check"
    CHECK (length("player_id") BETWEEN 1 AND 128),
  CONSTRAINT "compacted_prayer_state_receipts_fingerprint_check"
    CHECK ("request_fingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "compacted_prayer_state_receipts_transition_check"
    CHECK ("transition" IN (
      'toggle', 'drain', 'deactivate_all', 'restore', 'set_max', 'repair'
    )),
  CONSTRAINT "compacted_prayer_state_receipts_public_observation_check"
    CHECK (
      "public_observation_operation_id" IS NULL
      OR "public_observation_operation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "compacted_prayer_state_receipts_approval_id_check"
    CHECK (
      "retention_approval_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    ),
  CONSTRAINT "compacted_prayer_state_receipts_batch_id_check"
    CHECK (
      "compaction_batch_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "compacted_prayer_state_receipts_time_check"
    CHECK (
      "operation_timestamp" > 0
      AND "completed_at" >= "operation_timestamp"
      AND "compacted_at" >= "completed_at"
    )
);
--> statement-breakpoint
CREATE INDEX "idx_compacted_prayer_state_receipts_player_completed"
  ON "compacted_prayer_state_receipts" USING btree (
    "player_id", "completed_at"
  );
--> statement-breakpoint
CREATE INDEX "idx_compacted_prayer_state_receipts_completed"
  ON "compacted_prayer_state_receipts" USING btree ("completed_at");
--> statement-breakpoint
CREATE INDEX "idx_compacted_prayer_state_receipts_batch"
  ON "compacted_prayer_state_receipts" USING btree ("compaction_batch_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_compacted_prayer_state_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'compacted prayer state receipts are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "compacted_prayer_state_receipts_reject_mutation"
  BEFORE UPDATE OR DELETE ON "compacted_prayer_state_receipts"
  FOR EACH ROW EXECUTE FUNCTION reject_compacted_prayer_state_receipt_mutation();
--> statement-breakpoint
CREATE TRIGGER "compacted_prayer_state_receipts_reject_truncate"
  BEFORE TRUNCATE ON "compacted_prayer_state_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_compacted_prayer_state_receipt_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_compacted_prayer_operation_id_reuse()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "compacted_prayer_state_receipts"
     WHERE "operation_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'operation id belongs to a compacted prayer receipt'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "operations_log_reject_compacted_prayer_id_reuse"
  BEFORE INSERT ON "operations_log"
  FOR EACH ROW EXECUTE FUNCTION reject_compacted_prayer_operation_id_reuse();
