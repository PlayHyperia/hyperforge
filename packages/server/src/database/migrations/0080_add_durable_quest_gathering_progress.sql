-- Capture every gathering reward's active quest incarnations inside the same
-- transaction as inventory/XP custody. QuestSystem resolves each row once, so
-- a process exit after reward commit cannot lose or duplicate quest progress.

CREATE TABLE IF NOT EXISTS "quest_gathering_progress_receipts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "operation_id" text NOT NULL,
  "player_id" text NOT NULL,
  "quest_id" text NOT NULL,
  "quest_started_at" bigint NOT NULL,
  "captured_stage" text NOT NULL,
  "reward_item_id" text NOT NULL,
  "reward_quantity" integer NOT NULL,
  "created_at" bigint NOT NULL,
  "resolved_at" bigint,
  "resolution" text,
  "resulting_stage" text,
  "resulting_progress" jsonb,
  CONSTRAINT "quest_gathering_progress_receipts_operation_id_operations_log_id_fk"
    FOREIGN KEY ("operation_id") REFERENCES "public"."operations_log"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "quest_gathering_progress_receipts_player_id_characters_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "public"."characters"("id")
    ON DELETE CASCADE,
  CONSTRAINT "quest_gathering_progress_receipts_identity_check"
    CHECK (
      length("operation_id") BETWEEN 1 AND 256
      AND length("player_id") BETWEEN 1 AND 256
      AND length("quest_id") BETWEEN 1 AND 256
      AND length("captured_stage") BETWEEN 1 AND 256
      AND length("reward_item_id") BETWEEN 1 AND 256
      AND "quest_started_at" >= 0
      AND "created_at" >= 0
      AND "reward_quantity" > 0
    ),
  CONSTRAINT "quest_gathering_progress_receipts_resolution_check"
    CHECK (
      (
        "resolution" IS NULL
        AND "resolved_at" IS NULL
        AND "resulting_stage" IS NULL
        AND "resulting_progress" IS NULL
      )
      OR (
        "resolution" = 'applied'
        AND "resolved_at" IS NOT NULL
        AND "resulting_stage" IS NOT NULL
        AND "resulting_progress" IS NOT NULL
      )
      OR (
        "resolution" IN ('retired', 'ignored')
        AND "resolved_at" IS NOT NULL
        AND "resulting_stage" IS NULL
        AND "resulting_progress" IS NULL
      )
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quest_gathering_progress_receipts_operation_quest_unique"
  ON "quest_gathering_progress_receipts" USING btree ("operation_id", "quest_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quest_gathering_progress_receipts_pending_player"
  ON "quest_gathering_progress_receipts" USING btree ("player_id", "resolved_at", "created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quest_gathering_progress_receipts_incarnation"
  ON "quest_gathering_progress_receipts" USING btree ("player_id", "quest_id", "quest_started_at");
