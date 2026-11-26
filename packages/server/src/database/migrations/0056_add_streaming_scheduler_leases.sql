-- Cross-process authority lease for the streaming duel scheduler.
-- The fencing token is never reset, even after a graceful release.

CREATE TABLE IF NOT EXISTS "streaming_scheduler_leases" (
  "lease_name" text PRIMARY KEY NOT NULL,
  "holder_id" text NOT NULL,
  "fencing_token" bigint DEFAULT 1 NOT NULL,
  "acquired_at" bigint NOT NULL,
  "renewed_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL
);
