-- Preserve historical host leases while making an external contestant's
-- deployment-pinned executable build identity immutable for its live lease.

ALTER TABLE "streaming_duel_preparation_agent_host_leases"
  ADD COLUMN IF NOT EXISTS "executableBuildId" text;
--> statement-breakpoint

ALTER TABLE "streaming_duel_preparation_agent_host_leases"
  DROP CONSTRAINT IF EXISTS "streaming_duel_preparation_agent_host_leases_build_check";
--> statement-breakpoint
ALTER TABLE "streaming_duel_preparation_agent_host_leases"
  ADD CONSTRAINT "streaming_duel_preparation_agent_host_leases_build_check"
  CHECK (
    "executableBuildId" IS NULL
    OR "executableBuildId" ~ '^[0-9a-f]{64}$'
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_streaming_duel_preparation_host_build_drift()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."executableBuildId" IS DISTINCT FROM OLD."executableBuildId" THEN
    RAISE EXCEPTION 'duel preparation host executable build identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "streaming_duel_preparation_host_build_immutable"
  ON "streaming_duel_preparation_agent_host_leases";
--> statement-breakpoint
CREATE TRIGGER "streaming_duel_preparation_host_build_immutable"
  BEFORE UPDATE ON "streaming_duel_preparation_agent_host_leases"
  FOR EACH ROW EXECUTE FUNCTION reject_streaming_duel_preparation_host_build_drift();
--> statement-breakpoint
