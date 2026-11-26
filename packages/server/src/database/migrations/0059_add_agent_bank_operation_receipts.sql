-- Make embedded-agent bank transfers retry-safe across process loss. The
-- receipt is committed in the same transaction as the custody mutation.

CREATE TABLE IF NOT EXISTS "agent_bank_operations" (
  "operationId" text PRIMARY KEY NOT NULL,
  "playerId" text NOT NULL,
  "action" text NOT NULL,
  "bankId" text NOT NULL,
  "itemId" text,
  "requestedQuantity" integer NOT NULL,
  "committedQuantity" integer NOT NULL,
  "inventoryQuantityAfter" integer NOT NULL,
  "bankQuantityAfter" integer,
  "requestFingerprint" text NOT NULL,
  "createdAt" bigint DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT NOT NULL,
  CONSTRAINT "agent_bank_operations_playerId_characters_id_fk"
    FOREIGN KEY ("playerId") REFERENCES "public"."characters"("id")
    ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_bank_operations_player_created"
  ON "agent_bank_operations" USING btree ("playerId", "createdAt");
