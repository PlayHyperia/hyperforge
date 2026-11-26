import type { DistributedRateLimitPool } from "./distributed-rate-limit.js";
import {
  createDistributedRateLimitBucketKey,
  type DistributedRateLimitConfig,
} from "./distributed-rate-limit.js";

const FAILURE_SCOPE = "admin-auth-failure";
const LOCKOUT_SCOPE = "admin-auth-lockout";
const FAILURE_WINDOW_MS = 60_000;
const LOCKOUT_WINDOW_MS = 300_000;
const MAX_FAILURES = 5;

export type DistributedAdminAuthResult =
  | { status: "allowed" }
  | { status: "invalid"; remainingAttempts: number }
  | { status: "blocked"; retryAfterSeconds: number };

export async function evaluateDistributedAdminCredential(input: {
  config: Extract<DistributedRateLimitConfig, { enabled: true }>;
  credentialValid: boolean;
  networkIdentity: string;
  pool: DistributedRateLimitPool;
}): Promise<DistributedAdminAuthResult> {
  const failureKey = createDistributedRateLimitBucketKey({
    config: input.config,
    networkIdentity: input.networkIdentity,
    scope: FAILURE_SCOPE,
  });
  const lockoutKey = createDistributedRateLimitBucketKey({
    config: input.config,
    networkIdentity: input.networkIdentity,
    scope: LOCKOUT_SCOPE,
  });
  const client = await input.pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      "SET LOCAL lock_timeout = '1000ms'; SET LOCAL statement_timeout = '2000ms'",
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [failureKey],
    );

    const activeLockout = await client.query<{ ttl_ms: string }>(
      `SELECT GREATEST(
                0,
                CEIL(EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) * 1000)
              )::bigint::text AS ttl_ms
         FROM distributed_rate_limit_buckets
        WHERE bucket_key = $1
          AND scope = $2
          AND expires_at > clock_timestamp()`,
      [lockoutKey, LOCKOUT_SCOPE],
    );
    if (activeLockout.rows[0]) {
      const ttlMs = Number(activeLockout.rows[0].ttl_ms);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
        throw new Error("Distributed admin lockout returned invalid state");
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return {
        status: "blocked",
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1_000)),
      };
    }

    if (input.credentialValid) {
      await client.query(
        `DELETE FROM distributed_rate_limit_buckets
          WHERE bucket_key = ANY($1::text[])`,
        [[failureKey, lockoutKey]],
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return { status: "allowed" };
    }

    const failure = await client.query<{ current_count: string }>(
      `WITH authority_time AS MATERIALIZED (
         SELECT clock_timestamp() AS now
       )
       INSERT INTO distributed_rate_limit_buckets (
         bucket_key, scope, window_ms, window_started_at,
         expires_at, request_count, updated_at
       )
       SELECT
         $1::text,
         $2::text,
         $3::integer,
         authority_time.now,
         authority_time.now + ($3::integer * INTERVAL '1 millisecond'),
         1,
         authority_time.now
       FROM authority_time
       ON CONFLICT (bucket_key) DO UPDATE SET
         scope = EXCLUDED.scope,
         window_ms = EXCLUDED.window_ms,
         window_started_at = CASE
           WHEN distributed_rate_limit_buckets.expires_at <= EXCLUDED.updated_at
             THEN EXCLUDED.window_started_at
           ELSE distributed_rate_limit_buckets.window_started_at
         END,
         expires_at = CASE
           WHEN distributed_rate_limit_buckets.expires_at <= EXCLUDED.updated_at
             THEN EXCLUDED.expires_at
           ELSE distributed_rate_limit_buckets.expires_at
         END,
         request_count = CASE
           WHEN distributed_rate_limit_buckets.expires_at <= EXCLUDED.updated_at
             THEN 1
           ELSE distributed_rate_limit_buckets.request_count + 1
         END,
         updated_at = EXCLUDED.updated_at
       RETURNING request_count::text AS current_count`,
      [failureKey, FAILURE_SCOPE, FAILURE_WINDOW_MS],
    );
    const currentFailures = Number(failure.rows[0]?.current_count);
    if (!Number.isSafeInteger(currentFailures) || currentFailures < 1) {
      throw new Error(
        "Distributed admin failure counter returned invalid state",
      );
    }

    if (currentFailures >= MAX_FAILURES) {
      await client.query(
        `WITH authority_time AS MATERIALIZED (
           SELECT clock_timestamp() AS now
         )
         INSERT INTO distributed_rate_limit_buckets (
           bucket_key, scope, window_ms, window_started_at,
           expires_at, request_count, updated_at
         )
         SELECT
           $1::text,
           $2::text,
           $3::integer,
           authority_time.now,
           authority_time.now + ($3::integer * INTERVAL '1 millisecond'),
           1,
           authority_time.now
         FROM authority_time
         ON CONFLICT (bucket_key) DO UPDATE SET
           scope = EXCLUDED.scope,
           window_ms = EXCLUDED.window_ms,
           window_started_at = EXCLUDED.window_started_at,
           expires_at = EXCLUDED.expires_at,
           request_count = 1,
           updated_at = EXCLUDED.updated_at`,
        [lockoutKey, LOCKOUT_SCOPE, LOCKOUT_WINDOW_MS],
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return {
        status: "blocked",
        retryAfterSeconds: LOCKOUT_WINDOW_MS / 1_000,
      };
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return {
      status: "invalid",
      remainingAttempts: MAX_FAILURES - currentFailures,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original authority failure.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
