import { createHash, createHmac } from "node:crypto";

import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type pg from "pg";

const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4_096;
const MAX_SCOPE_LENGTH = 64;
const MAX_NETWORK_IDENTITY_LENGTH = 256;
const MAX_LIMIT = 10_000;
const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 3_600_000;
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export class DistributedRateLimitConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistributedRateLimitConfigurationError";
  }
}

export type DistributedRateLimitConfig =
  | { enabled: false }
  | {
      enabled: true;
      keyFingerprint: string;
      keySecret: string;
    };

export type DistributedRateLimitPool = Pick<pg.Pool, "connect">;

export type DistributedRateLimitResult = {
  allowed: boolean;
  current: number;
  limit: number;
  retryAfterSeconds: number;
  ttlMs: number;
};

function parseBooleanFlag(name: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new DistributedRateLimitConfigurationError(
    `${name} must be an explicit boolean value`,
  );
}

function isDeploymentEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment.NODE_ENV === "production" || environment.NODE_ENV === "staging"
  );
}

export function readDistributedRateLimitConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DistributedRateLimitConfig {
  const deployment = isDeploymentEnvironment(environment);
  const rawEnabled = environment.DISTRIBUTED_RATE_LIMIT_ENABLED;
  const explicitlyEnabled =
    rawEnabled === undefined
      ? null
      : parseBooleanFlag("DISTRIBUTED_RATE_LIMIT_ENABLED", rawEnabled);

  if (deployment && explicitlyEnabled === false) {
    throw new DistributedRateLimitConfigurationError(
      "DISTRIBUTED_RATE_LIMIT_ENABLED cannot disable shared authentication limits in production or staging",
    );
  }

  const enabled = deployment || explicitlyEnabled === true;
  if (!enabled) return { enabled: false };

  const keySecret = environment.DISTRIBUTED_RATE_LIMIT_KEY_SECRET;
  if (!keySecret) {
    throw new DistributedRateLimitConfigurationError(
      "DISTRIBUTED_RATE_LIMIT_KEY_SECRET is required when distributed rate limiting is enabled",
    );
  }
  if (keySecret !== keySecret.trim()) {
    throw new DistributedRateLimitConfigurationError(
      "DISTRIBUTED_RATE_LIMIT_KEY_SECRET must not contain outer whitespace",
    );
  }
  const secretBytes = Buffer.byteLength(keySecret, "utf8");
  if (secretBytes < MIN_SECRET_BYTES) {
    throw new DistributedRateLimitConfigurationError(
      `DISTRIBUTED_RATE_LIMIT_KEY_SECRET must be at least ${MIN_SECRET_BYTES} bytes`,
    );
  }
  if (secretBytes > MAX_SECRET_BYTES) {
    throw new DistributedRateLimitConfigurationError(
      `DISTRIBUTED_RATE_LIMIT_KEY_SECRET must not exceed ${MAX_SECRET_BYTES} bytes`,
    );
  }

  return {
    enabled: true,
    keyFingerprint: createHash("sha256")
      .update("hyperia-distributed-rate-limit-key-v1\0", "utf8")
      .update(keySecret, "utf8")
      .digest("hex")
      .slice(0, 16),
    keySecret,
  };
}

function validateScope(scope: string): void {
  if (
    scope.length < 1 ||
    scope.length > MAX_SCOPE_LENGTH ||
    !SCOPE_PATTERN.test(scope)
  ) {
    throw new DistributedRateLimitConfigurationError(
      "Distributed rate-limit scope is invalid",
    );
  }
}

function validateNetworkIdentity(networkIdentity: string): void {
  if (
    networkIdentity.length < 1 ||
    networkIdentity.length > MAX_NETWORK_IDENTITY_LENGTH ||
    networkIdentity !== networkIdentity.trim() ||
    CONTROL_CHARACTER_PATTERN.test(networkIdentity)
  ) {
    throw new DistributedRateLimitConfigurationError(
      "Distributed rate-limit network identity is invalid",
    );
  }
}

function validateLimit(max: number, windowMs: number): void {
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_LIMIT) {
    throw new DistributedRateLimitConfigurationError(
      `Distributed rate-limit max must be an integer from 1 to ${MAX_LIMIT}`,
    );
  }
  if (
    !Number.isSafeInteger(windowMs) ||
    windowMs < MIN_WINDOW_MS ||
    windowMs > MAX_WINDOW_MS
  ) {
    throw new DistributedRateLimitConfigurationError(
      `Distributed rate-limit window must be an integer from ${MIN_WINDOW_MS} to ${MAX_WINDOW_MS} milliseconds`,
    );
  }
}

export function createDistributedRateLimitBucketKey(input: {
  config: Extract<DistributedRateLimitConfig, { enabled: true }>;
  networkIdentity: string;
  scope: string;
}): string {
  validateScope(input.scope);
  validateNetworkIdentity(input.networkIdentity);
  return createHmac("sha256", input.config.keySecret)
    .update("hyperia-distributed-rate-limit-bucket-v1\0", "utf8")
    .update(input.scope, "utf8")
    .update("\0", "utf8")
    .update(input.networkIdentity, "utf8")
    .digest("hex");
}

