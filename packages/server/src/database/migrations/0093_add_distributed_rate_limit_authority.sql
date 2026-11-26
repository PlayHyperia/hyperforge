CREATE TABLE "distributed_rate_limit_buckets" (
  "bucket_key" text PRIMARY KEY NOT NULL,
  "scope" text NOT NULL,
  "window_ms" integer NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "request_count" bigint NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "distributed_rate_limit_bucket_key_check" CHECK (
    "bucket_key" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "distributed_rate_limit_scope_check" CHECK (
    "scope" ~ '^[a-z0-9][a-z0-9-]{0,63}$'
  ),
  CONSTRAINT "distributed_rate_limit_window_check" CHECK (
    "window_ms" BETWEEN 1000 AND 3600000
    AND "expires_at" = "window_started_at" + ("window_ms" * INTERVAL '1 millisecond')
  ),
  CONSTRAINT "distributed_rate_limit_count_check" CHECK (
    "request_count" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT "distributed_rate_limit_updated_check" CHECK (
    "updated_at" >= "window_started_at"
    AND "updated_at" <= "expires_at"
  )
);
--> statement-breakpoint
CREATE INDEX "idx_distributed_rate_limit_buckets_expiry"
  ON "distributed_rate_limit_buckets" USING btree ("expires_at");
