CREATE TABLE "solana_agent_auth_challenges" (
  "challenge_id" text PRIMARY KEY NOT NULL,
  "wallet_hash" text NOT NULL,
  "message_hash" text NOT NULL,
  "nonce_hash" text NOT NULL,
  "config_fingerprint" text NOT NULL,
  "agent_name" text NOT NULL,
  "character_id" text,
  "issued_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "failed_attempts" integer DEFAULT 0 NOT NULL,
  "last_failure_at" timestamp with time zone,
  "failure_code" text,
  CONSTRAINT "solana_agent_auth_hash_lengths_check" CHECK (
    "wallet_hash" ~ '^[0-9a-f]{64}$'
    AND "message_hash" ~ '^[0-9a-f]{64}$'
    AND "nonce_hash" ~ '^[0-9a-f]{64}$'
    AND "config_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "solana_agent_auth_lifetime_check" CHECK ("expires_at" > "issued_at"),
  CONSTRAINT "solana_agent_auth_attempts_check" CHECK (
    "failed_attempts" >= 0 AND "failed_attempts" <= 5
  ),
  CONSTRAINT "solana_agent_auth_terminal_check" CHECK (
    NOT ("consumed_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "idx_solana_agent_auth_wallet_active"
  ON "solana_agent_auth_challenges" USING btree ("wallet_hash", "expires_at");
--> statement-breakpoint
CREATE INDEX "idx_solana_agent_auth_expiry"
  ON "solana_agent_auth_challenges" USING btree ("expires_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_solana_agent_auth_challenge_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."challenge_id" IS DISTINCT FROM OLD."challenge_id"
     OR NEW."wallet_hash" IS DISTINCT FROM OLD."wallet_hash"
     OR NEW."message_hash" IS DISTINCT FROM OLD."message_hash"
     OR NEW."nonce_hash" IS DISTINCT FROM OLD."nonce_hash"
     OR NEW."config_fingerprint" IS DISTINCT FROM OLD."config_fingerprint"
     OR NEW."agent_name" IS DISTINCT FROM OLD."agent_name"
     OR NEW."character_id" IS DISTINCT FROM OLD."character_id"
     OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'solana agent auth challenge authority fields are immutable';
  END IF;

  IF OLD."consumed_at" IS NOT NULL
     AND NEW."consumed_at" IS DISTINCT FROM OLD."consumed_at" THEN
    RAISE EXCEPTION 'consumed solana agent auth challenge is immutable';
  END IF;

  IF OLD."revoked_at" IS NOT NULL
     AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'revoked solana agent auth challenge is immutable';
  END IF;

  IF NEW."failed_attempts" < OLD."failed_attempts"
     OR NEW."failed_attempts" > OLD."failed_attempts" + 1 THEN
    RAISE EXCEPTION 'solana agent auth failed-attempt counter transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_solana_agent_auth_challenge_immutability"
BEFORE UPDATE ON "solana_agent_auth_challenges"
FOR EACH ROW
EXECUTE FUNCTION "enforce_solana_agent_auth_challenge_immutability"();
