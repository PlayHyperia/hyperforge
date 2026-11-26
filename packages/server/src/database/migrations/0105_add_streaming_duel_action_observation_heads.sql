-- Allocate each cycle's immutable public action sequence through a real
-- write/write serialization point. An advisory lock followed by MAX(sequence)
-- can observe a stale SERIALIZABLE snapshot after another contestant commits.

CREATE TABLE IF NOT EXISTS "streaming_duel_action_observation_heads" (
  "cycleId" text PRIMARY KEY NOT NULL,
  "lastSequence" integer NOT NULL,
  CONSTRAINT "streaming_duel_action_observation_heads_identity_check"
    CHECK (
      length("cycleId") BETWEEN 1 AND 256
      AND "cycleId" !~ '[[:cntrl:]]'
      AND "lastSequence" >= 1
    )
);
--> statement-breakpoint

INSERT INTO "streaming_duel_action_observation_heads" ("cycleId", "lastSequence")
SELECT "cycleId", max("sequence")::integer
FROM "streaming_duel_action_observations"
GROUP BY "cycleId"
ON CONFLICT ("cycleId") DO UPDATE
SET "lastSequence" = GREATEST(
  "streaming_duel_action_observation_heads"."lastSequence",
  EXCLUDED."lastSequence"
);
