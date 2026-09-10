CREATE TABLE "agent_credential_sessions" (
  "session_id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "character_id" text NOT NULL,
  "auth_method" text NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_reason" text,
  CONSTRAINT "agent_credential_session_id_check" CHECK (
    "session_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "agent_credential_session_auth_method_check" CHECK (
    "auth_method" IN (
      'sol-wallet-signature-v1',
      'owner-credential-v1',
      'local-diagnostic-wallet-v1',
      'server-managed-agent-v1'
    )
  ),
  CONSTRAINT "agent_credential_session_lifetime_check" CHECK (
    "expires_at" > "issued_at"
    AND "expires_at" <= "issued_at" + INTERVAL '7 days'
  ),
  CONSTRAINT "agent_credential_session_revocation_check" CHECK (
    ("revoked_at" IS NULL AND "revoked_reason" IS NULL)
    OR (
      "revoked_at" IS NOT NULL
      AND "revoked_at" >= "issued_at"
      AND "revoked_reason" IN ('rotated', 'owner_revoked', 'security_revoked')
    )
  ),
  CONSTRAINT "agent_credential_sessions_account_id_users_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_credential_sessions_character_id_characters_id_fk"
    FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_credential_sessions_one_active"
  ON "agent_credential_sessions" USING btree ("account_id", "character_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_agent_credential_sessions_expiry"
  ON "agent_credential_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_agent_credential_session_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."session_id" IS DISTINCT FROM OLD."session_id"
     OR NEW."account_id" IS DISTINCT FROM OLD."account_id"
     OR NEW."character_id" IS DISTINCT FROM OLD."character_id"
     OR NEW."auth_method" IS DISTINCT FROM OLD."auth_method"
     OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'agent credential session authority fields are immutable';
  END IF;

  IF OLD."revoked_at" IS NOT NULL
     AND (
       NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       OR NEW."revoked_reason" IS DISTINCT FROM OLD."revoked_reason"
     ) THEN
    RAISE EXCEPTION 'revoked agent credential session is immutable';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_agent_credential_session_immutability"
BEFORE UPDATE ON "agent_credential_sessions"
FOR EACH ROW
EXECUTE FUNCTION "enforce_agent_credential_session_immutability"();
