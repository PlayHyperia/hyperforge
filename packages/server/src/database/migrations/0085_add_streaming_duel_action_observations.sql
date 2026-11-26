-- Persist only the exact privacy-safe public duel-action contract. Rows become
-- eligible for delayed spectator publication only after this append commits.

CREATE TABLE IF NOT EXISTS "streaming_duel_action_observations" (
  "eventSequence" bigserial PRIMARY KEY NOT NULL,
  "operationId" text NOT NULL,
  "cycleId" text NOT NULL,
  "duelId" text NOT NULL,
  "sequence" integer NOT NULL,
  "observedAt" bigint NOT NULL,
  "actorId" text NOT NULL,
  "opponentId" text NOT NULL,
  "action" text NOT NULL,
  "observation" jsonb NOT NULL,
  CONSTRAINT "streaming_duel_action_observations_identity_check"
    CHECK (
      "operationId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND length("cycleId") BETWEEN 1 AND 256
      AND length("duelId") BETWEEN 1 AND 256
      AND length("actorId") BETWEEN 1 AND 256
      AND length("opponentId") BETWEEN 1 AND 256
      AND "actorId" <> "opponentId"
      AND "sequence" >= 1
      AND "observedAt" > 0
      AND "action" IN (
        'movement', 'engagement', 'food', 'prayer', 'style',
        'role_switch', 'damage'
      )
    ),
  CONSTRAINT "streaming_duel_action_observations_operation_unique"
    UNIQUE ("operationId"),
  CONSTRAINT "streaming_duel_action_observations_cycle_sequence_unique"
    UNIQUE ("cycleId", "sequence")
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_streaming_duel_action_observation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  observed_keys text[];
  public_value text;
  public_outcome text;
  public_amount jsonb;
BEGIN
  SELECT array_agg(key ORDER BY key)
  INTO observed_keys
  FROM jsonb_object_keys(NEW."observation") AS key;

  IF observed_keys <> ARRAY[
    'action', 'actorId', 'amount', 'combatRole', 'cycleId', 'duelId',
    'observedAt', 'opponentId', 'outcome', 'phase', 'schemaVersion',
    'sequence', 'tacticalMacro', 'tick', 'value'
  ]::text[] THEN
    RAISE EXCEPTION 'duel action observation has a non-public key set'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(NEW."observation"->'schemaVersion') <> 'number'
    OR jsonb_typeof(NEW."observation"->'sequence') <> 'number'
    OR jsonb_typeof(NEW."observation"->'tick') <> 'number'
    OR jsonb_typeof(NEW."observation"->'observedAt') <> 'number'
    OR NEW."observation"->>'schemaVersion' <> '1'
    OR NEW."observation"->>'sequence' !~ '^[1-9][0-9]*$'
    OR NEW."observation"->>'tick' !~ '^(0|[1-9][0-9]*)$'
    OR NEW."observation"->>'observedAt' !~ '^[1-9][0-9]*$'
    OR (NEW."observation"->>'sequence')::numeric > 9007199254740991
    OR (NEW."observation"->>'tick')::numeric > 9007199254740991
    OR (NEW."observation"->>'observedAt')::numeric > 9007199254740991
    OR (NEW."observation"->>'sequence')::numeric <> NEW."sequence"
    OR (NEW."observation"->>'observedAt')::bigint <> NEW."observedAt"
    OR NEW."observation"->>'cycleId' <> NEW."cycleId"
    OR NEW."observation"->>'duelId' <> NEW."duelId"
    OR NEW."observation"->>'actorId' <> NEW."actorId"
    OR NEW."observation"->>'opponentId' <> NEW."opponentId"
    OR NEW."observation"->>'action' <> NEW."action"
    OR concat(NEW."cycleId", NEW."duelId", NEW."actorId", NEW."opponentId")
      ~ '[[:cntrl:]]'
    OR concat(NEW."cycleId", NEW."duelId", NEW."actorId", NEW."opponentId")
      ~ U&'[\202A-\202E\2066-\2069]'
    OR NEW."observation"->>'phase' <> 'FIGHTING'
    OR NEW."observation"->>'combatRole' NOT IN ('melee', 'ranged', 'mage')
    OR NEW."observation"->>'tacticalMacro' NOT IN (
      'pressure', 'hold_range', 'kite', 'orbit', 'defensive_reset', 'finish'
    )
  THEN
    RAISE EXCEPTION 'duel action observation identity or base fields are invalid'
      USING ERRCODE = '23514';
  END IF;

  public_value := NEW."observation"->>'value';
  public_outcome := NEW."observation"->>'outcome';
  public_amount := NEW."observation"->'amount';

  IF NOT (
    (NEW."action" = 'movement'
      AND public_value = 'reposition'
      AND public_outcome IN ('accepted', 'rejected', 'error')
      AND jsonb_typeof(public_amount) = 'null')
    OR (NEW."action" = 'engagement'
      AND public_value IN ('initial', 'keep_alive')
      AND public_outcome IN ('accepted', 'rejected', 'error')
      AND jsonb_typeof(public_amount) = 'null')
    OR (NEW."action" = 'food'
      AND (
        (public_value = 'disengage' AND public_outcome = 'deferred'
          AND jsonb_typeof(public_amount) = 'null')
        OR (public_value = 'consume'
          AND public_outcome IN ('rejected', 'error')
          AND jsonb_typeof(public_amount) = 'null')
        OR (public_value = 'consume' AND public_outcome = 'committed'
          AND jsonb_typeof(public_amount) = 'number'
          AND public_amount::text ~ '^[1-9][0-9]*$'
          AND (public_amount::text)::numeric <= 9007199254740991)
      ))
    OR (NEW."action" = 'prayer'
      AND public_value IN (
        'superhuman_strength', 'rock_skin', 'hawk_eye', 'mystic_lore'
      )
      AND public_outcome IN ('committed', 'rejected', 'error')
      AND jsonb_typeof(public_amount) = 'null')
    OR (NEW."action" = 'style'
      AND public_value IN (
        'accurate', 'aggressive', 'controlled', 'defensive', 'rapid'
      )
      AND public_outcome IN ('accepted', 'rejected', 'error')
      AND jsonb_typeof(public_amount) = 'null')
    OR (NEW."action" = 'role_switch'
      AND public_value IN ('melee', 'ranged', 'mage')
      AND public_outcome IN ('committed', 'rejected', 'error', 'deferred')
      AND jsonb_typeof(public_amount) = 'null')
    OR (NEW."action" = 'damage'
      AND public_value = 'hit'
      AND public_outcome = 'committed'
      AND jsonb_typeof(public_amount) = 'number'
      AND public_amount::text ~ '^[1-9][0-9]*$'
      AND (public_amount::text)::numeric <= 9007199254740991)
  ) THEN
    RAISE EXCEPTION 'duel action observation semantics are invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_action_observations_validate_insert"
  ON "streaming_duel_action_observations";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_action_observations_validate_insert"
  BEFORE INSERT ON "streaming_duel_action_observations"
  FOR EACH ROW EXECUTE FUNCTION validate_streaming_duel_action_observation_insert();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_streaming_duel_action_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'streaming duel action observations are append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_action_observations_reject_mutation"
  ON "streaming_duel_action_observations";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_action_observations_reject_mutation"
  BEFORE UPDATE OR DELETE ON "streaming_duel_action_observations"
  FOR EACH ROW EXECUTE FUNCTION reject_streaming_duel_action_observation_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_action_observations_reject_truncate"
  ON "streaming_duel_action_observations";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_action_observations_reject_truncate"
  BEFORE TRUNCATE ON "streaming_duel_action_observations"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_streaming_duel_action_observation_mutation();
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_streaming_duel_action_observations_duel_sequence"
  ON "streaming_duel_action_observations" USING btree ("duelId", "sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_action_observations_observed_at"
  ON "streaming_duel_action_observations" USING btree ("observedAt");
