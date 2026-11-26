-- Persist the authoritative market-lock, fight-start, and completed-recovery
-- edges for every competitive duel snapshot. Terminal sporting truth remains
-- immutable when a recovered row is retired from restart replay.

ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "lockedAt" bigint;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "duelStartedAt" bigint;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD COLUMN IF NOT EXISTS "recoveredAt" bigint;
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  DROP CONSTRAINT IF EXISTS "streaming_duel_competitive_snapshots_terminal_check";
--> statement-breakpoint
ALTER TABLE "streaming_duel_competitive_snapshots"
  ADD CONSTRAINT "streaming_duel_competitive_snapshots_terminal_check"
  CHECK (
    ("lockedAt" IS NULL OR "lockedAt" >= "frozenAt")
    AND (
      "duelStartedAt" IS NULL
      OR ("lockedAt" IS NOT NULL AND "duelStartedAt" >= "lockedAt")
    )
    AND (
      ("lifecycleStatus" = 'frozen'
        AND "terminalOutcome" IS NULL
        AND "terminalWinnerId" IS NULL
        AND "terminalWinReason" IS NULL
        AND "terminalCancellationReason" IS NULL
        AND "terminalSeed" IS NULL
        AND "terminalReplayHash" IS NULL
        AND "terminalAt" IS NULL
        AND "recoveredAt" IS NULL)
      OR
      ("lifecycleStatus" IN ('terminal', 'retired')
        AND "terminalAt" IS NOT NULL
        AND "terminalAt" >= "frozenAt"
        AND ("duelStartedAt" IS NULL OR "terminalAt" >= "duelStartedAt")
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
        )
        AND (
          ("lifecycleStatus" = 'terminal' AND "recoveredAt" IS NULL)
          OR
          ("lifecycleStatus" = 'retired'
            AND "recoveredAt" IS NOT NULL
            AND "recoveredAt" >= "terminalAt")
        ))
      OR
      -- Migration 0066 quarantined draft rows as retired without terminal
      -- evidence. Preserve those inert rows without making them replayable.
      ("lifecycleStatus" = 'retired'
        AND "terminalOutcome" IS NULL
        AND "terminalWinnerId" IS NULL
        AND "terminalWinReason" IS NULL
        AND "terminalCancellationReason" IS NULL
        AND "terminalSeed" IS NULL
        AND "terminalReplayHash" IS NULL
        AND "terminalAt" IS NULL
        AND "lockedAt" IS NULL
        AND "duelStartedAt" IS NULL
        AND "recoveredAt" IS NULL)
    )
  );
