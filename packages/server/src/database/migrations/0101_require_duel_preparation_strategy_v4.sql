-- Preserve immutable v3 strategy-context evidence while requiring every new
-- externally hosted preparation to bind the current v4 armor-choice contract.

ALTER TABLE "streaming_duel_preparation_strategy_contexts"
  DROP CONSTRAINT IF EXISTS "streaming_duel_preparation_strategy_contexts_contract_check";
--> statement-breakpoint
ALTER TABLE "streaming_duel_preparation_strategy_contexts"
  ADD CONSTRAINT "streaming_duel_preparation_strategy_contexts_contract_check"
  CHECK (
    "policyVersion" = 'duel-preparation-role-v3'
    AND "protocolVersion" IN (
      'external-duel-preparation-strategy-v3',
      'external-duel-preparation-strategy-v4'
    )
    AND length("agentName") BETWEEN 1 AND 128
    AND length("opponentName") BETWEEN 1 AND 128
    AND "agentName" !~ '[[:cntrl:]]'
    AND "opponentName" !~ '[[:cntrl:]]'
    AND ("ownPublicProfile" IS NULL OR jsonb_typeof("ownPublicProfile") = 'object')
    AND ("opponentPublicProfile" IS NULL OR jsonb_typeof("opponentPublicProfile") = 'object')
    AND "boundAt" >= 0
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION require_current_streaming_duel_preparation_strategy_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."policyVersion" <> 'duel-preparation-role-v3'
    OR NEW."protocolVersion" <> 'external-duel-preparation-strategy-v4'
  THEN
    RAISE EXCEPTION 'strategy context does not use the current contract'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_strategy_contexts_current_contract"
  ON "streaming_duel_preparation_strategy_contexts";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_strategy_contexts_current_contract"
  BEFORE INSERT ON "streaming_duel_preparation_strategy_contexts"
  FOR EACH ROW EXECUTE FUNCTION require_current_streaming_duel_preparation_strategy_context();
