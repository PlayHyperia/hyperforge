-- Longrange is an authored bow combat style and a valid competitive decision.
-- Keep every existing privacy, identity, amount, and append-only invariant while
-- admitting that exact public value through the database boundary.

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
          AND public_amount::text ~ '^(0|[1-9][0-9]*)$'
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
        'accurate', 'aggressive', 'controlled', 'defensive', 'longrange',
        'rapid'
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
