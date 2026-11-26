import { describe, expect, it, vi } from "vitest";

import {
  consumeDistributedRateLimit,
  createDistributedRateLimitBucketKey,
  createDistributedRateLimitPreHandler,
  readDistributedRateLimitConfig,
} from "../distributed-rate-limit.js";

const SECRET = "distributed-limit-secret-0123456789abcdef0123456789abcdef";

function enabledConfig() {
  return readDistributedRateLimitConfig({
    DISTRIBUTED_RATE_LIMIT_ENABLED: "true",
    DISTRIBUTED_RATE_LIMIT_KEY_SECRET: SECRET,
    NODE_ENV: "test",
  });
}

function createClient(current = 1, ttlMs = 60_000) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("RETURNING")) {
      return {
        rows: [{ current_count: String(current), ttl_ms: String(ttlMs) }],
      };
    }
    return { rows: [] };
  });
  return { query, release: vi.fn() };
}

function createReplyRecorder() {
  return {
    headers: {} as Record<string, string>,
    payload: undefined as unknown,
    statusCode: 200,
    header(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}

describe("distributed authentication rate-limit authority", () => {
  it("is optional locally and mandatory with a strong key in deployment environments", () => {
    expect(readDistributedRateLimitConfig({ NODE_ENV: "test" })).toEqual({
      enabled: false,
    });
    expect(() =>
      readDistributedRateLimitConfig({ NODE_ENV: "production" }),
    ).toThrow(/DISTRIBUTED_RATE_LIMIT_KEY_SECRET is required/u);
    expect(() =>
      readDistributedRateLimitConfig({
        DISTRIBUTED_RATE_LIMIT_ENABLED: "false",
        NODE_ENV: "staging",
      }),
    ).toThrow(/cannot disable/u);
    expect(() =>
      readDistributedRateLimitConfig({
        DISTRIBUTED_RATE_LIMIT_ENABLED: "perhaps",
        NODE_ENV: "test",
      }),
    ).toThrow(/explicit boolean/u);
    expect(() =>
      readDistributedRateLimitConfig({
        DISTRIBUTED_RATE_LIMIT_ENABLED: "true",
        DISTRIBUTED_RATE_LIMIT_KEY_SECRET: "too-short",
        NODE_ENV: "test",
      }),
    ).toThrow(/at least 32 bytes/u);
    expect(() =>
      readDistributedRateLimitConfig({
        DISTRIBUTED_RATE_LIMIT_ENABLED: "true",
        DISTRIBUTED_RATE_LIMIT_KEY_SECRET: ` ${SECRET}`,
        NODE_ENV: "test",
      }),
    ).toThrow(/outer whitespace/u);
  });

  it("produces stable isolated HMAC buckets without exposing the network identity", () => {
    const config = enabledConfig();
    expect(config.enabled).toBe(true);
    if (!config.enabled) throw new Error("expected enabled config");

    const first = createDistributedRateLimitBucketKey({
      config,
      networkIdentity: "203.0.113.10",
      scope: "sol-agent-verify",
    });
    const repeated = createDistributedRateLimitBucketKey({
      config,
      networkIdentity: "203.0.113.10",
      scope: "sol-agent-verify",
    });
    const otherScope = createDistributedRateLimitBucketKey({
      config,
      networkIdentity: "203.0.113.10",
      scope: "sol-agent-challenge",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).toBe(repeated);
    expect(first).not.toBe(otherScope);
    expect(first).not.toContain("203.0.113.10");
    expect(config.keyFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(JSON.stringify(config.keyFingerprint)).not.toContain(SECRET);
  });

  it("commits one shared counter result and always releases its client", async () => {
    const client = createClient(5, 42_001);
    const pool = { connect: vi.fn(async () => client) };
    const result = await consumeDistributedRateLimit({
      bucketKey: "a".repeat(64),
      max: 5,
      pool: pool as never,
      scope: "agent-credentials-status",
      windowMs: 60_000,
    });

    expect(result).toEqual({
      allowed: true,
      current: 5,
      limit: 5,
      retryAfterSeconds: 43,
      ttlMs: 42_001,
    });
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases on authority failure", async () => {
    const client = createClient();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("database unavailable"));
    const pool = { connect: vi.fn(async () => client) };

    await expect(
      consumeDistributedRateLimit({
        bucketKey: "b".repeat(64),
        max: 5,
        pool: pool as never,
        scope: "sol-agent-challenge",
        windowMs: 60_000,
      }),
    ).rejects.toThrow("database unavailable");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns a bounded 429 after the shared limit and never runs uncounted on outage", async () => {
    const overLimitClient = createClient(6, 12_001);
    const preHandler = createDistributedRateLimitPreHandler({
      environment: {
        DISTRIBUTED_RATE_LIMIT_ENABLED: "true",
        DISTRIBUTED_RATE_LIMIT_KEY_SECRET: SECRET,
        NODE_ENV: "test",
      },
      getPool: () =>
        ({
          connect: vi.fn(async () => overLimitClient),
        }) as never,
      max: 5,
      scope: "sol-agent-verify",
      windowMs: 60_000,
    });
    const reply = createReplyRecorder();
    await preHandler.call(
      {} as never,
      { ip: "203.0.113.10" } as never,
      reply as never,
      vi.fn(),
    );

    expect(reply.statusCode).toBe(429);
    expect(reply.headers).toMatchObject({
      "Retry-After": "13",
      "X-RateLimit-Limit": "5",
      "X-RateLimit-Remaining": "0",
    });
    expect(reply.payload).toEqual({
      success: false,
      error: "Too many authentication requests",
      retryAfter: 13,
    });

    const unavailable = createDistributedRateLimitPreHandler({
      environment: {
        DISTRIBUTED_RATE_LIMIT_ENABLED: "true",
        DISTRIBUTED_RATE_LIMIT_KEY_SECRET: SECRET,
        NODE_ENV: "test",
      },
      getPool: () => null,
      max: 5,
      scope: "sol-agent-verify",
      windowMs: 60_000,
    });
    const unavailableReply = createReplyRecorder();
    await unavailable.call(
      {} as never,
      { ip: "203.0.113.10" } as never,
      unavailableReply as never,
      vi.fn(),
    );
    expect(unavailableReply.statusCode).toBe(503);
    expect(unavailableReply.payload).toEqual({
      success: false,
      error: "Rate limit authority unavailable",
    });
  });
});
