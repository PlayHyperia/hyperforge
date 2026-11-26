-- Record every non-idle ordinary-autonomy main action as two immutable edges:
-- a durable start before dispatch and a terminal outcome committed atomically
-- with the recovery checkpoint. The ledger contains only approved categories;
-- targets, payloads, plans, free text, inventory, bank, and wallet data are
-- deliberately absent. Existing checkpoints cannot prove historical starts,
-- so this migration performs no fabricated event backfill.

ALTER TABLE "agent_autonomy_checkpoints"
  ALTER COLUMN "schema_version" SET DEFAULT 3,
  DROP CONSTRAINT IF EXISTS "agent_autonomy_checkpoints_schema_version_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_checkpoints_action_outcome_check";
--> statement-breakpoint
UPDATE "agent_autonomy_checkpoints" SET "schema_version" = 3;
--> statement-breakpoint
ALTER TABLE "agent_autonomy_checkpoints"
  ADD CONSTRAINT "agent_autonomy_checkpoints_schema_version_check"
    CHECK ("schema_version" = 3),
  ADD CONSTRAINT "agent_autonomy_checkpoints_action_outcome_check"
    CHECK (
      "last_action_outcome" IS NULL
      OR "last_action_outcome" IN (
        'completed', 'dispatched', 'rejected', 'failed', 'idle',
        'unknown_after_restart', 'legacy_unknown'
      )
    );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_autonomy_progression_events" (
  "event_sequence" bigserial PRIMARY KEY NOT NULL,
  "event_key" text NOT NULL,
  "attempt_id" text NOT NULL,
  "character_id" text NOT NULL,
  "event_source" text NOT NULL,
  "event_type" text NOT NULL,
  "phase" text NOT NULL,
  "goal_type" text,
  "action_type" text NOT NULL,
  "decision_source" text NOT NULL,
  "action_outcome" text,
  "applied_action_type" text,
  "checkpoint_revision" bigint,
  "occurred_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_autonomy_progression_events"
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_events_event_key_unique",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_events_attempt_edge_unique",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_events_identity_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_events_category_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_events_edge_truth_check",
  ADD CONSTRAINT "agent_autonomy_progression_events_event_key_unique"
    UNIQUE ("event_key"),
  ADD CONSTRAINT "agent_autonomy_progression_events_attempt_edge_unique"
    UNIQUE ("attempt_id", "event_type"),
  ADD CONSTRAINT "agent_autonomy_progression_events_identity_check"
    CHECK (
      "attempt_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND length("character_id") BETWEEN 1 AND 128
      AND "occurred_at" >= 0
      AND "event_key" = "attempt_id" || CASE
        WHEN "event_type" = 'attempt_started' THEN ':started'
        WHEN "event_type" = 'attempt_terminal' THEN ':terminal'
        ELSE ':invalid'
      END
    ),
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
        'storeBuy', 'use', 'equip', 'bankDepositAll', 'homeTeleport', 'stop'
      )
      AND "decision_source" IN ('llm', 'scripted')
      AND (
        "applied_action_type" IS NULL
        OR "applied_action_type" IN (
          'attack', 'gather', 'pickup', 'lootGravestone', 'move',
          'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
          'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
          'storeBuy', 'use', 'equip', 'bankDepositAll', 'homeTeleport', 'stop'
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
        AND "event_source" IN ('runtime', 'restart_recovery')
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
          ("event_source" = 'restart_recovery'
            AND "action_outcome" = 'unknown_after_restart')
          OR
          ("event_source" = 'runtime'
            AND "action_outcome" <> 'unknown_after_restart')
        )
      )
    );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_agent_autonomy_progression_events_key"
  ON "agent_autonomy_progression_events" USING btree ("event_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_agent_autonomy_progression_events_attempt_edge"
  ON "agent_autonomy_progression_events" USING btree ("attempt_id", "event_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_autonomy_progression_events_character_sequence"
  ON "agent_autonomy_progression_events" USING btree ("character_id", "event_sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_autonomy_progression_events_action_time"
  ON "agent_autonomy_progression_events" USING btree ("action_type", "occurred_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_agent_autonomy_progression_events_terminal_checkpoint"
  ON "agent_autonomy_progression_events" USING btree ("character_id", "checkpoint_revision")
  WHERE "event_type" = 'attempt_terminal';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_autonomy_progression_heads" (
  "character_id" text PRIMARY KEY NOT NULL,
  "open_attempt_id" text,
  "open_phase" text,
  "open_goal_type" text,
  "open_action_type" text,
  "open_decision_source" text,
  "open_started_at" bigint,
  "head_revision" bigint DEFAULT 0 NOT NULL,
  "updated_at" bigint DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_autonomy_progression_heads"
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_heads_character_id_characters_id_fk",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_heads_bundle_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_heads_category_check",
  ADD CONSTRAINT "agent_autonomy_progression_heads_character_id_characters_id_fk"
    FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "agent_autonomy_progression_heads_bundle_check"
    CHECK (
      (
        "open_attempt_id" IS NULL
        AND "open_phase" IS NULL
        AND "open_goal_type" IS NULL
        AND "open_action_type" IS NULL
        AND "open_decision_source" IS NULL
        AND "open_started_at" IS NULL
      )
      OR (
        "open_attempt_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND "open_phase" IS NOT NULL
        AND "open_action_type" IS NOT NULL
        AND "open_decision_source" IS NOT NULL
        AND "open_started_at" IS NOT NULL
      )
    ),
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
            'storeBuy', 'use', 'equip', 'bankDepositAll', 'homeTeleport', 'stop'
          )
          AND "open_decision_source" IN ('llm', 'scripted')
          AND "open_started_at" >= 0
          AND "open_started_at" <= "updated_at"
        )
      )
    );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_agent_autonomy_progression_heads_open_attempt"
  ON "agent_autonomy_progression_heads" USING btree ("open_attempt_id")
  WHERE "open_attempt_id" IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_agent_autonomy_progression_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  started "agent_autonomy_progression_events"%ROWTYPE;
