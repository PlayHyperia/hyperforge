-- Persist the private, pre-market contestant preparation boundary. Exactly one
-- preparation may be active, and readiness is immutable per contestant.

CREATE TABLE IF NOT EXISTS "streaming_duel_preparations" (
  "preparationId" text PRIMARY KEY NOT NULL,
  "fencingToken" bigint NOT NULL,
  "agent1Id" text NOT NULL,
  "agent2Id" text NOT NULL,
  "allowedBankActions" text[] NOT NULL,
  "status" text NOT NULL,
  "selectedAt" bigint NOT NULL,
  "expiresAt" bigint NOT NULL,
  "agent1ReadyAt" bigint,
  "agent2ReadyAt" bigint,
  "frozenAt" bigint,
  "cancelledAt" bigint,
  "cancellationReason" text,
  "version" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "streaming_duel_preparations_agent1Id_characters_id_fk"
    FOREIGN KEY ("agent1Id") REFERENCES "public"."characters"("id")
    ON DELETE CASCADE,
  CONSTRAINT "streaming_duel_preparations_agent2Id_characters_id_fk"
    FOREIGN KEY ("agent2Id") REFERENCES "public"."characters"("id")
    ON DELETE CASCADE,
  CONSTRAINT "streaming_duel_preparations_distinct_agents_check"
    CHECK ("agent1Id" <> "agent2Id"),
  CONSTRAINT "streaming_duel_preparations_status_check"
    CHECK ("status" IN ('preparing', 'ready', 'frozen', 'cancelled', 'expired')),
  CONSTRAINT "streaming_duel_preparations_bank_actions_check"
    CHECK (
      cardinality("allowedBankActions") > 0
      AND 'open' = ANY("allowedBankActions")
      AND "allowedBankActions" <@ ARRAY['open', 'deposit', 'withdraw', 'deposit_all']::text[]
    ),
  CONSTRAINT "streaming_duel_preparations_time_check"
    CHECK ("expiresAt" > "selectedAt")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_streaming_duel_preparations_one_active"
  ON "streaming_duel_preparations" ((1))
  WHERE "status" IN ('preparing', 'ready');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_preparations_status"
  ON "streaming_duel_preparations" USING btree ("status", "expiresAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_preparations_agent1"
  ON "streaming_duel_preparations" USING btree ("agent1Id", "selectedAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_streaming_duel_preparations_agent2"
  ON "streaming_duel_preparations" USING btree ("agent2Id", "selectedAt");
