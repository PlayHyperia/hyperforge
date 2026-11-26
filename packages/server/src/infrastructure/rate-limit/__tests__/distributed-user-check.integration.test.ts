import pg from "pg";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import {
  createDistributedRateLimitBucketKey,
  readDistributedRateLimitConfig,
} from "../distributed-rate-limit.js";
import { registerUserRoutes } from "../../../startup/routes/user-routes.js";

const connectionString = process.env.SOLANA_AGENT_AUTH_TEST_DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;
const secret = "user-check-secret-0123456789abcdef0123456789abcdef";
const config = readDistributedRateLimitConfig({
  DISTRIBUTED_RATE_LIMIT_ENABLED: "true",
  DISTRIBUTED_RATE_LIMIT_KEY_SECRET: secret,
  NODE_ENV: "test",
});
if (!config.enabled)
  throw new Error("user-check integration limiter must be enabled");

describeWithDatabase("distributed user-enumeration route authority", () => {
  const pool = new pg.Pool({ connectionString, max: 8 });
  const bucketKey = createDistributedRateLimitBucketKey({
    config,
    networkIdentity: "127.0.0.1",
    scope: "user-existence-check",
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM distributed_rate_limit_buckets WHERE bucket_key = $1`,
      [bucketKey],
    );
    await pool.end();
  });

  it("counts the real route across two Fastify replicas and rejects request 31", async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorEnabled = process.env.DISTRIBUTED_RATE_LIMIT_ENABLED;
    const priorSecret = process.env.DISTRIBUTED_RATE_LIMIT_KEY_SECRET;
    process.env.NODE_ENV = "production";
    process.env.DISTRIBUTED_RATE_LIMIT_ENABLED = "true";
    process.env.DISTRIBUTED_RATE_LIMIT_KEY_SECRET = secret;
    const firstApp = Fastify();
    const secondApp = Fastify();
    const databaseSystem = {
      getDb: () => null,
      getPool: () => pool,
    };
    const world = {
      getSystem: (name: string) =>
        name === "database" ? databaseSystem : undefined,
    };

    try {
      registerUserRoutes(firstApp, world as never);
      registerUserRoutes(secondApp, world as never);
      for (let requestNumber = 1; requestNumber <= 30; requestNumber += 1) {
        const app = requestNumber % 2 === 0 ? firstApp : secondApp;
        const response = await app.inject({
          method: "GET",
          url: "/api/users/check",
        });
        expect(response.statusCode).toBe(400);
      }
      const rejected = await secondApp.inject({
        method: "GET",
        url: "/api/users/check",
      });
      expect(rejected.statusCode).toBe(429);
      expect(rejected.json()).toMatchObject({
        error: "Too many authentication requests",
        success: false,
      });

      const persisted = await pool.query<{
        request_count: string;
        scope: string;
      }>(
        `SELECT request_count::text, scope
           FROM distributed_rate_limit_buckets
          WHERE bucket_key = $1`,
        [bucketKey],
      );
      expect(persisted.rows[0]).toEqual({
        request_count: "31",
        scope: "user-existence-check",
      });
    } finally {
      await Promise.all([firstApp.close(), secondApp.close()]);
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
