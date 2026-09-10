-- Preserve historical strategy-context rows while freezing one exact,
-- privacy-safe matchup summary before every current external model request.

ALTER TABLE "streaming_duel_preparation_strategy_contexts"
  ADD COLUMN IF NOT EXISTS "opponentHistorySummary" jsonb;
--> statement-breakpoint

ALTER TABLE "streaming_duel_preparation_strategy_contexts"
  DROP CONSTRAINT IF EXISTS "streaming_duel_preparation_strategy_contexts_contract_check";
--> statement-breakpoint
ALTER TABLE "streaming_duel_preparation_strategy_contexts"
  ADD CONSTRAINT "streaming_duel_preparation_strategy_contexts_contract_check"
  CHECK (
    "policyVersion" = 'duel-preparation-role-v3'
    AND "protocolVersion" IN (
      'external-duel-preparation-strategy-v3',
      'external-duel-preparation-strategy-v4',
      'external-duel-preparation-strategy-v5'
    )
    AND length("agentName") BETWEEN 1 AND 128
    AND length("opponentName") BETWEEN 1 AND 128
    AND "agentName" !~ '[[:cntrl:]]'
    AND "opponentName" !~ '[[:cntrl:]]'
    AND ("ownPublicProfile" IS NULL OR jsonb_typeof("ownPublicProfile") = 'object')
    AND ("opponentPublicProfile" IS NULL OR jsonb_typeof("opponentPublicProfile") = 'object')
    AND (
      ("protocolVersion" IN (
        'external-duel-preparation-strategy-v3',
        'external-duel-preparation-strategy-v4'
      ) AND "opponentHistorySummary" IS NULL)
      OR
      ("protocolVersion" = 'external-duel-preparation-strategy-v5'
        AND jsonb_typeof("opponentHistorySummary") = 'object')
    )
    AND "boundAt" >= 0
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION require_current_streaming_duel_preparation_strategy_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  history_entry jsonb;
  derived_focus text;
BEGIN
  IF NEW."policyVersion" <> 'duel-preparation-role-v3'
    OR NEW."protocolVersion" <> 'external-duel-preparation-strategy-v5'
    OR NEW."opponentHistorySummary" IS NULL
    OR jsonb_typeof(NEW."opponentHistorySummary") <> 'object'
    OR NOT NEW."opponentHistorySummary" ?& ARRAY[
      'sampleSize',
      'observedOpponentOpeningStyleFocus',
      'recent'
    ]
    OR (
      SELECT count(*) FROM jsonb_object_keys(NEW."opponentHistorySummary")
    ) <> 3
    OR jsonb_typeof(NEW."opponentHistorySummary"->'sampleSize') <> 'number'
    OR (NEW."opponentHistorySummary"->>'sampleSize') !~ '^[0-8]$'
    OR jsonb_typeof(NEW."opponentHistorySummary"->'recent') <> 'array'
    OR jsonb_array_length(NEW."opponentHistorySummary"->'recent')
      <> (NEW."opponentHistorySummary"->>'sampleSize')::integer
    OR NOT (
      jsonb_typeof(NEW."opponentHistorySummary"->'observedOpponentOpeningStyleFocus') = 'null'
      OR (
        jsonb_typeof(NEW."opponentHistorySummary"->'observedOpponentOpeningStyleFocus') = 'string'
        AND NEW."opponentHistorySummary"->>'observedOpponentOpeningStyleFocus'
          IN ('melee', 'ranged', 'mage')
      )
    )
  THEN
    RAISE EXCEPTION 'strategy context does not use the current bounded history contract'
      USING ERRCODE = '23514';
  END IF;

  FOR history_entry IN
    SELECT value
    FROM jsonb_array_elements(NEW."opponentHistorySummary"->'recent')
  LOOP
    IF jsonb_typeof(history_entry) <> 'object'
      OR NOT history_entry ?& ARRAY[
        'result',
        'ownOpeningStyle',
        'opponentOpeningStyle',
        'winReason'
      ]
      OR (SELECT count(*) FROM jsonb_object_keys(history_entry)) <> 4
      OR history_entry->>'result' NOT IN ('win', 'loss', 'draw')
      OR history_entry->>'winReason' NOT IN (
        'kill',
        'forfeit',
        'hp_advantage',
        'damage_advantage',
        'draw'
      )
      OR ((history_entry->>'result' = 'draw')
        <> (history_entry->>'winReason' = 'draw'))
      OR NOT (
        jsonb_typeof(history_entry->'ownOpeningStyle') = 'null'
        OR (
          jsonb_typeof(history_entry->'ownOpeningStyle') = 'string'
          AND history_entry->>'ownOpeningStyle' IN ('melee', 'ranged', 'mage')
        )
      )
      OR NOT (
        jsonb_typeof(history_entry->'opponentOpeningStyle') = 'null'
        OR (
          jsonb_typeof(history_entry->'opponentOpeningStyle') = 'string'
          AND history_entry->>'opponentOpeningStyle' IN ('melee', 'ranged', 'mage')
        )
      )
    THEN
      RAISE EXCEPTION 'strategy context history entry is not privacy bounded'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  SELECT observed."style"
  INTO derived_focus
  FROM (
    SELECT
      entry.value->>'opponentOpeningStyle' AS "style",
      count(*) AS "observations",
      min(entry.ordinality) AS "newestOrdinality"
    FROM jsonb_array_elements(NEW."opponentHistorySummary"->'recent')
      WITH ORDINALITY AS entry(value, ordinality)
    WHERE jsonb_typeof(entry.value->'opponentOpeningStyle') = 'string'
    GROUP BY entry.value->>'opponentOpeningStyle'
    ORDER BY
      count(*) DESC,
      min(entry.ordinality) ASC,
      entry.value->>'opponentOpeningStyle' ASC
    LIMIT 1
  ) AS observed;
  IF derived_focus IS DISTINCT FROM
    NEW."opponentHistorySummary"->>'observedOpponentOpeningStyleFocus'
  THEN
    RAISE EXCEPTION 'strategy context history focus is not canonical'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
