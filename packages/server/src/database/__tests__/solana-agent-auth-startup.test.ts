import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAgentCredentialSessionDatabaseAuthority,
  assertDistributedRateLimitDatabaseAuthority,
  assertDuelPreparationHostLeaseDatabaseAuthority,
  assertSolanaAgentAuthDatabaseAuthority,
} from "../client.js";

const enabledEnvironment = (): NodeJS.ProcessEnv => ({
  HYPERIA_SOL_AGENT_AUTH_CLUSTER: "devnet",
  HYPERIA_SOL_AGENT_AUTH_DOMAIN: "api.hyperia.test",
  HYPERIA_SOL_AGENT_AUTH_ENABLED: "true",
  HYPERIA_SOL_AGENT_AUTH_ORIGIN: "https://hyperia.test",
  HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS: "120",
});

describe("SOL agent authentication startup authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not require auth persistence while the feature is disabled", async () => {
    const query = vi.fn();
    await expect(
      assertSolanaAgentAuthDatabaseAuthority({ query } as never, {}),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("fails startup when enabled configuration is incomplete", async () => {
    await expect(
      assertSolanaAgentAuthDatabaseAuthority({ query: vi.fn() } as never, {
        HYPERIA_SOL_AGENT_AUTH_ENABLED: "true",
      }),
    ).rejects.toThrow(/HYPERIA_SOL_AGENT_AUTH_DOMAIN/u);
  });

  it("fails startup when migration 0091 authority is absent or partial", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          challenge_table: null,
          constraint_count: "0",
          immutable_trigger: false,
        },
      ],
    }));
    await expect(
      assertSolanaAgentAuthDatabaseAuthority(
        { query } as never,
        enabledEnvironment(),
      ),
    ).rejects.toThrow(/migration 0091 authority is incomplete/u);
  });

  it("accepts the exact table, enabled immutability trigger, and four constraints", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          challenge_table: "solana_agent_auth_challenges",
          constraint_count: "4",
          immutable_trigger: true,
        },
      ],
    }));
    await expect(
      assertSolanaAgentAuthDatabaseAuthority(
        { query } as never,
        enabledEnvironment(),
      ),
    ).resolves.toBeUndefined();
  });

  it("requires no session-table assertion only in a non-deployment runtime with SOL auth disabled", async () => {
    const query = vi.fn();
    await expect(
      assertAgentCredentialSessionDatabaseAuthority({ query } as never, {
        NODE_ENV: "development",
      }),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("fails production startup when migration 0092 session authority is partial", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          constraint_count: "3",
          immutable_trigger: true,
          session_table: "agent_credential_sessions",
          single_active_index: false,
        },
      ],
    }));
    await expect(
      assertAgentCredentialSessionDatabaseAuthority({ query } as never, {
        NODE_ENV: "production",
      }),
    ).rejects.toThrow(/migration 0092 authority is incomplete/u);
  });

  it("accepts the exact session table, trigger, unique active index, and four constraints", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          constraint_count: "4",
          immutable_trigger: true,
          session_table: "agent_credential_sessions",
          single_active_index: true,
        },
      ],
    }));
    await expect(
      assertAgentCredentialSessionDatabaseAuthority({ query } as never, {
        NODE_ENV: "production",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not require distributed counters outside an enabled deployment", async () => {
    const query = vi.fn();
    await expect(
      assertDistributedRateLimitDatabaseAuthority({ query } as never, {
        NODE_ENV: "test",
      }),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("fails deployment startup when migration 0093 is absent or partial", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          bucket_table: "distributed_rate_limit_buckets",
          constraint_count: "4",
          expiry_index: true,
        },
      ],
    }));
    await expect(
      assertDistributedRateLimitDatabaseAuthority({ query } as never, {
        DISTRIBUTED_RATE_LIMIT_KEY_SECRET:
          "startup-limit-secret-0123456789abcdef0123456789abcdef",
        NODE_ENV: "production",
      }),
    ).rejects.toThrow(/migration 0093 authority is incomplete/u);
  });

  it("accepts the exact migration 0093 table, constraints, and expiry index", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          bucket_table: "distributed_rate_limit_buckets",
          constraint_count: "5",
          expiry_index: true,
        },
      ],
    }));
    await expect(
      assertDistributedRateLimitDatabaseAuthority({ query } as never, {
        DISTRIBUTED_RATE_LIMIT_KEY_SECRET:
          "startup-limit-secret-0123456789abcdef0123456789abcdef",
        NODE_ENV: "production",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not require the host-lease table when private preparation is disabled", async () => {
    const query = vi.fn();
    await expect(
      assertDuelPreparationHostLeaseDatabaseAuthority({ query } as never, {}),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("fails startup when enabled private preparation lacks migration 0098 authority", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          lease_table: "streaming_duel_preparation_agent_host_leases",
          constraint_count: "4",
          expiry_index: true,
          required_trigger_count: "2",
        },
      ],
    }));
    await expect(
      assertDuelPreparationHostLeaseDatabaseAuthority({ query } as never, {
        STREAMING_DUEL_PREPARATION_MS: "60000",
      }),
    ).rejects.toThrow(/migration 0098 host-lease authority is incomplete/u);
  });

  it("accepts the exact migration 0098 table, constraints, triggers, and expiry index", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          lease_table: "streaming_duel_preparation_agent_host_leases",
          constraint_count: "4",
          expiry_index: true,
          required_trigger_count: "3",
        },
      ],
    }));
    await expect(
      assertDuelPreparationHostLeaseDatabaseAuthority({ query } as never, {
        STREAMING_DUEL_PREPARATION_MS: "60000",
      }),
    ).resolves.toBeUndefined();
  });
});
