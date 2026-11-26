import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  consumeDistributedRateLimit,
  createDistributedRateLimitBucketKey,
  readDistributedRateLimitConfig,
} from "../distributed-rate-limit.js";
import { assertDistributedRateLimitDatabaseAuthority } from "../../../database/client.js";

const connectionString = process.env.SOLANA_AGENT_AUTH_TEST_DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;
const config = readDistributedRateLimitConfig({
  DISTRIBUTED_RATE_LIMIT_ENABLED: "true",
  DISTRIBUTED_RATE_LIMIT_KEY_SECRET:
    "integration-limit-secret-0123456789abcdef0123456789abcdef",
  NODE_ENV: "test",
});
if (!config.enabled) throw new Error("integration limiter must be enabled");

describeWithDatabase("distributed rate-limit PostgreSQL authority", () => {
  const firstPool = new pg.Pool({ connectionString, max: 10 });
  const secondPool = new pg.Pool({ connectionString, max: 10 });
  const bucketKeys = new Set<string>();

  const makeBucketKey = (scope: string, identity: string = randomUUID()) => {
    const bucketKey = createDistributedRateLimitBucketKey({
      config,
      networkIdentity: identity,
      scope,
    });
    bucketKeys.add(bucketKey);
    return bucketKey;
  };

  afterAll(async () => {
    if (bucketKeys.size > 0) {
      await firstPool.query(
        `DELETE FROM distributed_rate_limit_buckets
          WHERE bucket_key = ANY($1::text[])`,
        [[...bucketKeys]],
      );
    }
    await Promise.all([firstPool.end(), secondPool.end()]);
  });

  it("enforces one exact limit across two replica pools", async () => {
    const bucketKey = makeBucketKey("sol-agent-verify");
    const results = [];
    for (let index = 0; index < 6; index += 1) {
      results.push(
        await consumeDistributedRateLimit({
          bucketKey,
          max: 5,
          pool: index % 2 === 0 ? firstPool : secondPool,
          scope: "sol-agent-verify",
          windowMs: 60_000,
        }),
      );
    }

    expect(results.map((result) => result.current)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results[5]).toMatchObject({ allowed: false, current: 6 });
  });

  it("serializes concurrent attempts without losing increments", async () => {
    const bucketKey = makeBucketKey("sol-agent-challenge");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        consumeDistributedRateLimit({
          bucketKey,
          max: 5,
          pool: index % 2 === 0 ? firstPool : secondPool,
          scope: "sol-agent-challenge",
          windowMs: 60_000,
        }),
      ),
    );
    const persisted = await firstPool.query<{ request_count: string }>(
      `SELECT request_count::text
         FROM distributed_rate_limit_buckets
        WHERE bucket_key = $1`,
      [bucketKey],
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(persisted.rows[0]?.request_count).toBe("20");
  });

  it("isolates scopes, resets expired windows, and stores no raw identity", async () => {
    const networkIdentity = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const verifyBucket = makeBucketKey("sol-agent-verify", networkIdentity);
    const statusBucket = makeBucketKey(
      "agent-credentials-status",
      networkIdentity,
    );
    await consumeDistributedRateLimit({
      bucketKey: verifyBucket,
      max: 5,
      pool: firstPool,
      scope: "sol-agent-verify",
      windowMs: 1_000,
    });
    const isolated = await consumeDistributedRateLimit({
      bucketKey: statusBucket,
      max: 5,
      pool: secondPool,
      scope: "agent-credentials-status",
      windowMs: 1_000,
    });
    expect(isolated.current).toBe(1);

    await firstPool.query(
      `WITH authority_time AS (SELECT clock_timestamp() AS now)
       UPDATE distributed_rate_limit_buckets bucket
          SET window_started_at = authority_time.now - INTERVAL '2 seconds',
              expires_at = authority_time.now - INTERVAL '1 second',
              updated_at = authority_time.now - INTERVAL '1 second'
         FROM authority_time
        WHERE bucket.bucket_key = $1`,
      [verifyBucket],
    );
    const reset = await consumeDistributedRateLimit({
      bucketKey: verifyBucket,
      max: 5,
      pool: secondPool,
      scope: "sol-agent-verify",
      windowMs: 1_000,
    });
    expect(reset.current).toBe(1);

    const persisted = await firstPool.query(
      `SELECT row_to_json(bucket)::text AS value
         FROM distributed_rate_limit_buckets bucket
        WHERE bucket_key = ANY($1::text[])`,
      [[verifyBucket, statusBucket]],
    );
    expect(JSON.stringify(persisted.rows)).not.toContain(networkIdentity);
  });

  it("exposes the exact startup authority and enforces every database invariant", async () => {
    await expect(
      assertDistributedRateLimitDatabaseAuthority(firstPool, {
        DISTRIBUTED_RATE_LIMIT_KEY_SECRET:
          "integration-limit-secret-0123456789abcdef0123456789abcdef",
        NODE_ENV: "production",
      }),
    ).resolves.toBeUndefined();

    const validKey = "c".repeat(64);
    const baseValues = [
      validKey,
      "sol-agent-verify",
      60_000,
      new Date("2026-08-27T12:00:00.000Z"),
      new Date("2026-08-27T12:01:00.000Z"),
      1,
      new Date("2026-08-27T12:00:01.000Z"),
    ] as const;
    const insert = (values: readonly unknown[]) =>
      firstPool.query(
        `INSERT INTO distributed_rate_limit_buckets (
           bucket_key, scope, window_ms, window_started_at,
           expires_at, request_count, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [...values],
      );

    await expect(insert(["not-a-key", ...baseValues.slice(1)])).rejects.toThrow(
      /distributed_rate_limit_bucket_key_check/u,
    );
    await expect(
      insert([validKey, "Bad Scope", ...baseValues.slice(2)]),
    ).rejects.toThrow(/distributed_rate_limit_scope_check/u);
    await expect(
      insert([
        validKey,
        baseValues[1],
        60_000,
        baseValues[3],
        new Date("2026-08-27T12:00:59.000Z"),
        baseValues[5],
        baseValues[6],
      ]),
    ).rejects.toThrow(/distributed_rate_limit_window_check/u);
    await expect(
      insert([...baseValues.slice(0, 5), 0, baseValues[6]]),
    ).rejects.toThrow(/distributed_rate_limit_count_check/u);
    await expect(
      insert([...baseValues.slice(0, 6), new Date("2026-08-27T11:59:59.000Z")]),
    ).rejects.toThrow(/distributed_rate_limit_updated_check/u);
  });

  it("fails closed when the shared database authority is unavailable", async () => {
    const outagePool = new pg.Pool({ connectionString, max: 1 });
    await outagePool.end();
    await expect(
      consumeDistributedRateLimit({
        bucketKey: makeBucketKey("agent-credentials-issue"),
        max: 5,
        pool: outagePool,
        scope: "agent-credentials-issue",
        windowMs: 60_000,
      }),
    ).rejects.toThrow();
  });
});
