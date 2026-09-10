-- Keep the database lifecycle allowlist aligned with the typed ordinary-agent
-- action contract. Autocast selection contains only the bounded action type;
-- exact spell identity remains outside lifecycle heads and events.

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
        'storeBuy', 'use', 'bury', 'equip', 'setAutocast',
        'bankDepositAll', 'bankWithdraw', 'homeTeleport', 'stop', 'idle'
      )
    ),
  ADD CONSTRAINT "agent_autonomy_checkpoints_attempt_action_type_check"
    CHECK (
      "last_attempted_action_type" IS NULL
      OR "last_attempted_action_type" IN (
        'attack', 'gather', 'pickup', 'lootGravestone', 'move',
        'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
        'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
        'storeBuy', 'use', 'bury', 'equip', 'setAutocast',
        'bankDepositAll', 'bankWithdraw', 'homeTeleport', 'stop', 'idle'
      )
    );
--> statement-breakpoint

ALTER TABLE "agent_autonomy_progression_events"
  DROP CONSTRAINT IF EXISTS "agent_autonomy_progression_events_category_check",
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
        'storeBuy', 'use', 'bury', 'equip', 'setAutocast',
        'bankDepositAll', 'bankWithdraw', 'homeTeleport', 'stop'
      )
      AND "decision_source" IN ('llm', 'scripted')
      AND (
        "applied_action_type" IS NULL
        OR "applied_action_type" IN (
          'attack', 'gather', 'pickup', 'lootGravestone', 'move',
          'questAccept', 'questComplete', 'firemake', 'navigateTo', 'cook',
          'smelt', 'smith', 'runecraft', 'craft', 'fletch', 'tan',
          'storeBuy', 'use', 'bury', 'equip', 'setAutocast',
          'bankDepositAll', 'bankWithdraw', 'homeTeleport', 'stop'
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
            'storeBuy', 'use', 'bury', 'equip', 'setAutocast',
            'bankDepositAll', 'bankWithdraw', 'homeTeleport', 'stop'
          )
          AND "open_decision_source" IN ('llm', 'scripted')
          AND "open_started_at" >= 0
          AND "open_started_at" <= "updated_at"
        )
      )
    );
--> statement-breakpoint

ALTER TABLE "agent_autonomy_lifecycle_events"
  DROP CONSTRAINT IF EXISTS "agent_autonomy_lifecycle_events_category_check",
  ADD CONSTRAINT "agent_autonomy_lifecycle_events_category_check"
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
        'storeBuy', 'use', 'bury', 'equip', 'setAutocast',
        'bankDepositAll', 'bankWithdraw', 'homeTeleport', 'stop'
      )
      AND (
        "action_outcome" IS NULL
        OR "action_outcome" IN (
          'completed', 'dispatched', 'rejected', 'failed',
          'unknown_after_restart'
        )
      )
    );
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
            'storeBuy', 'use', 'bury', 'equip', 'setAutocast',
            'bankDepositAll', 'bankWithdraw', 'homeTeleport', 'stop'
          )
          AND "latest_action_started_at" >= 0
        )
      )
      AND "head_revision" >= 0
      AND "updated_at" >= 0
    );
