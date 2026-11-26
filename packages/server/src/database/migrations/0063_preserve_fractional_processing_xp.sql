-- Processing recipe manifests intentionally award fractional XP. Preserve it
-- exactly so an atomic item transform cannot diverge from the persisted skill.
ALTER TABLE "characters"
  ALTER COLUMN "firemakingXp" TYPE double precision USING "firemakingXp"::double precision,
  ALTER COLUMN "cookingXp" TYPE double precision USING "cookingXp"::double precision,
  ALTER COLUMN "smithingXp" TYPE double precision USING "smithingXp"::double precision,
  ALTER COLUMN "craftingXp" TYPE double precision USING "craftingXp"::double precision,
  ALTER COLUMN "fletchingXp" TYPE double precision USING "fletchingXp"::double precision,
  ALTER COLUMN "runecraftingXp" TYPE double precision USING "runecraftingXp"::double precision;
--> statement-breakpoint

UPDATE "characters"
SET
  "firemakingXp" = COALESCE("firemakingXp", 0),
  "cookingXp" = COALESCE("cookingXp", 0),
  "smithingXp" = COALESCE("smithingXp", 0),
  "craftingXp" = COALESCE("craftingXp", 0),
  "fletchingXp" = COALESCE("fletchingXp", 0),
  "runecraftingXp" = COALESCE("runecraftingXp", 0);
--> statement-breakpoint

ALTER TABLE "characters"
  ALTER COLUMN "firemakingXp" SET DEFAULT 0,
  ALTER COLUMN "firemakingXp" SET NOT NULL,
  ALTER COLUMN "cookingXp" SET DEFAULT 0,
  ALTER COLUMN "cookingXp" SET NOT NULL,
  ALTER COLUMN "smithingXp" SET DEFAULT 0,
  ALTER COLUMN "smithingXp" SET NOT NULL,
  ALTER COLUMN "craftingXp" SET DEFAULT 0,
  ALTER COLUMN "craftingXp" SET NOT NULL,
  ALTER COLUMN "fletchingXp" SET DEFAULT 0,
  ALTER COLUMN "fletchingXp" SET NOT NULL,
  ALTER COLUMN "runecraftingXp" SET DEFAULT 0,
  ALTER COLUMN "runecraftingXp" SET NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'characters_processing_xp_range'
      AND conrelid = 'characters'::regclass
  ) THEN
    ALTER TABLE "characters"
      ADD CONSTRAINT "characters_processing_xp_range"
      CHECK (
        "firemakingXp" BETWEEN 0 AND 200000000
        AND "cookingXp" BETWEEN 0 AND 200000000
        AND "smithingXp" BETWEEN 0 AND 200000000
        AND "craftingXp" BETWEEN 0 AND 200000000
        AND "fletchingXp" BETWEEN 0 AND 200000000
        AND "runecraftingXp" BETWEEN 0 AND 200000000
      );
  END IF;
END $$;
