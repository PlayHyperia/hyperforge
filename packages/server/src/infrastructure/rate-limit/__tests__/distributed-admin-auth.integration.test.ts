import { randomUUID } from "node:crypto";

import pg from "pg";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import { evaluateDistributedAdminCredential } from "../distributed-admin-auth.js";
import {
  createDistributedRateLimitBucketKey,
  readDistributedRateLimitConfig,
} from "../distributed-rate-limit.js";
import { registerAdminRoutes } from "../../../startup/routes/admin-routes.js";

const connectionString = process.env.SOLANA_AGENT_AUTH_TEST_DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;
const config = readDistributedRateLimitConfig({
  DISTRIBUTED_RATE_LIMIT_ENABLED: "true",
  DISTRIBUTED_RATE_LIMIT_KEY_SECRET:
    "admin-integration-secret-0123456789abcdef0123456789abcdef",
  NODE_ENV: "test",
});
if (!config.enabled)
  throw new Error("admin integration limiter must be enabled");

describeWithDatabase("distributed admin authentication authority", () => {
  const firstPool = new pg.Pool({ connectionString, max: 10 });
  const secondPool = new pg.Pool({ connectionString, max: 10 });
  const bucketKeys = new Set<string>();

  const registerIdentity = (networkIdentity: string) => {
    for (const scope of ["admin-auth-failure", "admin-auth-lockout"]) {
      bucketKeys.add(
        createDistributedRateLimitBucketKey({
          config,
          networkIdentity,
          scope,
        }),
      );
    }
    return networkIdentity;
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

  it("shares the exact five-failure lockout across replicas and blocks valid credentials until expiry", async () => {
    const networkIdentity = registerIdentity(`admin-test-${randomUUID()}`);
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await expect(
        evaluateDistributedAdminCredential({
          config,
          credentialValid: false,
          networkIdentity,
          pool: attempt % 2 === 0 ? firstPool : secondPool,
        }),
      ).resolves.toEqual({
        status: "invalid",
        remainingAttempts: 5 - attempt,
      });
    }
    await expect(
      evaluateDistributedAdminCredential({
        config,
        credentialValid: false,
        networkIdentity,
        pool: firstPool,
      }),
    ).resolves.toEqual({ status: "blocked", retryAfterSeconds: 300 });

    const validDuringLockout = await evaluateDistributedAdminCredential({
      config,
      credentialValid: true,
      networkIdentity,
      pool: secondPool,
    });
    expect(validDuringLockout.status).toBe("blocked");
    if (validDuringLockout.status === "blocked") {
      expect(validDuringLockout.retryAfterSeconds).toBeGreaterThan(0);
      expect(validDuringLockout.retryAfterSeconds).toBeLessThanOrEqual(300);
    }

    await firstPool.query(
      `WITH authority_time AS (SELECT clock_timestamp() AS now)
       UPDATE distributed_rate_limit_buckets bucket
          SET expires_at = authority_time.now - INTERVAL '1 second',
              window_started_at =
                authority_time.now - INTERVAL '1 second'
                - (bucket.window_ms * INTERVAL '1 millisecond'),
              updated_at = authority_time.now - INTERVAL '1 second'
         FROM authority_time
        WHERE bucket.bucket_key = ANY($1::text[])`,
      [[...bucketKeys]],
    );
    await expect(
      evaluateDistributedAdminCredential({
        config,
        credentialValid: true,
        networkIdentity,
        pool: firstPool,
      }),
    ).resolves.toEqual({ status: "allowed" });
  });

  it("serializes concurrent failures without extending or losing the lockout", async () => {
    const networkIdentity = registerIdentity(
      `admin-concurrent-${randomUUID()}`,
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        evaluateDistributedAdminCredential({
          config,
          credentialValid: false,
          networkIdentity,
          pool: index % 2 === 0 ? firstPool : secondPool,
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "invalid"),
    ).toHaveLength(4);
    expect(
      results.filter((result) => result.status === "blocked"),
    ).toHaveLength(6);

    const rows = await firstPool.query<{
      request_count: string;
      scope: string;
      value: string;
    }>(
      `SELECT request_count::text, scope, row_to_json(bucket)::text AS value
         FROM distributed_rate_limit_buckets bucket
        WHERE bucket_key = ANY($1::text[])
        ORDER BY scope`,
      [[...bucketKeys]],
    );
    const currentIdentityRows = rows.rows.filter((row) =>
      ["admin-auth-failure", "admin-auth-lockout"].includes(row.scope),
    );
    expect(currentIdentityRows.some((row) => row.request_count === "5")).toBe(
      true,
    );
    expect(JSON.stringify(currentIdentityRows)).not.toContain(networkIdentity);
  });

  it("does not let one network identity lock out another", async () => {
    const networkIdentity = registerIdentity(`admin-isolated-${randomUUID()}`);
    await expect(
      evaluateDistributedAdminCredential({
        config,
        credentialValid: true,
        networkIdentity,
        pool: secondPool,
      }),
    ).resolves.toEqual({ status: "allowed" });
  });

  it("enforces the shared lockout through the real Fastify admin pre-handler", async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorEnabled = process.env.DISTRIBUTED_RATE_LIMIT_ENABLED;
    const priorSecret = process.env.DISTRIBUTED_RATE_LIMIT_KEY_SECRET;
    process.env.NODE_ENV = "production";
    process.env.DISTRIBUTED_RATE_LIMIT_ENABLED = "true";
    process.env.DISTRIBUTED_RATE_LIMIT_KEY_SECRET =
      "admin-integration-secret-0123456789abcdef0123456789abcdef";
    const networkIdentity = registerIdentity("127.0.0.1");
    const app = Fastify();
    const world = {
      getSystem: (name: string) =>
        name === "database"
          ? { getPool: () => firstPool, getDb: () => null }
          : undefined,
    };

    try {
      registerAdminRoutes(
        app,
        world as never,
        { adminCode: "correct-admin-code" } as never,
      );
      for (let attempt = 1; attempt < 5; attempt += 1) {
        const response = await app.inject({
          headers: { "x-admin-code": "wrong-admin-code" },
          method: "GET",
          url: "/admin/pools/stats",
        });
        expect(response.statusCode).toBe(403);
      }
      const blocked = await app.inject({
        headers: { "x-admin-code": "wrong-admin-code" },
        method: "GET",
        url: "/admin/pools/stats",
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({
        error: "Too many failed attempts",
        retryAfter: 300,
      });
      const validWhileBlocked = await app.inject({
        headers: { "x-admin-code": "correct-admin-code" },
        method: "GET",
        url: "/admin/pools/stats",
      });
      expect(validWhileBlocked.statusCode).toBe(429);

      const persisted = await firstPool.query<{ value: string }>(
        `SELECT row_to_json(bucket)::text AS value
           FROM distributed_rate_limit_buckets bucket
          WHERE bucket_key = ANY($1::text[])`,
        [[...bucketKeys]],
      );
      expect(JSON.stringify(persisted.rows)).not.toContain(networkIdentity);
    } finally {
      await app.close();
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
      if (priorEnabled === undefined) {
        delete process.env.DISTRIBUTED_RATE_LIMIT_ENABLED;
      } else {
        process.env.DISTRIBUTED_RATE_LIMIT_ENABLED = priorEnabled;
      }
      if (priorSecret === undefined) {
        delete process.env.DISTRIBUTED_RATE_LIMIT_KEY_SECRET;
      } else {
        process.env.DISTRIBUTED_RATE_LIMIT_KEY_SECRET = priorSecret;
      }
    }
  });
});
