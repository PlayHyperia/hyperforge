-- Bind every public duel market to one immutable, public-only competitive
-- snapshot. Plan evidence is persisted with readiness; the complete snapshot
-- is inserted in the same transaction that changes the preparation to frozen.

ALTER TABLE "streaming_duel_preparations"
  ADD COLUMN IF NOT EXISTS "agent1PlanEvidence" jsonb;
--> statement-breakpoint
ALTER TABLE "streaming_duel_preparations"
  ADD COLUMN IF NOT EXISTS "agent2PlanEvidence" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "streaming_duel_competitive_snapshots" (
  "preparationId" text PRIMARY KEY NOT NULL,
  "snapshotVersion" integer NOT NULL,
  "cycleId" text NOT NULL,
  "duelId" text NOT NULL,
  "duelKey" text NOT NULL,
  "snapshotDigest" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "frozenAt" bigint NOT NULL,
  "lifecycleStatus" text DEFAULT 'frozen' NOT NULL,
  "terminalOutcome" text,
  "terminalWinnerId" text,
  "terminalWinReason" text,
  "terminalCancellationReason" text,
  "terminalSeed" text,
  "terminalReplayHash" text,
  "terminalAt" bigint,
  CONSTRAINT "streaming_duel_competitive_snapshots_preparationId_fk"
    FOREIGN KEY ("preparationId")
    REFERENCES "public"."streaming_duel_preparations"("preparationId")
    ON DELETE CASCADE,
  CONSTRAINT "streaming_duel_competitive_snapshots_version_check"
    CHECK ("snapshotVersion" > 0),
  CONSTRAINT "streaming_duel_competitive_snapshots_key_check"
    CHECK ("duelKey" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "streaming_duel_competitive_snapshots_digest_check"
    CHECK ("snapshotDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "streaming_duel_competitive_snapshots_lifecycle_check"
    CHECK ("lifecycleStatus" IN ('retired', 'frozen', 'terminal')),
  CONSTRAINT "streaming_duel_competitive_snapshots_terminal_check"
    CHECK (
      ("lifecycleStatus" <> 'terminal'
        AND "terminalOutcome" IS NULL
        AND "terminalWinnerId" IS NULL
        AND "terminalWinReason" IS NULL
        AND "terminalCancellationReason" IS NULL
        AND "terminalSeed" IS NULL
        AND "terminalReplayHash" IS NULL
        AND "terminalAt" IS NULL)
      OR
      ("lifecycleStatus" = 'terminal'
        AND "terminalAt" IS NOT NULL
        AND "terminalAt" >= "frozenAt"
        AND (
          ("terminalOutcome" = 'win'
            AND "terminalWinnerId" IS NOT NULL
            AND "terminalWinReason" IN ('kill', 'forfeit', 'hp_advantage', 'damage_advantage')
            AND "terminalCancellationReason" IS NULL
            AND "terminalSeed" ~ '^(0|[1-9][0-9]{0,19})$'
            AND "terminalSeed"::numeric <= 18446744073709551615
            AND "terminalReplayHash" ~ '^[0-9a-f]{64}$')
          OR
          ("terminalOutcome" = 'draw'
            AND "terminalWinnerId" IS NULL
            AND "terminalWinReason" = 'draw'
            AND "terminalCancellationReason" = 'draw'
            AND "terminalSeed" ~ '^(0|[1-9][0-9]{0,19})$'
            AND "terminalSeed"::numeric <= 18446744073709551615
            AND "terminalReplayHash" ~ '^[0-9a-f]{64}$')
          OR
          ("terminalOutcome" = 'cancelled'
            AND "terminalWinnerId" IS NULL
            AND "terminalWinReason" IS NULL
            AND "terminalCancellationReason" ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
            AND "terminalSeed" IS NULL
            AND "terminalReplayHash" IS NULL)
        ))
    )
);
--> statement-breakpoint
-- A development database may already contain rows from an earlier draft of
-- this not-yet-shipped migration. They cannot prove whether a market reached a
-- terminal state, so quarantine them instead of replaying them as live.
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "lifecycleStatus" text DEFAULT 'retired' NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "terminalOutcome" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "terminalWinnerId" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "terminalWinReason" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "terminalCancellationReason" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "terminalSeed" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "terminalReplayHash" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "terminalAt" bigint;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ALTER COLUMN "lifecycleStatus" SET DEFAULT 'frozen';
--> statement-breakpoint
-- Recreate the lifecycle constraints after the additive upgrade above. This
-- also hardens development databases that saw an earlier draft of migration
-- 0066, where CREATE TABLE IF NOT EXISTS could not add the newer constraints.
ALTER TABLE "streaming_duel_competitive_snapshots"
  DROP CONSTRAINT IF EXISTS "streaming_duel_competitive_snapshots_lifecycle_check";
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD CONSTRAINT "streaming_duel_competitive_snapshots_lifecycle_check"
  CHECK ("lifecycleStatus" IN ('retired', 'frozen', 'terminal'));
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  DROP CONSTRAINT IF EXISTS "streaming_duel_competitive_snapshots_terminal_check";
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD CONSTRAINT "streaming_duel_competitive_snapshots_terminal_check"
  CHECK (
    ("lifecycleStatus" <> 'terminal'
      AND "terminalOutcome" IS NULL
      AND "terminalWinnerId" IS NULL
      AND "terminalWinReason" IS NULL
      AND "terminalCancellationReason" IS NULL
      AND "terminalSeed" IS NULL
      AND "terminalReplayHash" IS NULL
      AND "terminalAt" IS NULL)
    OR
    ("lifecycleStatus" = 'terminal'
      AND "terminalAt" IS NOT NULL
      AND "terminalAt" >= "frozenAt"
      AND (
        ("terminalOutcome" = 'win'
          AND "terminalWinnerId" IS NOT NULL
          AND "terminalWinReason" IN ('kill', 'forfeit', 'hp_advantage', 'damage_advantage')
          AND "terminalCancellationReason" IS NULL
          AND "terminalSeed" ~ '^(0|[1-9][0-9]{0,19})$'
          AND "terminalSeed"::numeric <= 18446744073709551615
          AND "terminalReplayHash" ~ '^[0-9a-f]{64}$')
        OR
        ("terminalOutcome" = 'draw'
          AND "terminalWinnerId" IS NULL
          AND "terminalWinReason" = 'draw'
          AND "terminalCancellationReason" = 'draw'
          AND "terminalSeed" ~ '^(0|[1-9][0-9]{0,19})$'
          AND "terminalSeed"::numeric <= 18446744073709551615
          AND "terminalReplayHash" ~ '^[0-9a-f]{64}$')
        OR
        ("terminalOutcome" = 'cancelled'
          AND "terminalWinnerId" IS NULL
          AND "terminalWinReason" IS NULL
          AND "terminalCancellationReason" ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
          AND "terminalSeed" IS NULL
          AND "terminalReplayHash" IS NULL)
      ))
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_streaming_duel_competitive_snapshots_cycle"
  ON "streaming_duel_competitive_snapshots" USING btree ("cycleId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_streaming_duel_competitive_snapshots_duel"
  ON "streaming_duel_competitive_snapshots" USING btree ("duelId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_streaming_duel_competitive_snapshots_key"
  ON "streaming_duel_competitive_snapshots" USING btree ("duelKey");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_competitive_snapshots_frozen"
  ON "streaming_duel_competitive_snapshots" USING btree ("frozenAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_competitive_snapshots_lifecycle"
  ON "streaming_duel_competitive_snapshots" USING btree ("lifecycleStatus", "frozenAt");
