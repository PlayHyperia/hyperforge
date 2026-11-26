-- Add a category-only, append-only lifecycle history for ordinary autonomy.
-- The ledger is causally paired with the existing action-attempt transactions
-- and intentionally stores no targets, descriptions, prompts, plans, items,
-- inventory, bank contents, wallet data, or executable payloads.

CREATE TABLE IF NOT EXISTS "agent_autonomy_lifecycle_events" (
  "event_sequence" bigserial PRIMARY KEY NOT NULL,
  "event_key" text NOT NULL,
  "character_id" text NOT NULL,
  "attempt_id" text NOT NULL,
  "event_source" text NOT NULL,
  "event_type" text NOT NULL,
  "lifecycle_state" text NOT NULL,
  "previous_state" text,
  "previous_goal_type" text,
  "goal_type" text,
  "action_type" text NOT NULL,
  "action_outcome" text,
  "checkpoint_revision" bigint,
  "occurred_at" bigint NOT NULL,
  CONSTRAINT "agent_autonomy_lifecycle_events_character_id_characters_id_fk"
    FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_autonomy_lifecycle_events_identity_check"
    CHECK (
      "event_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:lifecycle:(goal-start|state-start|goal-terminal|reassess-terminal)$'
      AND "attempt_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND length("character_id") BETWEEN 1 AND 128
      AND "occurred_at" >= 0
    ),
  CONSTRAINT "agent_autonomy_lifecycle_events_category_check"
    CHECK (
      "event_source" IN ('runtime', 'restart_recovery', 'restart_reconciliation')
      AND "event_type" IN (
        'goal_selected', 'goal_cleared', 'state_entered',
        'reassessment_required'
      )
      AND "lifecycle_state" IN (
        'goal_selection', 'gathering', 'training', 'crafting',
        'provisioning', 'questing', 'exploring', 'reassessment'
      )
      AND (
        "previous_state" IS NULL
        OR "previous_state" IN (
          'goal_selection', 'gathering', 'training', 'crafting',
          'provisioning', 'questing', 'exploring', 'reassessment'
        )
      )
      AND (
        "previous_goal_type" IS NULL
        OR "previous_goal_type" IN (
          'questing', 'combat', 'gathering', 'banking', 'cooking',
          'smelting', 'smithing', 'provisioning', 'exploring', 'idle'
        )
      )
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
      AND (
        "action_outcome" IS NULL
        OR "action_outcome" IN (
          'completed', 'dispatched', 'rejected', 'failed',
          'unknown_after_restart'
        )
      )
    ),
  CONSTRAINT "agent_autonomy_lifecycle_events_truth_check"
    CHECK (
      (
        "event_type" = 'goal_selected'
        AND (
          (
            "event_key" = "attempt_id" || ':lifecycle:goal-start'
            AND "event_source" = 'runtime'
            AND "checkpoint_revision" IS NULL
            AND "action_outcome" IS NULL
          )
          OR (
            "event_key" = "attempt_id" || ':lifecycle:goal-terminal'
            AND "checkpoint_revision" > 0
            AND (
              ("event_source" = 'runtime' AND "action_outcome" IN ('completed', 'dispatched', 'rejected', 'failed'))
              OR ("event_source" = 'restart_recovery' AND "action_outcome" = 'unknown_after_restart')
              OR ("event_source" = 'restart_reconciliation' AND "action_outcome" = 'completed')
            )
          )
        )
        AND "lifecycle_state" = 'goal_selection'
        AND "goal_type" IS NOT NULL
        AND "previous_goal_type" IS DISTINCT FROM "goal_type"
      )
      OR (
        "event_type" = 'goal_cleared'
        AND (
          (
            "event_key" = "attempt_id" || ':lifecycle:goal-start'
            AND "event_source" = 'runtime'
            AND "checkpoint_revision" IS NULL
            AND "action_outcome" IS NULL
          )
          OR (
            "event_key" = "attempt_id" || ':lifecycle:goal-terminal'
            AND "checkpoint_revision" > 0
            AND (
              ("event_source" = 'runtime' AND "action_outcome" IN ('completed', 'dispatched', 'rejected', 'failed'))
              OR ("event_source" = 'restart_recovery' AND "action_outcome" = 'unknown_after_restart')
              OR ("event_source" = 'restart_reconciliation' AND "action_outcome" = 'completed')
            )
          )
        )
        AND "lifecycle_state" = 'goal_selection'
        AND "previous_goal_type" IS NOT NULL
        AND "goal_type" IS NULL
      )
      OR (
        "event_type" = 'state_entered'
        AND "event_key" = "attempt_id" || ':lifecycle:state-start'
        AND "event_source" = 'runtime'
        AND "lifecycle_state" NOT IN ('goal_selection', 'reassessment')
        AND "previous_state" IS DISTINCT FROM "lifecycle_state"
        AND "action_outcome" IS NULL
        AND "checkpoint_revision" IS NULL
      )
      OR (
        "event_type" = 'reassessment_required'
        AND "event_key" = "attempt_id" || ':lifecycle:reassess-terminal'
        AND "lifecycle_state" = 'reassessment'
        AND "action_outcome" IN ('rejected', 'failed', 'unknown_after_restart')
        AND "checkpoint_revision" > 0
        AND (
          (
            "event_source" = 'restart_recovery'
            AND "action_outcome" = 'unknown_after_restart'
          )
          OR (
            "event_source" = 'runtime'
            AND "action_outcome" IN ('rejected', 'failed')
          )
        )
      )
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_agent_autonomy_lifecycle_events_key"
  ON "agent_autonomy_lifecycle_events" ("event_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_autonomy_lifecycle_events_character_sequence"
  ON "agent_autonomy_lifecycle_events" ("character_id", "event_sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_autonomy_lifecycle_events_state_time"
  ON "agent_autonomy_lifecycle_events" ("lifecycle_state", "occurred_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_autonomy_lifecycle_heads" (
  "character_id" text PRIMARY KEY NOT NULL,
  "current_state" text DEFAULT 'goal_selection' NOT NULL,
  "current_goal_type" text,
  "head_revision" bigint DEFAULT 0 NOT NULL,
  "updated_at" bigint DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT NOT NULL,
  CONSTRAINT "agent_autonomy_lifecycle_heads_character_id_characters_id_fk"
    FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_autonomy_lifecycle_heads_truth_check"
    CHECK (
      "current_state" IN (
        'goal_selection', 'gathering', 'training', 'crafting',
        'provisioning', 'questing', 'exploring', 'reassessment'
      )
      AND (
        "current_goal_type" IS NULL
        OR "current_goal_type" IN (
          'questing', 'combat', 'gathering', 'banking', 'cooking',
          'smelting', 'smithing', 'provisioning', 'exploring', 'idle'
        )
      )
      AND "head_revision" >= 0
      AND "updated_at" >= 0
    )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_autonomy_lifecycle_heads_state_updated"
  ON "agent_autonomy_lifecycle_heads" ("current_state", "updated_at");
--> statement-breakpoint

-- Existing checkpoints can seed only the latest advisory goal. Every process
-- restart requires reassessment, so no historical transition is fabricated.
INSERT INTO "agent_autonomy_lifecycle_heads" (
  "character_id", "current_state", "current_goal_type", "head_revision", "updated_at"
)
SELECT
  checkpoint."character_id",
  'reassessment',
  CASE
    WHEN checkpoint."goal"->>'type' IN (
      'questing', 'combat', 'gathering', 'banking', 'cooking',
      'smelting', 'smithing', 'provisioning', 'exploring', 'idle'
    ) THEN checkpoint."goal"->>'type'
    ELSE NULL
  END,
  0,
  checkpoint."updated_at"
FROM "agent_autonomy_checkpoints" checkpoint
ON CONFLICT ("character_id") DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_agent_autonomy_lifecycle_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."event_type" IN ('goal_selected', 'goal_cleared', 'state_entered')
     AND NEW."checkpoint_revision" IS NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "agent_autonomy_progression_events" progression
      WHERE progression."attempt_id" = NEW."attempt_id"
        AND progression."character_id" = NEW."character_id"
        AND progression."event_type" = 'attempt_started'
        AND progression."event_source" = 'runtime'
        AND progression."goal_type" IS NOT DISTINCT FROM NEW."goal_type"
        AND progression."action_type" = NEW."action_type"
        AND progression."occurred_at" = NEW."occurred_at"
    ) THEN
      RAISE EXCEPTION 'agent autonomy lifecycle start lacks matching progression edge'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM "agent_autonomy_progression_events" progression
      WHERE progression."attempt_id" = NEW."attempt_id"
        AND progression."character_id" = NEW."character_id"
        AND progression."event_type" = 'attempt_terminal'
        AND progression."event_source" = NEW."event_source"
        AND progression."action_type" = NEW."action_type"
        AND progression."action_outcome" = NEW."action_outcome"
        AND progression."checkpoint_revision" = NEW."checkpoint_revision"
        AND progression."occurred_at" = NEW."occurred_at"
    ) THEN
      RAISE EXCEPTION 'agent autonomy lifecycle terminal lacks matching progression edge'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_autonomy_lifecycle_events_validate_insert"
  ON "agent_autonomy_lifecycle_events";
--> statement-breakpoint
CREATE TRIGGER "agent_autonomy_lifecycle_events_validate_insert"
  BEFORE INSERT ON "agent_autonomy_lifecycle_events"
  FOR EACH ROW EXECUTE FUNCTION validate_agent_autonomy_lifecycle_event();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_agent_autonomy_lifecycle_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent autonomy lifecycle events are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_autonomy_lifecycle_events_reject_mutation"
  ON "agent_autonomy_lifecycle_events";
--> statement-breakpoint
CREATE TRIGGER "agent_autonomy_lifecycle_events_reject_mutation"
  BEFORE UPDATE OR DELETE ON "agent_autonomy_lifecycle_events"
  FOR EACH ROW EXECUTE FUNCTION reject_agent_autonomy_lifecycle_event_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_autonomy_lifecycle_events_reject_truncate"
  ON "agent_autonomy_lifecycle_events";
--> statement-breakpoint
CREATE TRIGGER "agent_autonomy_lifecycle_events_reject_truncate"
  BEFORE TRUNCATE ON "agent_autonomy_lifecycle_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_autonomy_lifecycle_event_mutation();
