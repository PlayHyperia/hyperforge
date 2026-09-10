-- Mapping creation is identity provisioning, not consent to enter a
-- money-bearing competitive queue. Preserve every existing preference while
-- making all future omitted values fail closed.

ALTER TABLE "agent_mappings"
  ALTER COLUMN "streaming_duel_enabled" SET DEFAULT false;
