-- Make ordinary-autonomy recovery context truthful about the difference between
-- an attempted action, a server-dispatched request, a confirmed completion, and
-- a rejection/failure. Existing v1 rows cannot prove their original outcome, so
-- the migration preserves them with explicit legacy_unknown provenance.

ALTER TABLE "agent_autonomy_checkpoints"
  ADD COLUMN IF NOT EXISTS "last_attempted_action_type" text,
  ADD COLUMN IF NOT EXISTS "last_action_outcome" text,
  ADD COLUMN IF NOT EXISTS "last_attempted_at" bigint;
--> statement-breakpoint
ALTER TABLE "agent_autonomy_checkpoints"
  ALTER COLUMN "schema_version" SET DEFAULT 2,
  DROP CONSTRAINT IF EXISTS "agent_autonomy_checkpoints_schema_version_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_checkpoints_timestamps_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_checkpoints_attempt_action_type_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_checkpoints_action_outcome_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_checkpoints_attempt_bundle_check",
  DROP CONSTRAINT IF EXISTS "agent_autonomy_checkpoints_action_truth_check";
--> statement-breakpoint
-- A malformed v1 pair has no trustworthy applied timestamp/type. Clear only
-- that advisory pair instead of fabricating evidence during migration.
UPDATE "agent_autonomy_checkpoints"
SET
  "last_applied_action_type" = NULL,
  "last_applied_at" = NULL
WHERE
  "last_action_outcome" IS NULL
  AND (("last_applied_action_type" IS NULL) <> ("last_applied_at" IS NULL));
--> statement-breakpoint
UPDATE "agent_autonomy_checkpoints"
SET
  "last_attempted_action_type" = COALESCE(
    "last_attempted_action_type",
    "last_applied_action_type"
  ),
  "last_action_outcome" = COALESCE(
    "last_action_outcome",
    CASE
      WHEN "last_applied_action_type" IS NULL THEN NULL
      ELSE 'legacy_unknown'
    END
  ),
  "last_attempted_at" = COALESCE(
    "last_attempted_at",
    "last_applied_at"
  ),
  "schema_version" = 2;
--> statement-breakpoint
ALTER TABLE "agent_autonomy_checkpoints"
  ADD CONSTRAINT "agent_autonomy_checkpoints_schema_version_check"
    CHECK ("schema_version" = 2),
  ADD CONSTRAINT "agent_autonomy_checkpoints_attempt_action_type_check"
    CHECK (
      "last_attempted_action_type" IS NULL
      OR "last_attempted_action_type" IN (
        'attack', 'gather', 'pickup', 'lootGravestone', 'move',
        'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
        'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
        'storeBuy', 'use', 'equip', 'bankDepositAll', 'homeTeleport',
        'stop', 'idle'
      )
    ),
  ADD CONSTRAINT "agent_autonomy_checkpoints_action_outcome_check"
    CHECK (
      "last_action_outcome" IS NULL
      OR "last_action_outcome" IN (
        'completed', 'dispatched', 'rejected', 'failed', 'idle',
        'legacy_unknown'
      )
    ),
  ADD CONSTRAINT "agent_autonomy_checkpoints_attempt_bundle_check"
    CHECK (
      (
        "last_attempted_action_type" IS NULL
        AND "last_action_outcome" IS NULL
        AND "last_attempted_at" IS NULL
      )
      OR (
        "last_attempted_action_type" IS NOT NULL
        AND "last_action_outcome" IS NOT NULL
        AND "last_attempted_at" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "agent_autonomy_checkpoints_action_truth_check"
    CHECK (
      (
        (
          "last_applied_action_type" IS NULL
          AND "last_applied_at" IS NULL
        )
        OR (
          "last_applied_action_type" IS NOT NULL
          AND "last_applied_at" IS NOT NULL
        )
      )
      AND (
        "last_action_outcome" IS NOT NULL
        OR (
          "last_applied_action_type" IS NULL
          AND "last_applied_at" IS NULL
        )
      )
      AND (
        "last_action_outcome" NOT IN (
          'completed', 'dispatched', 'legacy_unknown'
        )
        OR (
          "last_applied_action_type" IS NOT NULL
          AND "last_applied_at" IS NOT NULL
        )
      )
    ),
  ADD CONSTRAINT "agent_autonomy_checkpoints_timestamps_check"
    CHECK (
      "updated_at" >= 0
      AND (
        "last_applied_at" IS NULL
        OR (
          "last_applied_at" >= 0
          AND "last_applied_at" <= "updated_at"
        )
      )
      AND (
        "last_attempted_at" IS NULL
        OR (
          "last_attempted_at" >= 0
          AND "last_attempted_at" <= "updated_at"
        )
      )
      AND (
        "last_applied_at" IS NULL
        OR "last_attempted_at" IS NULL
        OR "last_applied_at" <= "last_attempted_at"
      )
      AND (
        "last_action_outcome" NOT IN ('completed', 'dispatched')
        OR "last_applied_at" = "last_attempted_at"
      )
      AND (
        "last_action_outcome" <> 'legacy_unknown'
        OR (
          "last_applied_action_type" = "last_attempted_action_type"
          AND "last_applied_at" = "last_attempted_at"
        )
      )
      AND (
        "last_action_outcome" <> 'idle'
        OR "last_attempted_action_type" = 'idle'
      )
      AND (
        "last_action_outcome" IN ('idle', 'legacy_unknown')
        OR "last_attempted_action_type" <> 'idle'
      )
    );
