-- Persist the latest bounded ordinary-autonomy action on the lifecycle head so
-- public preparation can distinguish work from travel after same-category
-- transitions and process restarts. Exact targets, destinations, coordinates,
-- items, inventory, model output, and strategy remain absent.

ALTER TABLE "agent_autonomy_lifecycle_heads"
  ADD COLUMN IF NOT EXISTS "latest_action_type" text,
  ADD COLUMN IF NOT EXISTS "latest_action_started_at" bigint;
--> statement-breakpoint

ALTER TABLE "agent_autonomy_lifecycle_heads"
  DROP CONSTRAINT IF EXISTS "agent_autonomy_lifecycle_heads_truth_check",
  ADD CONSTRAINT "agent_autonomy_lifecycle_heads_truth_check"
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
      AND (
        (
          "latest_action_type" IS NULL
          AND "latest_action_started_at" IS NULL
        )
        OR (
          "latest_action_type" IS NOT NULL
          AND "latest_action_started_at" IS NOT NULL
          AND
          "latest_action_type" IN (
            'attack', 'gather', 'pickup', 'lootGravestone', 'move',
            'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
            'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
            'storeBuy', 'use', 'bury', 'equip', 'bankDepositAll',
            'bankWithdraw', 'homeTeleport', 'stop'
          )
          AND "latest_action_started_at" >= 0
        )
      )
      AND "head_revision" >= 0
      AND "updated_at" >= 0
    );
