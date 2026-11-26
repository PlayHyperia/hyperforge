-- Gathering manifests intentionally award half-point XP values. Preserve those
-- values exactly so an atomic harvest never loses XP when it reaches storage.
ALTER TABLE "characters"
  ALTER COLUMN "woodcuttingXp" TYPE double precision USING "woodcuttingXp"::double precision,
  ALTER COLUMN "miningXp" TYPE double precision USING "miningXp"::double precision,
  ALTER COLUMN "fishingXp" TYPE double precision USING "fishingXp"::double precision;
--> statement-breakpoint

UPDATE "characters"
SET
  "woodcuttingXp" = COALESCE("woodcuttingXp", 0),
  "miningXp" = COALESCE("miningXp", 0),
  "fishingXp" = COALESCE("fishingXp", 0);
--> statement-breakpoint

ALTER TABLE "characters"
  ALTER COLUMN "woodcuttingXp" SET DEFAULT 0,
  ALTER COLUMN "woodcuttingXp" SET NOT NULL,
  ALTER COLUMN "miningXp" SET DEFAULT 0,
  ALTER COLUMN "miningXp" SET NOT NULL,
  ALTER COLUMN "fishingXp" SET DEFAULT 0,
  ALTER COLUMN "fishingXp" SET NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'characters_gathering_xp_range'
      AND conrelid = 'characters'::regclass
  ) THEN
    ALTER TABLE "characters"
      ADD CONSTRAINT "characters_gathering_xp_range"
      CHECK (
        "woodcuttingXp" BETWEEN 0 AND 200000000
        AND "miningXp" BETWEEN 0 AND 200000000
        AND "fishingXp" BETWEEN 0 AND 200000000
      );
  END IF;
END $$;
