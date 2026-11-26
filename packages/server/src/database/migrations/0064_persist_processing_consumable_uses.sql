-- Limited-use recipe consumables must survive short sessions, reconnects,
-- and process restarts without granting free uses or pre-consuming an item.
ALTER TABLE "characters"
  ADD COLUMN IF NOT EXISTS "processingConsumableUses" jsonb;
--> statement-breakpoint

UPDATE "characters"
SET "processingConsumableUses" = '{}'::jsonb
WHERE "processingConsumableUses" IS NULL;
--> statement-breakpoint

ALTER TABLE "characters"
  ALTER COLUMN "processingConsumableUses" SET DEFAULT '{}'::jsonb,
  ALTER COLUMN "processingConsumableUses" SET NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'characters_processing_consumable_uses_object'
      AND conrelid = 'characters'::regclass
  ) THEN
    ALTER TABLE "characters"
      ADD CONSTRAINT "characters_processing_consumable_uses_object"
      CHECK (jsonb_typeof("processingConsumableUses") = 'object');
  END IF;
END $$;
