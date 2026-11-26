import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as schema from "../../../database/schema.js";
import {
  DEFAULT_DUEL_PREPARATION_HOST_CLAIM_GRACE_MS,
  DEFAULT_DUEL_PREPARATION_HOST_HEARTBEAT_MS,
  DEFAULT_DUEL_PREPARATION_HOST_LEASE_MS,
  resolveDuelPreparationHostLeaseConfig,
} from "../preparation-host-lease.js";

describe("duel preparation host lease configuration", () => {
  it("ships the exact lease table, non-revival trigger, and expiry index", () => {
    const migration = readFileSync(
      new URL(
        "../../../database/migrations/0098_add_duel_preparation_agent_host_leases.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const buildIdentityMigration = readFileSync(
      new URL(
        "../../../database/migrations/0103_bind_duel_preparation_host_executable_build.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(schema.streamingDuelPreparationAgentHostLeases).toBeDefined();
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "streaming_duel_preparation_agent_host_leases"',
    );
    expect(migration).toContain(
      "expired duel preparation host lease cannot be revived",
    );
    expect(migration).toContain(
      "duel preparation host leases are retained for audit",
    );
    expect(migration).toContain(
      "idx_streaming_duel_preparation_agent_host_leases_expiry",
    );
    expect(buildIdentityMigration).toContain(
      'ADD COLUMN IF NOT EXISTS "executableBuildId" text',
    );
    expect(buildIdentityMigration).toContain(
      "duel preparation host executable build identity is immutable",
    );
    expect(buildIdentityMigration).toContain("^[0-9a-f]{64}$");
  });

  it("uses one bounded technical default envelope", () => {
    expect(resolveDuelPreparationHostLeaseConfig({})).toEqual({
      leaseMs: DEFAULT_DUEL_PREPARATION_HOST_LEASE_MS,
      heartbeatMs: DEFAULT_DUEL_PREPARATION_HOST_HEARTBEAT_MS,
      claimGraceMs: DEFAULT_DUEL_PREPARATION_HOST_CLAIM_GRACE_MS,
    });
  });

  it("accepts an explicit coherent envelope", () => {
    expect(
      resolveDuelPreparationHostLeaseConfig({
        DUEL_PREPARATION_AGENT_HOST_LEASE_MS: "30000",
        DUEL_PREPARATION_AGENT_HOST_HEARTBEAT_MS: "5000",
        DUEL_PREPARATION_AGENT_HOST_CLAIM_GRACE_MS: "12000",
      }),
    ).toEqual({ leaseMs: 30_000, heartbeatMs: 5_000, claimGraceMs: 12_000 });
  });

  it.each([
    [{ DUEL_PREPARATION_AGENT_HOST_LEASE_MS: "4999" }, /between/u],
    [{ DUEL_PREPARATION_AGENT_HOST_LEASE_MS: "60001" }, /between/u],
    [{ DUEL_PREPARATION_AGENT_HOST_HEARTBEAT_MS: "999" }, /at least/u],
    [{ DUEL_PREPARATION_AGENT_HOST_HEARTBEAT_MS: "5001" }, /one third/u],
    [{ DUEL_PREPARATION_AGENT_HOST_CLAIM_GRACE_MS: "15001" }, /no greater/u],
    [{ DUEL_PREPARATION_AGENT_HOST_LEASE_MS: "1.5" }, /positive integer/u],
  ] as const)("rejects an unsafe envelope %#", (env, message) => {
    expect(() => resolveDuelPreparationHostLeaseConfig(env)).toThrow(message);
  });
});
