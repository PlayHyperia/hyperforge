-- Capture every authenticated mob-loot occurrence's active quest
-- incarnations inside the same transaction as the frozen loot roll and every
-- ground source. QuestSystem resolves each row once, so a process exit after
-- loot commit cannot lose, duplicate, or fabricate kill progress.

CREATE TABLE IF NOT EXISTS "quest_kill_progress_receipts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "operation_id" text NOT NULL,
  "player_id" text NOT NULL,
  "quest_id" text NOT NULL,
  "quest_started_at" bigint NOT NULL,
  "captured_stage" text NOT NULL,
  "mob_id" text NOT NULL,
  "mob_type" text NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "created_at" bigint NOT NULL,
  "resolved_at" bigint,
  "resolution" text,
  "resulting_stage" text,
  "resulting_progress" jsonb,
  CONSTRAINT "quest_kill_progress_receipts_operation_id_operations_log_id_fk"
    FOREIGN KEY ("operation_id") REFERENCES "public"."operations_log"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "quest_kill_progress_receipts_player_id_characters_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "public"."characters"("id")
    ON DELETE CASCADE,
  CONSTRAINT "quest_kill_progress_receipts_identity_check"
    CHECK (
      "operation_id" ~ '^ground-item-mob-loot:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND length("player_id") BETWEEN 1 AND 256
      AND length("quest_id") BETWEEN 1 AND 256
      AND length("captured_stage") BETWEEN 1 AND 256
      AND length("mob_id") BETWEEN 1 AND 256
      AND length("mob_type") BETWEEN 1 AND 128
      AND "quest_started_at" >= 0
      AND "created_at" >= 0
      AND "quantity" = 1
    ),
  CONSTRAINT "quest_kill_progress_receipts_resolution_check"
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
CREATE UNIQUE INDEX IF NOT EXISTS "quest_kill_progress_receipts_operation_quest_unique"
  ON "quest_kill_progress_receipts" USING btree ("operation_id", "quest_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quest_kill_progress_receipts_pending_player"
  ON "quest_kill_progress_receipts" USING btree ("player_id", "resolved_at", "created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quest_kill_progress_receipts_incarnation"
  ON "quest_kill_progress_receipts" USING btree ("player_id", "quest_id", "quest_started_at");
