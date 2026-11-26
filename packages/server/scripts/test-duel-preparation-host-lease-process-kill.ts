import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  DUEL_PREPARATION_BANK_ACTIONS,
  PostgresDuelPreparationStore,
} from "../src/systems/StreamingDuelScheduler/preparation.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "../src/systems/StreamingDuelScheduler/competitive-tactical-strategy.js";

const { Pool } = pg;
const DATABASE_URL_ENV =
  "DUEL_PREPARATION_HOST_LEASE_TEST_DATABASE_URL" as const;
const CHILD_MODE_ENV = "DUEL_PREPARATION_HOST_LEASE_CHILD_MODE" as const;
const PREPARATION_ID_ENV =
  "DUEL_PREPARATION_HOST_LEASE_PREPARATION_ID" as const;
const AGENT_ID_ENV = "DUEL_PREPARATION_HOST_LEASE_AGENT_ID" as const;
const OWNER_ID_ENV = "DUEL_PREPARATION_HOST_LEASE_OWNER_ID" as const;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const planEvidence = (agentId: string) => ({
  primaryStyle: "melee" as const,
  availableStyles: ["melee" as const],
  planningSource: "deterministic" as const,
  planningPolicyVersion: "host-lease-process-kill-v1",
  agentPolicyFingerprint: "ab".repeat(32),
  modelProvider: "process-kill-test",
  model: agentId,
  tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy("melee"),
});

async function runLeaseHostChild(): Promise<void> {
  const connectionString = requireEnv(DATABASE_URL_ENV);
  const preparationId = requireEnv(PREPARATION_ID_ENV);
  const agentId = requireEnv(AGENT_ID_ENV);
  const ownerId = requireEnv(OWNER_ID_ENV);
  const pool = new Pool({ connectionString, max: 2 });
  try {
    const store = new PostgresDuelPreparationStore(pool);
    const input = {
      preparationId,
      agentId,
      ownerId,
      leaseDurationMs: 5_000,
    };
    const claimed = await store.claimContestantHostLease(input);
    assert(claimed, "child could not claim its contestant host lease");
    const active = await store.heartbeatContestantHostLease(input);
    assert(active, "child could not establish its contestant heartbeat");
    process.stdout.write(
      `${JSON.stringify({ type: "lease_ready", ...active })}\n`,
    );
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const heartbeat = await store.heartbeatContestantHostLease(input);
      assert(heartbeat, "child lost its contestant host lease before kill");
    }
  } finally {
    await pool.end();
  }
}

