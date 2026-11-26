-- Persist the immutable opening style committed in each duel's competitive
-- snapshot. Nullable columns preserve compatibility with historical rows,
-- diagnostic contestants, and rolled-back writers.

ALTER TABLE "streaming_duel_history"
  ADD COLUMN IF NOT EXISTS "agent1OpeningStyle" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history"
  ADD COLUMN IF NOT EXISTS "agent2OpeningStyle" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'streaming_duel_history_agent1_opening_style_check'
      AND conrelid = 'streaming_duel_history'::regclass
  ) THEN
    ALTER TABLE "streaming_duel_history"
      ADD CONSTRAINT "streaming_duel_history_agent1_opening_style_check"
      CHECK (
        "agent1OpeningStyle" IS NULL
        OR "agent1OpeningStyle" IN ('melee', 'ranged', 'mage')
      );
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'streaming_duel_history_agent2_opening_style_check'
      AND conrelid = 'streaming_duel_history'::regclass
  ) THEN
    ALTER TABLE "streaming_duel_history"
      ADD CONSTRAINT "streaming_duel_history_agent2_opening_style_check"
      CHECK (
        "agent2OpeningStyle" IS NULL
        OR "agent2OpeningStyle" IN ('melee', 'ranged', 'mage')
      );
  END IF;
END $$;
