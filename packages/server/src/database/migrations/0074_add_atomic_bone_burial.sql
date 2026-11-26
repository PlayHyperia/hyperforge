-- Commit one bone debit, Prayer XP/level/point progression, and an immutable
-- receipt together. Extend ordinary-autonomy categories only for the new typed
-- action and allow restart completion only when its exact receipt is present.

CREATE TABLE IF NOT EXISTS "bone_burial_operations" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "player_id" text NOT NULL,
  "item_id" text NOT NULL,
  "xp_amount" integer NOT NULL,
  "level_required" integer NOT NULL,
  "awarded_xp" integer NOT NULL,
  "operation_committed_xp" integer NOT NULL,
  "committed_level" integer NOT NULL,
  "request_fingerprint" text NOT NULL,
  "created_at" bigint DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT NOT NULL,
  CONSTRAINT "bone_burial_operations_player_id_characters_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "characters"("id") ON DELETE CASCADE,
  CONSTRAINT "bone_burial_operations_identity_check"
    CHECK (
      (
        "operation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR "operation_id" ~ '^bone-burial:[A-Za-z0-9_-]{20}$'
      )
      AND length("player_id") BETWEEN 1 AND 128
      AND length("item_id") BETWEEN 1 AND 256
      AND "request_fingerprint" ~ '^[0-9a-f]{64}$'
      AND "created_at" >= 0
    ),
  CONSTRAINT "bone_burial_operations_truth_check"
    CHECK (
      "xp_amount" > 0 AND "xp_amount" <= 1000000
      AND "level_required" BETWEEN 1 AND 99
      AND "awarded_xp" >= 0 AND "awarded_xp" <= "xp_amount"
      AND "operation_committed_xp" BETWEEN 0 AND 200000000
      AND "committed_level" BETWEEN 1 AND 99
    )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bone_burial_operations_player_created"
  ON "bone_burial_operations" USING btree ("player_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_bone_burial_operation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'bone burial operation receipts are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bone_burial_operations_reject_mutation"
  ON "bone_burial_operations";
--> statement-breakpoint
CREATE TRIGGER "bone_burial_operations_reject_mutation"
  BEFORE UPDATE OR DELETE ON "bone_burial_operations"
  FOR EACH ROW EXECUTE FUNCTION reject_bone_burial_operation_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bone_burial_operations_reject_truncate"
  ON "bone_burial_operations";
--> statement-breakpoint
CREATE TRIGGER "bone_burial_operations_reject_truncate"
  BEFORE TRUNCATE ON "bone_burial_operations"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_bone_burial_operation_mutation();
--> statement-breakpoint

ALTER TABLE "agent_autonomy_checkpoints"
  DROP CONSTRAINT IF EXISTS "agent_autonomy_checkpoints_attempt_action_type_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_checkpoints_action_type_check",
  ADD CONSTRAINT "agent_autonomy_checkpoints_action_type_check"
    CHECK (
      "last_applied_action_type" IS NULL
      OR "last_applied_action_type" IN (
        'attack', 'gather', 'pickup', 'lootGravestone', 'move',
        'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
        'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
        'storeBuy', 'use', 'bury', 'equip', 'bankDepositAll', 'homeTeleport',
        'stop', 'idle'
      )
    ),
  ADD CONSTRAINT "agent_autonomy_checkpoints_attempt_action_type_check"
    CHECK (
      "last_attempted_action_type" IS NULL
      OR "last_attempted_action_type" IN (
        'attack', 'gather', 'pickup', 'lootGravestone', 'move',
        'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
        'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
        'storeBuy', 'use', 'bury', 'equip', 'bankDepositAll', 'homeTeleport',
        'stop', 'idle'
      )
    );
--> statement-breakpoint

ALTER TABLE "agent_autonomy_progression_events"
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_events_category_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_events_edge_truth_check",
  ADD CONSTRAINT "agent_autonomy_progression_events_category_check"
    CHECK (
      "phase" = 'ordinary_progression'
      AND (
        "goal_type" IS NULL
        OR "goal_type" IN (
          'questing', 'combat', 'gathering', 'banking', 'cooking',
          'smelting', 'smithing', 'provisioning', 'exploring', 'idle'
        )
      )
      AND "action_type" IN (
        'attack', 'gather', 'pickup', 'lootGravestone', 'move',
        'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
        'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
        'storeBuy', 'use', 'bury', 'equip', 'bankDepositAll', 'homeTeleport', 'stop'
      )
      AND "decision_source" IN ('llm', 'scripted')
      AND (
        "applied_action_type" IS NULL
        OR "applied_action_type" IN (
          'attack', 'gather', 'pickup', 'lootGravestone', 'move',
          'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
          'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
          'storeBuy', 'use', 'bury', 'equip', 'bankDepositAll', 'homeTeleport', 'stop'
        )
      )
    ),
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
            AND "applied_action_type" IN ('bankDepositAll', 'bury')
          )
          OR (
            "event_source" = 'runtime'
            AND "action_outcome" <> 'unknown_after_restart'
          )
        )
      )
    );
--> statement-breakpoint

ALTER TABLE "agent_autonomy_progression_heads"
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_heads_category_check",
  ADD CONSTRAINT "agent_autonomy_progression_heads_category_check"
    CHECK (
      "head_revision" >= 0
      AND "updated_at" >= 0
      AND (
        "open_attempt_id" IS NULL
        OR (
          "open_phase" = 'ordinary_progression'
          AND (
            "open_goal_type" IS NULL
            OR "open_goal_type" IN (
              'questing', 'combat', 'gathering', 'banking', 'cooking',
              'smelting', 'smithing', 'provisioning', 'exploring', 'idle'
            )
          )
          AND "open_action_type" IN (
            'attack', 'gather', 'pickup', 'lootGravestone', 'move',
            'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
            'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
            'storeBuy', 'use', 'bury', 'equip', 'bankDepositAll', 'homeTeleport', 'stop'
          )
          AND "open_decision_source" IN ('llm', 'scripted')
          AND "open_started_at" >= 0
          AND "open_started_at" <= "updated_at"
        )
      )
    );