function spawnLeaseHost(input: {
  connectionString: string;
  preparationId: string;
  agentId: string;
  ownerId: string;
}): ChildProcess {
  return spawn(process.execPath, [SCRIPT_PATH], {
    env: {
      ...process.env,
      [DATABASE_URL_ENV]: input.connectionString,
      [CHILD_MODE_ENV]: "lease-host",
      [PREPARATION_ID_ENV]: input.preparationId,
      [AGENT_ID_ENV]: input.agentId,
      [OWNER_ID_ENV]: input.ownerId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForLeaseReady(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ expiresAt: number }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for lease host: ${stderr.trim()}`));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(stdout.slice(0, newline)) as {
          type?: string;
          expiresAt?: number;
        };
        assert(
          parsed.type === "lease_ready" &&
            Number.isSafeInteger(parsed.expiresAt),
          `invalid lease-host readiness: ${stdout.slice(0, newline)}`,
        );
        resolve({ expiresAt: parsed.expiresAt! });
      } catch (error) {
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `lease host exited before readiness: code=${code} signal=${signal} stderr=${stderr.trim()}`,
        ),
      );
    });
  });
}

async function waitForExpiredLeaseReport(
  store: PostgresDuelPreparationStore,
  preparationId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const report = await store.reportExpiredContestantHostLease({
      preparationId,
      claimGraceMs: 1_000,
    });
    if (report) return report;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for expired host-lease report");
}

async function runParent(): Promise<void> {
  const connectionString = requireEnv(DATABASE_URL_ENV);
  const pool = new Pool({ connectionString, max: 5 });
  const store = new PostgresDuelPreparationStore(pool);
  const runId = randomUUID();
  const preparationId = randomUUID();
  const agent1Id = `host-lease-alpha-${runId}`;
  const agent2Id = `host-lease-beta-${runId}`;
  const account1Id = `host-lease-account-alpha-${runId}`;
  const account2Id = `host-lease-account-beta-${runId}`;
  const fencingToken = "798";
  const killedOwnerId = randomUUID();
  const survivingOwnerId = randomUUID();
  let leaseHost: ChildProcess | null = null;
  try {
    await pool.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, 'Host Lease Alpha', '[]', '2026-08-30T00:00:00.000Z'),
              ($2, 'Host Lease Beta', '[]', '2026-08-30T00:00:00.000Z')`,
      [account1Id, account2Id],
    );
    await pool.query(
      `INSERT INTO characters (id, "accountId", name)
       VALUES ($1, $3, 'Host Lease Alpha'),
              ($2, $4, 'Host Lease Beta')`,
      [agent1Id, agent2Id, account1Id, account2Id],
    );
    await pool.query(
      `INSERT INTO agent_mappings (
         agent_id, account_id, character_id, agent_name,
         streaming_duel_enabled, created_at, updated_at
       ) VALUES
         ($1, $3, $1, 'Host Lease Alpha', true, NOW(), NOW()),
         ($2, $4, $2, 'Host Lease Beta', true, NOW(), NOW())`,
      [agent1Id, agent2Id, account1Id, account2Id],
    );

    await store.create({
      preparationId,
      fencingToken,
      agent1Id,
      agent2Id,
      diagnostic: false,
      durationMs: 60_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    const survivorLease = await store.claimContestantHostLease({
      preparationId,
      agentId: agent2Id,
      ownerId: survivingOwnerId,
      leaseDurationMs: 60_000,
    });
    assert(survivorLease, "surviving host lease was not claimed");

    leaseHost = spawnLeaseHost({
      connectionString,
      preparationId,
      agentId: agent1Id,
      ownerId: killedOwnerId,
    });
    const childLease = await waitForLeaseReady(leaseHost, 10_000);
    const firstReady = await store.markReady({
      preparationId,
      fencingToken,
      agentId: agent1Id,
      planEvidence: planEvidence(agent1Id),
    });
    assert(
      firstReady?.agent1ReadyAt !== null && firstReady?.status === "preparing",
      "leased contestant did not reach first readiness",
    );
    assert(
      (
        await store.authorizeBankAccess({
          preparationId,
          playerId: agent2Id,
          action: "open",
        })
      ).ok,
      "surviving contestant lost bank access before process kill",
    );

    assert(leaseHost.kill("SIGKILL"), "could not SIGKILL lease host");
    const killedExit = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      leaseHost!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert(killedExit.signal === "SIGKILL", "lease host was not hard-killed");
    leaseHost = null;

    const report = await waitForExpiredLeaseReport(
      store,
      preparationId,
      12_000,
    );
    assert(
      report.agentId === agent1Id && report.reason === "agent_unavailable",
      "expired lease did not become the exact contestant-unavailability report",
    );
    assert(
      report.reportedAt >= childLease.expiresAt,
      "host was reported unavailable before its last committed lease expired",
    );
    assert(
      (await store.claimContestantHostLease({
        preparationId,
        agentId: agent1Id,
        ownerId: randomUUID(),
        leaseDurationMs: 5_000,
      })) === null,
      "replacement host stole an expired private capability",
    );
    assert(
      (await store.heartbeatContestantHostLease({
        preparationId,
        agentId: agent1Id,
        ownerId: killedOwnerId,
        leaseDurationMs: 5_000,
      })) === null,
      "killed host revived its expired lease",
    );
    assert(
      !(
        await store.authorizeBankAccess({
          preparationId,
          playerId: agent2Id,
          action: "open",
        })
      ).ok,
      "private bank access survived expired-host fencing",
    );
    assert(
      (await store.markReady({
        preparationId,
        fencingToken,
        agentId: agent2Id,
        planEvidence: planEvidence(agent2Id),
      })) === null,
      "second readiness survived expired-host fencing",
    );
    assert(
      (await store.freeze({ preparationId, fencingToken })) === null,
      "private preparation froze after host loss",
    );

    const cancelled = await store.cancel({
      preparationId,
      fencingToken,
      reason: "agent_preparation_failed",
    });
    assert(
      cancelled?.status === "cancelled" && cancelled.version === 4,
      "scheduler cancellation did not preserve the lease/report fence",
    );
    const final = await pool.query<{
      hostLeaseCount: string;
      reportCount: string;
      snapshotCount: string;
    }>(
      `SELECT
         (SELECT count(*)::text
            FROM streaming_duel_preparation_agent_host_leases
           WHERE "preparationId" = $1) AS "hostLeaseCount",
         (SELECT count(*)::text
            FROM streaming_duel_preparation_unavailability_reports
           WHERE "preparationId" = $1) AS "reportCount",
         (SELECT count(*)::text
            FROM streaming_duel_competitive_snapshots
           WHERE "preparationId" = $1) AS "snapshotCount"`,
      [preparationId],
    );
    assert(
      final.rows[0]?.hostLeaseCount === "2" &&
        final.rows[0]?.reportCount === "1" &&
        final.rows[0]?.snapshotCount === "0",
      "final lease/report/snapshot graph diverged",
    );

    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        preparationId,
        processLoss: {
          signal: killedExit.signal,
          killedAfterReadiness: true,
          lastLeaseExpiresAt: childLease.expiresAt,
        },
        report,
        fences: {
          replacementClaimRejected: true,
          expiredOwnerHeartbeatRejected: true,
          bankAccessRejected: true,
          readinessRejected: true,
          freezeRejected: true,
          competitiveSnapshotCount: Number(final.rows[0].snapshotCount),
        },
        terminal: {
          status: cancelled.status,
          cancellationReason: cancelled.cancellationReason,
          preparationVersion: cancelled.version,
        },
      })}\n`,
    );
  } finally {
    if (leaseHost && !leaseHost.killed) leaseHost.kill("SIGKILL");
    await pool.end();
  }
}

if (process.env[CHILD_MODE_ENV] === "lease-host") {
  await runLeaseHostChild();
} else {
  await runParent();
}