export async function consumeDistributedRateLimit(input: {
  bucketKey: string;
  max: number;
  pool: DistributedRateLimitPool;
  scope: string;
  windowMs: number;
}): Promise<DistributedRateLimitResult> {
  validateScope(input.scope);
  validateLimit(input.max, input.windowMs);
  if (!/^[a-f0-9]{64}$/u.test(input.bucketKey)) {
    throw new DistributedRateLimitConfigurationError(
      "Distributed rate-limit bucket key is invalid",
    );
  }

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
      [input.bucketKey],
    );

    const result = await client.query<{
      current_count: string;
      ttl_ms: string;
    }>(
      `WITH authority_time AS MATERIALIZED (
         SELECT clock_timestamp() AS now
       )
       INSERT INTO distributed_rate_limit_buckets (
         bucket_key,
         scope,
         window_ms,
         window_started_at,
         expires_at,
         request_count,
         updated_at
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
             OR distributed_rate_limit_buckets.scope <> EXCLUDED.scope
             OR distributed_rate_limit_buckets.window_ms <> EXCLUDED.window_ms
             THEN EXCLUDED.window_started_at
           ELSE distributed_rate_limit_buckets.window_started_at
         END,
         expires_at = CASE
           WHEN distributed_rate_limit_buckets.expires_at <= EXCLUDED.updated_at
             OR distributed_rate_limit_buckets.scope <> EXCLUDED.scope
             OR distributed_rate_limit_buckets.window_ms <> EXCLUDED.window_ms
             THEN EXCLUDED.expires_at
           ELSE distributed_rate_limit_buckets.expires_at
         END,
         request_count = CASE
           WHEN distributed_rate_limit_buckets.expires_at <= EXCLUDED.updated_at
             OR distributed_rate_limit_buckets.scope <> EXCLUDED.scope
             OR distributed_rate_limit_buckets.window_ms <> EXCLUDED.window_ms
             THEN 1
           ELSE distributed_rate_limit_buckets.request_count + 1
         END,
         updated_at = EXCLUDED.updated_at
       RETURNING
         request_count::text AS current_count,
         GREATEST(
           0,
           CEIL(EXTRACT(EPOCH FROM (expires_at - updated_at)) * 1000)
         )::bigint::text AS ttl_ms`,
      [input.bucketKey, input.scope, input.windowMs],
    );
    const row = result.rows[0];
    const current = Number(row?.current_count);
    const ttlMs = Number(row?.ttl_ms);
    if (
      !Number.isSafeInteger(current) ||
      current < 1 ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 0 ||
      ttlMs > input.windowMs
    ) {
      throw new Error(
        "Distributed rate-limit authority returned invalid state",
      );
    }

    await client.query(
      `DELETE FROM distributed_rate_limit_buckets
        WHERE bucket_key IN (
          SELECT bucket_key
            FROM distributed_rate_limit_buckets
           WHERE expires_at < clock_timestamp() - INTERVAL '5 minutes'
             AND bucket_key <> $1
           ORDER BY expires_at
           FOR UPDATE SKIP LOCKED
           LIMIT 32
        )`,
      [input.bucketKey],
    );
    await client.query("COMMIT");
    transactionOpen = false;

    return {
      allowed: current <= input.max,
      current,
      limit: input.max,
      retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1_000)),
      ttlMs,
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

function setRateLimitHeaders(
  reply: FastifyReply,
  result: DistributedRateLimitResult,
): void {
  reply.header("X-RateLimit-Limit", String(result.limit));
  reply.header(
    "X-RateLimit-Remaining",
    String(Math.max(0, result.limit - result.current)),
  );
  reply.header("X-RateLimit-Reset", String(result.retryAfterSeconds));
}

export function createDistributedRateLimitPreHandler(input: {
  environment?: NodeJS.ProcessEnv;
  getPool: () => DistributedRateLimitPool | null | undefined;
  max: number;
  scope: string;
  windowMs: number;
}): preHandlerHookHandler {
  const config = readDistributedRateLimitConfig(input.environment);
  validateScope(input.scope);
  validateLimit(input.max, input.windowMs);

  if (!config.enabled) {
    return async () => undefined;
  }

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const pool = input.getPool();
    if (!pool) {
      return reply.status(503).send({
        success: false,
        error: "Rate limit authority unavailable",
      });
    }

    try {
      const result = await consumeDistributedRateLimit({
        bucketKey: createDistributedRateLimitBucketKey({
          config,
          networkIdentity: request.ip,
          scope: input.scope,
        }),
        max: input.max,
        pool,
        scope: input.scope,
        windowMs: input.windowMs,
      });
      setRateLimitHeaders(reply, result);
      if (!result.allowed) {
        reply.header("Retry-After", String(result.retryAfterSeconds));
        return reply.status(429).send({
          success: false,
          error: "Too many authentication requests",
          retryAfter: result.retryAfterSeconds,
        });
      }
    } catch {
      return reply.status(503).send({
        success: false,
        error: "Rate limit authority unavailable",
      });
    }
  };
}
