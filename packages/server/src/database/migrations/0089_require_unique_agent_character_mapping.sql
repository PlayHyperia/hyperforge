-- Competitive participation authority must resolve to exactly one mapping per
-- character. Refuse to guess or silently delete ownership data when historical
-- duplicates exist; an operator must reconcile them before this migration can
-- make the invariant durable.

DO $$
DECLARE
  duplicate_character_id text;
BEGIN
  SELECT "character_id"
  INTO duplicate_character_id
  FROM "agent_mappings"
  GROUP BY "character_id"
  HAVING count(*) > 1
  ORDER BY "character_id"
  LIMIT 1;

  IF duplicate_character_id IS NOT NULL THEN
    RAISE EXCEPTION
      'agent_mappings has duplicate character_id %, reconcile ownership before migration 0089',
      duplicate_character_id
      USING ERRCODE = '23505';
  END IF;
END
$$;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_agent_mappings_character";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_mappings_character"
  ON "agent_mappings" USING btree ("character_id");
