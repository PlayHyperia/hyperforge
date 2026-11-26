-- Make safe-area death custody durable from the initial inventory/equipment
-- capture through kept-item return and gravestone recovery. Legacy rows remain
-- valid with no capture-operation identity and an empty kept-item set.

ALTER TABLE "player_deaths"
  ADD COLUMN IF NOT EXISTS "keptItems" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "player_deaths"
  ADD COLUMN IF NOT EXISTS "deathOperationId" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'player_deaths_kept_items_array_check'
  ) THEN
    ALTER TABLE "player_deaths"
      ADD CONSTRAINT "player_deaths_kept_items_array_check"
      CHECK (jsonb_typeof("keptItems") = 'array');
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'player_deaths_death_operation_id_check'
  ) THEN
    ALTER TABLE "player_deaths"
      ADD CONSTRAINT "player_deaths_death_operation_id_check"
      CHECK (
        "deathOperationId" IS NULL
        OR length("deathOperationId") BETWEEN 1 AND 256
      );
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'player_deaths_death_operation_id_operations_log_id_fk'
  ) THEN
    ALTER TABLE "player_deaths"
      ADD CONSTRAINT "player_deaths_death_operation_id_operations_log_id_fk"
      FOREIGN KEY ("deathOperationId") REFERENCES "public"."operations_log"("id")
      ON DELETE RESTRICT;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_deaths_death_operation_id_unique"
  ON "player_deaths" USING btree ("deathOperationId")
  WHERE "deathOperationId" IS NOT NULL;
