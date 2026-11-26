-- Exact fixed-point prayer custody. One displayed point equals 1,000,000 units.
-- Keep the legacy whole-point column synchronized for older readers while the
-- strict transition boundary uses prayerPointUnits as its source of truth.
ALTER TABLE "characters"
  ADD COLUMN IF NOT EXISTS "prayerPointUnits" integer;
--> statement-breakpoint

UPDATE "characters"
SET "prayerMaxPoints" = GREATEST(
  1,
  LEAST(99, COALESCE("prayerMaxPoints", "prayerLevel", 1))
)
WHERE "prayerMaxPoints" IS NULL
   OR "prayerMaxPoints" < 1
   OR "prayerMaxPoints" > 99;
--> statement-breakpoint

ALTER TABLE "characters"
  ALTER COLUMN "prayerMaxPoints" SET NOT NULL;
--> statement-breakpoint

UPDATE "characters"
SET "prayerPointUnits" = LEAST(
  "prayerMaxPoints" * 1000000,
  GREATEST(0, COALESCE("prayerPoints", 1) * 1000000)
)
WHERE "prayerPointUnits" IS NULL;
--> statement-breakpoint

UPDATE "characters"
SET "prayerPointUnits" = LEAST(
  "prayerMaxPoints" * 1000000,
  GREATEST(0, "prayerPointUnits")
);
--> statement-breakpoint

UPDATE "characters"
SET "prayerPoints" = CASE
  WHEN "prayerPointUnits" = 0 THEN 0
  ELSE CEIL("prayerPointUnits" / 1000000.0)::integer
END;
--> statement-breakpoint

ALTER TABLE "characters"
  ALTER COLUMN "prayerPointUnits" SET DEFAULT 1000000;
--> statement-breakpoint

ALTER TABLE "characters"
  ALTER COLUMN "prayerPointUnits" SET NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'characters_prayer_point_units_range'
      AND conrelid = 'characters'::regclass
  ) THEN
    ALTER TABLE "characters"
      ADD CONSTRAINT "characters_prayer_point_units_range"
      CHECK ("prayerPointUnits" >= 0 AND "prayerPointUnits" <= 99000000);
  END IF;
END $$;
--> statement-breakpoint

UPDATE "characters"
SET "activePrayers" = '[]'::jsonb
WHERE jsonb_typeof("activePrayers") IS DISTINCT FROM 'array';
--> statement-breakpoint

UPDATE "characters" AS c
SET "activePrayers" = (
  SELECT COALESCE(jsonb_agg(prayer_id ORDER BY first_seen), '[]'::jsonb) AS value
  FROM (
    SELECT prayer_id, MIN(ordinality) AS first_seen
    FROM jsonb_array_elements_text(c."activePrayers") WITH ORDINALITY
      AS raw(prayer_id, ordinality)
    WHERE prayer_id ~ '^[a-z][a-z0-9_]{0,63}$'
    GROUP BY prayer_id
    ORDER BY MIN(ordinality)
    LIMIT 5
  ) AS valid
);
--> statement-breakpoint

UPDATE "characters"
SET "activePrayers" = '[]'::jsonb
WHERE "prayerPointUnits" = 0
  AND "activePrayers" <> '[]'::jsonb;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'characters_prayer_units_within_max'
      AND conrelid = 'characters'::regclass
  ) THEN
    ALTER TABLE "characters"
      ADD CONSTRAINT "characters_prayer_units_within_max"
      CHECK (
        "prayerMaxPoints" BETWEEN 1 AND 99
        AND "prayerPointUnits" <= "prayerMaxPoints" * 1000000
      );
  END IF;
END $$;
