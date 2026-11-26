-- Hyperia is the authoritative duel source; Hyperbet owns all native-SOL
-- market, order, payout, fee, referral, and points accounting. Preserve every
-- row from the retired in-server integration before removing its active tables.

CREATE TABLE IF NOT EXISTS "retired_arena_integration_records" (
  "id" serial PRIMARY KEY NOT NULL,
  "source_table" text NOT NULL,
  "record_fingerprint" text NOT NULL,
  "payload" jsonb NOT NULL,
  "archived_at" bigint DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_retired_arena_integration_source"
  ON "retired_arena_integration_records" USING btree ("source_table");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uidx_retired_arena_integration_fingerprint"
  ON "retired_arena_integration_records" USING btree ("source_table", "record_fingerprint");
--> statement-breakpoint
DO $archive$
DECLARE
  source_name text;
  source_count bigint;
  archived_count bigint;
BEGIN
  FOREACH source_name IN ARRAY ARRAY[
    'arena_agent_whitelist',
    'arena_rounds',
    'arena_round_events',
    'solana_markets',
    'solana_bets',
    'solana_payout_jobs',
    'arena_points',
    'arena_staking_points',
    'arena_invite_codes',
    'arena_invited_wallets',
    'arena_referral_points',
    'arena_fee_shares',
    'arena_wallet_links',
    'arena_point_ledger',
    'arena_point_accounts',
    'arena_failed_awards'
  ]
  LOOP
    IF to_regclass('public.' || source_name) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM %I', source_name)
      INTO source_count;

    EXECUTE format(
      'INSERT INTO "retired_arena_integration_records" '
      || '("source_table", "record_fingerprint", "payload") '
      || 'SELECT %L, md5(to_jsonb(source_row)::text), to_jsonb(source_row) '
      || 'FROM %I AS source_row '
      || 'ON CONFLICT ("source_table", "record_fingerprint") DO NOTHING',
      source_name,
      source_name
    );

    SELECT count(*)
      INTO archived_count
      FROM "retired_arena_integration_records"
      WHERE "source_table" = source_name;

    IF archived_count <> source_count THEN
      RAISE EXCEPTION
        'Retired arena archive verification failed for %: source %, archive %',
        source_name,
        source_count,
        archived_count;
    END IF;
  END LOOP;
END
$archive$;
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_failed_awards";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_point_accounts";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_point_ledger";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_wallet_links";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_fee_shares";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_referral_points";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_invited_wallets";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_invite_codes";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_staking_points";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_points";
--> statement-breakpoint
DROP TABLE IF EXISTS "solana_payout_jobs";
--> statement-breakpoint
DROP TABLE IF EXISTS "solana_bets";
--> statement-breakpoint
DROP TABLE IF EXISTS "solana_markets";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_round_events";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_rounds";
--> statement-breakpoint
DROP TABLE IF EXISTS "arena_agent_whitelist";
