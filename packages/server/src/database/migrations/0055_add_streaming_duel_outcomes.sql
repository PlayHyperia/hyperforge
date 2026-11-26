-- Represent streaming draws without fabricating a winner or loser.

ALTER TABLE "streaming_duel_history" ADD COLUMN IF NOT EXISTS "outcome" text DEFAULT 'win' NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ADD COLUMN IF NOT EXISTS "agent1Id" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ADD COLUMN IF NOT EXISTS "agent1Name" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ADD COLUMN IF NOT EXISTS "agent2Id" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ADD COLUMN IF NOT EXISTS "agent2Name" text;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ADD COLUMN IF NOT EXISTS "damageAgent1" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ADD COLUMN IF NOT EXISTS "damageAgent2" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "streaming_duel_history"
SET
  "agent1Id" = COALESCE("agent1Id", "winnerId"),
  "agent1Name" = COALESCE("agent1Name", "winnerName"),
  "agent2Id" = COALESCE("agent2Id", "loserId"),
  "agent2Name" = COALESCE("agent2Name", "loserName"),
  "damageAgent1" = "damageWinner",
  "damageAgent2" = "damageLoser";
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "agent1Id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "agent1Name" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "agent2Id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "agent2Name" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "winnerId" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "winnerName" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "loserId" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "loserName" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "damageWinner" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "streaming_duel_history" ALTER COLUMN "damageLoser" DROP NOT NULL;