BEGIN
  IF NEW."event_type" = 'attempt_terminal' THEN
    SELECT * INTO started
    FROM "agent_autonomy_progression_events"
    WHERE "attempt_id" = NEW."attempt_id"
      AND "event_type" = 'attempt_started';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'agent autonomy terminal event has no started edge'
        USING ERRCODE = '23514';
    END IF;

    IF started."character_id" IS DISTINCT FROM NEW."character_id"
       OR started."phase" IS DISTINCT FROM NEW."phase"
       OR started."goal_type" IS DISTINCT FROM NEW."goal_type"
       OR started."action_type" IS DISTINCT FROM NEW."action_type"
       OR started."decision_source" IS DISTINCT FROM NEW."decision_source"
       OR NEW."occurred_at" < started."occurred_at" THEN
      RAISE EXCEPTION 'agent autonomy terminal event contradicts started edge'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_autonomy_progression_events_validate_insert"
  ON "agent_autonomy_progression_events";
--> statement-breakpoint
CREATE TRIGGER "agent_autonomy_progression_events_validate_insert"
  BEFORE INSERT ON "agent_autonomy_progression_events"
  FOR EACH ROW EXECUTE FUNCTION validate_agent_autonomy_progression_event_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_agent_autonomy_progression_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent autonomy progression events are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_autonomy_progression_events_no_mutation"
  ON "agent_autonomy_progression_events";
--> statement-breakpoint
CREATE TRIGGER "agent_autonomy_progression_events_no_mutation"
  BEFORE UPDATE OR DELETE ON "agent_autonomy_progression_events"
  FOR EACH ROW EXECUTE FUNCTION reject_agent_autonomy_progression_event_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_autonomy_progression_events_no_truncate"
  ON "agent_autonomy_progression_events";
--> statement-breakpoint
CREATE TRIGGER "agent_autonomy_progression_events_no_truncate"
  BEFORE TRUNCATE ON "agent_autonomy_progression_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_autonomy_progression_event_mutation();
