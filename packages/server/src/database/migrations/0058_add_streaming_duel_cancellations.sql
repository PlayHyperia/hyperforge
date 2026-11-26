-- Preserve aborted streaming rounds as operational history without fabricating
-- a winner, loser, or competitive result. Early aborts may occur before both
-- contestant identities are available.

ALTER TABLE "streaming_duel_history" ADD COLUMN IF NOT EXISTS "cancellationReason" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "agent1Id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "agent1Name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "agent2Id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "agent2Name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "winReason" DROP NOT NULL;
