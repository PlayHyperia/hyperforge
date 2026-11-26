-- Persist bounded ordinary-autonomy context across process restarts without
-- making an interrupted action replayable. The table intentionally has no
-- pending-action or action-payload column; every recovered row is permanently
-- marked as requiring a fresh decision against authoritative world state.

CREATE TABLE IF NOT EXISTS "agent_autonomy_checkpoints" (
  "character_id" text PRIMARY KEY NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "revision" bigint DEFAULT 1 NOT NULL,
  "goal" jsonb,
  "plan" jsonb,
  "memories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "recent_action_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "tick_counter" bigint DEFAULT 0 NOT NULL,
  "last_applied_action_type" text,
  "last_applied_at" bigint,
  "requires_reassessment" boolean DEFAULT true NOT NULL,
  "updated_at" bigint DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT NOT NULL,
  CONSTRAINT "agent_autonomy_checkpoints_character_id_characters_id_fk"
    FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id")
    ON DELETE CASCADE,
  CONSTRAINT "agent_autonomy_checkpoints_schema_version_check"
    CHECK ("schema_version" = 1),
  CONSTRAINT "agent_autonomy_checkpoints_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "agent_autonomy_checkpoints_tick_counter_check"
    CHECK ("tick_counter" >= 0),
  CONSTRAINT "agent_autonomy_checkpoints_goal_check"
    CHECK ("goal" IS NULL OR jsonb_typeof("goal") = 'object'),
  CONSTRAINT "agent_autonomy_checkpoints_plan_check"
    CHECK ("plan" IS NULL OR jsonb_typeof("plan") = 'object'),
  CONSTRAINT "agent_autonomy_checkpoints_memories_check"
    CHECK (
      jsonb_typeof("memories") = 'array'
      AND jsonb_array_length("memories") <= 12
    ),
  CONSTRAINT "agent_autonomy_checkpoints_action_log_check"
    CHECK (
      jsonb_typeof("recent_action_log") = 'array'
      AND jsonb_array_length("recent_action_log") <= 8
    ),
  CONSTRAINT "agent_autonomy_checkpoints_action_type_check"
    CHECK (
      "last_applied_action_type" IS NULL
      OR "last_applied_action_type" IN (
        'attack', 'gather', 'pickup', 'lootGravestone', 'move',
        'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
        'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
        'storeBuy', 'use', 'equip', 'bankDepositAll', 'homeTeleport',
        'stop', 'idle'
      )
    ),
  CONSTRAINT "agent_autonomy_checkpoints_reassessment_check"
    CHECK ("requires_reassessment" = true),
  CONSTRAINT "agent_autonomy_checkpoints_timestamps_check"
    CHECK (
      "updated_at" >= 0
      AND ("last_applied_at" IS NULL OR (
        "last_applied_at" >= 0 AND "last_applied_at" <= "updated_at"
      ))
    )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_autonomy_checkpoints_updated_at"
  ON "agent_autonomy_checkpoints" USING btree ("updated_at");
