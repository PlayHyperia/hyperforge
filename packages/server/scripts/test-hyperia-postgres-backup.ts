import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import {
  createHyperiaPostgresBackup,
  HYPERIA_RECOVERY_TABLES,
  type HyperiaPostgresBackupTooling,
  type HyperiaPostgresRecoveryInspection,
  inspectHyperiaPostgresRecoveryState,
  verifyHyperiaPostgresBackup,
  verifyHyperiaPostgresRestore,
} from "../src/database/hyperia-postgres-backup.js";
import { runHyperiaPostgresBackupCli } from "../src/database/hyperia-postgres-backup-cli.js";
import { runHyperiaPostgresRestoreEvidenceCli } from "../src/database/hyperia-postgres-restore-evidence-cli.js";
import { runHyperiaRestoredDuelApplicationReadinessCli } from "../src/database/hyperia-restored-duel-application-readiness-cli.js";
import { inspectHyperiaRestoredDuelApplication } from "../src/database/hyperia-restored-duel-application-readiness.js";
import { createPostgresClientDatabase } from "../src/database/postgres-transaction.js";
import { BETTING_SOURCE_EPOCH_STORAGE_KEY } from "../src/routes/streaming-betting-feed.js";

const { Client, Pool } = pg;

const COMMAND_OUTPUT_LIMIT = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 180_000;
const DATABASE_READY_TIMEOUT_MS = 60_000;
const BACKUP_TIMEOUT_MS = 120_000;
const TEST_DATABASE = "hyperia_backup_test";
const TEST_USER = "hyperia_backup_test";
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MANAGED_PG_ENVIRONMENT = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSFILE",
  "PGSSLMODE",
  "PGPASSWORD",
  "DATABASE_URL",
  "POSTGRES_URL",
  "PGSERVICE",
  "PGOPTIONS",
] as const;

type ManagedPgEnvironmentName = (typeof MANAGED_PG_ENVIRONMENT)[number];

type TestEvidence = {
  schemaVersion: 1;
  createdAt: string;
  sourceState: "dirty_worktree_test_only";
  postgresImage: "postgres:16-alpine";
  releaseSha: string;
  boundaryId: string;
  backupId: string;
  backupSha256: string;
  backupBytes: number;
  tocSha256: string;
  tocEntries: number;
  schemaSha256: string;
  sourceMigrationCount: number;
  sourceLatestMigrationTag: string;
  recoveryTableCount: number;
  restoredRecoveryTableCountsSha256: string;
  restoredRecoveryTableSha256sSha256: string;
  restoreVerificationId: string;
  restoreEvidenceSha256: string;
  applicationReadinessId: string;
  applicationReadinessSha256: string;
  applicationRecentDuelCount: number;
  applicationProjectedCompetitiveDuelCount: number;
  applicationProjectedCompetitiveDuelStateSha256: string;
  restoredApplicationHistoryReadCompatible: true;
  restoredServerStartupCompatible: true;
  restoredServerStatusCode: 200;
  restoredServerHealthCode: 200;
  restoredServerStreamingStateCode: 200;
  restoredServerStreamingHealthCode: 503;
  restoredServerPublicHistoryDuelCount: 1;
  restoredServerExpectedMutationTables: readonly [
    "storage",
    "streaming_scheduler_leases",
  ];
  restoredServerSourceEpochAdvancedExactlyOnce: true;
  restoredServerGracefulExitCode: 0;
  restoredServerNodeVersion: "v22.23.2";
  restoredServerBundleSha256: string;
  restoredServerLogSha256: string;
  seededStorageValueRecovered: true;
  seededLeaseRecovered: true;
  seededTerminalDuelRecovered: true;
  negativeCases: readonly string[];
};

const RECOVERY_DUEL_FIXTURE = {
  preparationId: "11111111-1111-4111-a111-111111111111",
  cycleId: "recovery-cycle-1",
  duelId: "streaming-recovery-cycle-1",
  duelKey: "ab".repeat(32),
  agent1Id: "recovery-agent-alpha",
  agent2Id: "recovery-agent-beta",
  frozenAt: 1_800_000_000_000,
  terminalAt: 1_800_000_120_000,
} as const;
const RECOVERY_BETTING_SOURCE_EPOCH = 1_800_000_000_000;

function canonicalFixtureJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function recoveryContestant(side: "agent1" | "agent2") {
  const agentId =
    side === "agent1"
      ? RECOVERY_DUEL_FIXTURE.agent1Id
      : RECOVERY_DUEL_FIXTURE.agent2Id;
  const fingerprint = side === "agent1" ? "11".repeat(32) : "22".repeat(32);
  return {
    side,
    agentId,
    name: side === "agent1" ? "Recovery Alpha" : "Recovery Beta",
    provider: "recovery-test-provider",
    model: `${agentId}-model`,
    combatLevel: 42,
    startingHp: 30,
    maxHp: 30,
    wins: side === "agent1" ? 10 : 8,
    losses: side === "agent1" ? 5 : 7,
    rank: side === "agent1" ? 1 : 2,
    headToHeadWins: side === "agent1" ? 2 : 1,
    headToHeadLosses: side === "agent1" ? 1 : 2,
    loadoutFingerprint: fingerprint,
    equipment: [{ slot: "weapon", itemId: "iron_sword", quantity: 1 }],
    inventory: [{ slot: 0, itemId: "shark", quantity: 2 }],
    selectedSpell: null,
    skillLevels: [
      { skill: "attack", level: 40 },
      { skill: "strength", level: 40 },
    ],
    prayer: {
      pointUnits: 10_000_000,
      points: 10,
      maxPoints: 10,
      activePrayers: [],
    },
    initialCombatStyle: "melee",
    availableCombatStyles: ["melee"],
    combatLoadouts: {
      melee: {
        role: "melee",
        weaponId: "iron_sword",
        arrowsId: null,
        shieldId: null,
        spellId: null,
        armorIds: {
          helmet: null,
          body: null,
          legs: null,
          boots: null,
          gloves: null,
          cape: null,
          amulet: null,
          ring: null,
        },
      },
    },
    preparation: {
      primaryStyle: "melee",
      availableStyles: ["melee"],
      planningSource: "deterministic",
      planningPolicyVersion: "recovery-test-policy-v1",
      agentPolicyFingerprint: fingerprint,
      modelProvider: "recovery-test-provider",
      model: `${agentId}-model`,
      tacticalStrategy: {
        approach: "balanced",
        tacticalMacro: "pressure",
        attackStyle: "aggressive",
        prayer: "superhuman_strength",
        preferredCombatRole: null,
        foodThreshold: 40,
        switchDefensiveAt: 30,
        reasoning: "Use the deterministic role-aware competitive fallback.",
      },
    },
  };
}

async function seedRecoveryDuel(pool: pg.Pool): Promise<void> {
  const fixture = RECOVERY_DUEL_FIXTURE;
  const snapshot = {
    snapshotVersion: 3,
    persisted: true,
    diagnostic: false,
    preparationId: fixture.preparationId,
    cycleId: fixture.cycleId,
    duelId: fixture.duelId,
    duelKey: fixture.duelKey,
    frozenAt: fixture.frozenAt,
    betOpenTime: fixture.frozenAt,
    betCloseTime: fixture.frozenAt + 60_000,
    combatPolicyVersion: "duel-combat-policy-v2",
    contestants: [recoveryContestant("agent1"), recoveryContestant("agent2")],
  };
  const snapshotDigest = createHash("sha256")
    .update(canonicalFixtureJson(snapshot))
    .digest("hex");
  await pool.query(
    `INSERT INTO "users" ("id", "name", "roles", "createdAt")
     VALUES
       ('recovery-account-alpha', 'Recovery Alpha', 'agent', 'recovery-fixture'),
       ('recovery-account-beta', 'Recovery Beta', 'agent', 'recovery-fixture')`,
  );
  await pool.query(
    `INSERT INTO "characters" ("id", "accountId", "name")
     VALUES
       ($1, 'recovery-account-alpha', 'Recovery Alpha'),
       ($2, 'recovery-account-beta', 'Recovery Beta')`,
    [fixture.agent1Id, fixture.agent2Id],
  );
  await pool.query(
    `INSERT INTO "streaming_duel_preparations" (
       "preparationId", "fencingToken", "agent1Id", "agent2Id",
       "allowedBankActions", "status", "selectedAt", "expiresAt",
       "agent1ReadyAt", "agent2ReadyAt", "frozenAt", "version"
     ) VALUES ($1, 11, $2, $3, ARRAY['open', 'deposit', 'withdraw']::text[],
       'frozen', $4, $5, $6, $6, $6, 4)`,
    [
      fixture.preparationId,
      fixture.agent1Id,
      fixture.agent2Id,
      fixture.frozenAt - 120_000,
      fixture.frozenAt + 300_000,
      fixture.frozenAt,
    ],
  );
  await pool.query(
    `INSERT INTO "streaming_duel_competitive_snapshots" (
       "preparationId", "snapshotVersion", "cycleId", "duelId", "duelKey",
       "snapshotDigest", "snapshot", "frozenAt", "lifecycleStatus",
       "terminalOutcome", "terminalWinnerId", "terminalWinReason",
       "terminalCancellationReason", "terminalSeed", "terminalReplayHash",
       "terminalAt", "lockedAt", "duelStartedAt", "recoveredAt"
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'terminal',
       'win', $9, 'kill', NULL, '42', $10, $11, $12, $13, NULL
     )`,
    [
      fixture.preparationId,
      snapshot.snapshotVersion,
      fixture.cycleId,
      fixture.duelId,
      fixture.duelKey,
      snapshotDigest,
      JSON.stringify(snapshot),
      fixture.frozenAt,
      fixture.agent1Id,
      "33".repeat(32),
      fixture.terminalAt,
      snapshot.betCloseTime,
      snapshot.betCloseTime + 1_000,
    ],
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type RestoredServerStartupResult = {
  statusCode: 200;
  healthCode: 200;
  streamingStateCode: 200;
  streamingHealthCode: 503;
  publicHistoryDuelCount: 1;
  gracefulExitCode: 0;
  nodeVersion: "v22.23.2";
  bundleSha256: string;
  logSha256: string;
};

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("reserved port is invalid")));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function sanitizeServerDiagnostic(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/giu, "postgresql://[redacted]@")
    .replace(/(password\s*[=:]\s*)\S+/giu, "$1[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim()
    .slice(-8_192);
}

async function runRestoredServerStartup(input: {
  port: number;
  databaseName: string;
  databasePort: number;
  password: string;
  leaseName: string;
}): Promise<RestoredServerStartupResult> {
  const serverPackageRoot = path.resolve(import.meta.dirname, "..");
  await runCommand(
    process.execPath,
    ["run", "--cwd", serverPackageRoot, "build"],
    300_000,
  );
  const serverBundle = readFileSync(
    path.join(serverPackageRoot, "dist/index.js"),
  );
  assert(serverBundle.byteLength > 0, "restored server bundle is empty");
  const bundleSha256 = createHash("sha256").update(serverBundle).digest("hex");
  const workspacePinnedNode = path.resolve(
    serverPackageRoot,
    "../../../.toolchains/node-v22.23.2/node-v22.23.2-darwin-arm64/bin/node",
  );
  const nodeExecutable =
    process.env.HYPERIA_NODE_EXECUTABLE?.trim() ||
    (existsSync(workspacePinnedNode) ? workspacePinnedNode : "node");
  const nodeVersion = (
    await runCommand(nodeExecutable, ["--version"], 10_000)
  ).trim();
  assert(
    nodeVersion === "v22.23.2",
    `restored server startup requires Node v22.23.2, received ${nodeVersion}`,
  );
  const jwtSigningSecret = createHash("sha512")
    .update(`restored-server-startup:${randomUUID()}`)
    .digest("hex");
  const jwtSigningKeyId = "recovery-active";
  const jwtSigningFingerprint = createHash("sha256")
    .update(jwtSigningSecret, "utf8")
    .digest("hex")
    .slice(0, 16);
  const distributedRateLimitSecret = createHash("sha512")
    .update(`restored-rate-limit:${randomUUID()}`)
    .digest("hex");
  const distributedRateLimitFingerprint = createHash("sha256")
    .update("hyperia-distributed-rate-limit-key-v1\0", "utf8")
    .update(distributedRateLimitSecret, "utf8")
    .digest("hex")
    .slice(0, 16);
  const databaseUrl = `postgresql://${TEST_USER}:${encodeURIComponent(input.password)}@127.0.0.1:${input.databasePort}/${input.databaseName}`;
  const child = spawn(
    nodeExecutable,
    [
      "--import",
      "./scripts/register-hooks.mjs",
      "../../scripts/start-hyperia-server.mjs",
    ],
    {
      cwd: serverPackageRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(input.port),
        UWS_ENABLED: "false",
        DATABASE_URL: databaseUrl,
        USE_LOCAL_POSTGRES: "false",
        JWT_ACTIVE_KEY_ID: jwtSigningKeyId,
        JWT_SIGNING_KEYS: JSON.stringify({
          [jwtSigningKeyId]: jwtSigningSecret,
        }),
        JWT_SECRET: "",
        DISTRIBUTED_RATE_LIMIT_KEY_SECRET: distributedRateLimitSecret,
        SKIP_MIGRATIONS: "true",
        POSTGRES_POOL_MIN: "0",
        POSTGRES_POOL_MAX: "4",
        POSTGRES_CONNECTION_TIMEOUT_MS: "5000",
        POSTGRES_STATEMENT_TIMEOUT_MS: "15000",
        POSTGRES_QUERY_TIMEOUT_MS: "20000",
        STREAMING_DUEL_ENABLED: "true",
        STREAMING_CAPTURE_ENABLED: "false",
        STREAMING_DUEL_SCHEDULER_ROLE: "authority",
        STREAMING_DUEL_AUTHORITY_LEASE_NAME: input.leaseName,
        STREAMING_DUEL_AUTHORITY_LEASE_MS: "10000",
        STREAMING_DUEL_AUTHORITY_RENEW_MS: "3000",
        STREAMING_DUEL_AUTHORITY_RETRY_MS: "1000",
        STREAMING_DUEL_PREPARATION_MS: "60000",
        STREAMING_PUBLIC_DELAY_MS: "0",
        HYPERIA_EXTERNAL_VALUE_ENABLED: "false",
        AUTO_START_AGENTS: "false",
        DISABLE_BOTS: "true",
        DISABLE_ACTIVITY_LOGGER: "true",
        DUEL_ARENA_ORACLE_ENABLED: "false",
        WEB3_ENABLED: "false",
        STREAMING_ALERTS_ENABLED: "false",
        PUBLIC_CDN_URL: "https://assets.hyperia.club",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output: Buffer[] = [];
  let outputBytes = 0;
  let outputOverflow = false;
  const observe = (chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > COMMAND_OUTPUT_LIMIT) {
      outputOverflow = true;
      child.kill("SIGKILL");
      return;
    }
    output.push(chunk);
  };
  child.stdout.on("data", observe);
  child.stderr.on("data", observe);
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
      resolve(childExit);
    });
  });
  const baseUrl = `http://127.0.0.1:${input.port}`;
  const requestJson = async (
    pathname: string,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      signal: AbortSignal.timeout(3_000),
    });
    const body = (await response.json()) as unknown;
    return { status: response.status, body };
  };
  const waitForJson = async (
    pathname: string,
    expectedStatus: number,
  ): Promise<unknown> => {
    const deadline = Date.now() + 300_000;
    let lastError = "not attempted";
    while (Date.now() < deadline) {
      if (childExit) {
        throw new Error(
          `restored server exited before ${pathname}: ${sanitizeServerDiagnostic(Buffer.concat(output).toString("utf8"))}`,
        );
      }
      try {
        const response = await requestJson(pathname);
        if (response.status === expectedStatus) return response.body;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "request failed";
      }
      await delay(250);
    }
    throw new Error(
      `restored server ${pathname} did not return ${expectedStatus}: ${sanitizeServerDiagnostic(`${lastError}\n${Buffer.concat(output).toString("utf8")}`)}`,
    );
  };

  let qualificationError: unknown;
  let statusBody: unknown;
  let healthBody: unknown;
  let stateBody: unknown;
  let streamingHealthBody: unknown;
  let leaderboardBody: unknown;
  try {
    statusBody = await waitForJson("/status", 200);
    healthBody = await waitForJson("/health", 200);
    stateBody = await waitForJson("/api/streaming/state", 200);
    streamingHealthBody = await waitForJson("/api/streaming/health", 503);
    leaderboardBody = await waitForJson(
      "/api/streaming/leaderboard/details?historyLimit=200",
      200,
    );
  } catch (error) {
    qualificationError = error;
  } finally {
    if (!childExit) child.kill("SIGTERM");
  }

  let stopped = await Promise.race([exit, delay(30_000).then(() => null)]);
  if (!stopped) {
    child.kill("SIGKILL");
    stopped = await exit;
  }
  const logs = Buffer.concat(output).toString("utf8");
  if (qualificationError) throw qualificationError;
  assert(!outputOverflow, "restored server output exceeded its bound");
  assert(
    stopped.code === 0 && stopped.signal === null,
    `restored server did not shut down gracefully: ${sanitizeServerDiagnostic(logs)}`,
  );
  assert(
    !logs.includes(input.password) &&
      !logs.includes(jwtSigningSecret) &&
      !logs.includes(distributedRateLimitSecret),
    "restored server logs exposed a disposable credential",
  );
  assert(
    logs.includes(
      `JWT authority ready mode=key-ring active=${jwtSigningKeyId} verify=${jwtSigningKeyId}:${jwtSigningFingerprint}`,
    ),
    "restored server did not report the expected key-ring authority evidence",
  );
  assert(
    logs.includes(
      `Distributed authentication rate-limit authority ready key=${distributedRateLimitFingerprint}`,
    ),
    "restored server did not report the expected shared rate-limit evidence",
  );
  assert(
    !/(?:FATAL|Unhandled|uncaught|migration failed|Agent initialization failed)/iu.test(
      logs,
    ),
    `restored server emitted a fatal startup diagnostic: ${sanitizeServerDiagnostic(logs)}`,
  );
  assert(
    statusBody !== null &&
      typeof statusBody === "object" &&
      healthBody !== null &&
      typeof healthBody === "object" &&
      stateBody !== null &&
      typeof stateBody === "object" &&
      streamingHealthBody !== null &&
      typeof streamingHealthBody === "object" &&
      leaderboardBody !== null &&
      typeof leaderboardBody === "object" &&
      !Array.isArray(leaderboardBody),
    "restored server returned an invalid JSON contract",
  );
  const recentDuels = (leaderboardBody as Record<string, unknown>).recentDuels;
  assert(
    Array.isArray(recentDuels) && recentDuels.length === 1,
    "restored server public history did not expose exactly one duel",
  );
  const duel = recentDuels[0];
  assert(
    duel !== null &&
      typeof duel === "object" &&
      !Array.isArray(duel) &&
      (duel as Record<string, unknown>).cycleId ===
        RECOVERY_DUEL_FIXTURE.cycleId &&
      (duel as Record<string, unknown>).duelId ===
        RECOVERY_DUEL_FIXTURE.duelId &&
      (duel as Record<string, unknown>).outcome === "win" &&
      (duel as Record<string, unknown>).agent1Id ===
        RECOVERY_DUEL_FIXTURE.agent1Id &&
      (duel as Record<string, unknown>).agent2Id ===
        RECOVERY_DUEL_FIXTURE.agent2Id &&
      (duel as Record<string, unknown>).winnerId ===
        RECOVERY_DUEL_FIXTURE.agent1Id &&
      (duel as Record<string, unknown>).winReason === "kill",
    "restored server public history changed authoritative duel truth",
  );
  return {
    statusCode: 200,
    healthCode: 200,
    streamingStateCode: 200,
    streamingHealthCode: 503,
    publicHistoryDuelCount: 1,
    gracefulExitCode: 0,
    nodeVersion: "v22.23.2",
    bundleSha256,
    logSha256: createHash("sha256").update(logs).digest("hex"),
  };
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("bounded integration command timed out"));
      }
    }, timeoutMs);
    const observe = (chunk: Buffer, retain: boolean): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > COMMAND_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        return;
      }
      if (retain) stdout.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => observe(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => observe(chunk, false));
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("bounded integration command could not start"));
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || totalBytes > COMMAND_OUTPUT_LIMIT) {
        reject(new Error("bounded integration command failed"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function docker(
  arguments_: readonly string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<string> {
  try {
    return await runCommand("docker", arguments_, timeoutMs);
  } catch {
    throw new Error(
      `owned PostgreSQL Docker ${arguments_[0] ?? "command"} failed`,
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectRejection(
  operation: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    if (message.includes(expectedMessage)) return;
    throw new Error(`unexpected rejection while testing ${expectedMessage}`);
  }
  throw new Error(`expected rejection was not observed: ${expectedMessage}`);
}

function snapshotManagedEnvironment(): Record<
  ManagedPgEnvironmentName,
  string | undefined
> {
  return Object.fromEntries(
    MANAGED_PG_ENVIRONMENT.map((name) => [name, process.env[name]]),
  ) as Record<ManagedPgEnvironmentName, string | undefined>;
}

function restoreManagedEnvironment(
  snapshot: Record<ManagedPgEnvironmentName, string | undefined>,
): void {
  for (const name of MANAGED_PG_ENVIRONMENT) {
    const value = snapshot[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function configureBackupEnvironment(input: {
  port: number;
  passwordFile: string;
}): void {
  for (const name of MANAGED_PG_ENVIRONMENT) delete process.env[name];
  process.env.PGHOST = "127.0.0.1";
  process.env.PGPORT = String(input.port);
  process.env.PGDATABASE = TEST_DATABASE;
  process.env.PGUSER = TEST_USER;
  process.env.PGPASSFILE = input.passwordFile;
  process.env.PGSSLMODE = "disable";
}

async function waitForDatabase(input: {
  port: number;
  password: string;
}): Promise<void> {
  const deadline = Date.now() + DATABASE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const client = new Client({
      host: "127.0.0.1",
      port: input.port,
      database: TEST_DATABASE,
      user: TEST_USER,
      password: input.password,
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch {
      await delay(250);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  throw new Error("owned PostgreSQL did not become ready within its bound");
}

function createDockerTooling(
  containerName: string,
): HyperiaPostgresBackupTooling {
  return {
    async dump({ snapshotId, databaseName, destinationPath, timeoutMs }) {
      const containerPath = `/tmp/hyperia-backup-${randomUUID()}.dump`;
      try {
        const version = (
          await docker(
            ["exec", containerName, "pg_dump", "--version"],
            timeoutMs,
          )
        ).trim();
        await docker(
          [
            "exec",
            containerName,
            "pg_dump",
            "--username",
            TEST_USER,
            "--format=custom",
            "--no-owner",
            "--no-privileges",
            `--snapshot=${snapshotId}`,
            `--file=${containerPath}`,
            `--dbname=${databaseName}`,
          ],
          timeoutMs,
        );
        await docker([
          "cp",
          `${containerName}:${containerPath}`,
          destinationPath,
        ]);
        chmodSync(destinationPath, 0o600);
        return { version, stdout: "" };
      } finally {
        await docker(["exec", containerName, "rm", "-f", containerPath]).catch(
          () => undefined,
        );
      }
    },
    async list({ backupPath, timeoutMs }) {
      const containerPath = `/tmp/hyperia-verify-${randomUUID()}.dump`;
      try {
        await docker(["cp", backupPath, `${containerName}:${containerPath}`]);
        const version = (
          await docker(
            ["exec", containerName, "pg_restore", "--version"],
            timeoutMs,
          )
        ).trim();
        const stdout = await docker(
          ["exec", containerName, "pg_restore", "--list", containerPath],
          timeoutMs,
        );
        return { version, stdout };
      } finally {
        await docker(["exec", containerName, "rm", "-f", containerPath]).catch(
          () => undefined,
        );
      }
    },
  };
}

function clonePublishedBackup(
  sourceActivePath: string,
  destinationContainerPath: string,
): string {
  const activePath = path.join(destinationContainerPath, "active");
  mkdirSync(destinationContainerPath, { mode: 0o700 });
  chmodSync(destinationContainerPath, 0o700);
  mkdirSync(activePath, { mode: 0o700 });
  chmodSync(activePath, 0o700);
  for (const name of ["hyperia-postgres.dump", "evidence.json"] as const) {
    const destinationPath = path.join(activePath, name);
    copyFileSync(path.join(sourceActivePath, name), destinationPath);
    chmodSync(destinationPath, 0o600);
  }
  return activePath;
}

function rewriteEvidence(
  activePath: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const evidencePath = path.join(activePath, "evidence.json");
  const parsed: unknown = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    "test backup evidence must be an object",
  );
  mutate(parsed as Record<string, unknown>);
  writeFileSync(evidencePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  chmodSync(evidencePath, 0o600);
}

function countHash(counts: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(counts)).digest("hex");
}

async function run(input: {
  retainedBackupContainerPath?: string;
  retainedRestoreEvidencePath?: string;
  retainedApplicationReadinessPath?: string;
}): Promise<TestEvidence> {
  const environmentSnapshot = snapshotManagedEnvironment();
  const testRoot = mkdtempSync(path.join(tmpdir(), "hyperia-pg-recovery-"));
  chmodSync(testRoot, 0o700);
  const containerName = `hyperia-pg-recovery-${randomUUID()}`;
  const password = `local-${randomUUID()}-${randomUUID()}`;
  const dockerEnvironmentPath = path.join(testRoot, "postgres.env");
  const passwordFilePath = path.join(testRoot, "pgpass");
  const releaseSha = (
    await runCommand("git", ["rev-parse", "HEAD"], 10_000)
  ).trim();
  assert(RELEASE_SHA_PATTERN.test(releaseSha), "test release SHA is invalid");
  const boundaryId = `backup-test-${randomUUID()}`;
  const destinationContainerPath = path.join(testRoot, "backup");
  const activePath = path.join(destinationContainerPath, "active");
  const storageKey = `backup-proof-${randomUUID()}`;
  const storageValue = `restored-${randomUUID()}`;
  const leaseName = `backup-proof-${randomUUID()}`;
  const negativeCases: string[] = [];
  let containerStarted = false;
  let pool: pg.Pool | null = null;

  try {
    await expectRejection(
      () => runHyperiaPostgresBackupCli(["bun", "backup", "invalid"]),
      "usage:",
    );
    await expectRejection(
      () =>
        runHyperiaPostgresBackupCli([
          "bun",
          "backup",
          "verify",
          `--database=${TEST_DATABASE}`,
          `--release-sha=${releaseSha}`,
          `--boundary-id=${boundaryId}`,
          "--backup-root=/not-used",
          "--tool-timeout-ms=30000",
          "--unknown=value",
        ]),
      "unknown or duplicate argument",
    );
    negativeCases.push("strict_cli_arguments_enforced");
    await expectRejection(
      () =>
        runHyperiaPostgresRestoreEvidenceCli([
          "bun",
          "restore-evidence",
          "verify",
          "--unknown=value",
        ]),
      "unknown or duplicate argument",
    );
    negativeCases.push("strict_restore_evidence_cli_arguments_enforced");
    await expectRejection(
      () =>
        runHyperiaRestoredDuelApplicationReadinessCli([
          "bun",
          "application-readiness",
          "verify",
          "--unknown=value",
        ]),
      "unknown or duplicate argument",
    );
    negativeCases.push("strict_application_readiness_cli_arguments_enforced");

    writeFileSync(
      dockerEnvironmentPath,
      `POSTGRES_USER=${TEST_USER}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${TEST_DATABASE}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    chmodSync(dockerEnvironmentPath, 0o600);
    await docker(["info"], 30_000);
    await docker(
      [
        "run",
        "--detach",
        "--name",
        containerName,
        "--env-file",
        dockerEnvironmentPath,
        "--publish",
        "127.0.0.1::5432",
        "postgres:16-alpine",
      ],
      180_000,
    );
    containerStarted = true;
    const portOutput = (
      await docker(["port", containerName, "5432/tcp"], 30_000)
    ).trim();
    const portMatch = /^127\.0\.0\.1:([0-9]{1,5})$/u.exec(portOutput);
    assert(portMatch, "owned PostgreSQL published port is invalid");
    const port = Number(portMatch[1]);
    assert(port > 0 && port <= 65_535, "owned PostgreSQL port is invalid");

    writeFileSync(
      passwordFilePath,
      `127.0.0.1:${port}:${TEST_DATABASE}:${TEST_USER}:${password}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    chmodSync(passwordFilePath, 0o600);
    configureBackupEnvironment({ port, passwordFile: passwordFilePath });
    await waitForDatabase({ port, password });

    pool = new Pool({
      host: "127.0.0.1",
      port,
      database: TEST_DATABASE,
      user: TEST_USER,
      password,
      max: 2,
    });
    const migrationClient = await pool.connect();
    try {
      await migrate(createPostgresClientDatabase(migrationClient), {
        migrationsFolder: path.resolve(
          import.meta.dirname,
          "../src/database/migrations",
        ),
      });
    } finally {
      migrationClient.release();
    }
    await pool.query(
      `INSERT INTO "storage" ("key", "value", "updatedAt")
       VALUES ($1, $2, 1000), ($3, $4, $5)`,
      [
        storageKey,
        storageValue,
        BETTING_SOURCE_EPOCH_STORAGE_KEY,
        JSON.stringify({
          sourceEpoch: RECOVERY_BETTING_SOURCE_EPOCH,
          updatedAt: RECOVERY_BETTING_SOURCE_EPOCH,
        }),
        RECOVERY_BETTING_SOURCE_EPOCH,
      ],
    );
    await pool.query(
      `INSERT INTO "streaming_scheduler_leases"
         ("lease_name", "holder_id", "fencing_token", "acquired_at", "renewed_at", "expires_at")
       VALUES ($1, $2, 7, 1000, 2000, 3000)`,
      [leaseName, "backup-proof-holder"],
    );
    await seedRecoveryDuel(pool);

    const tooling = createDockerTooling(containerName);
    const evidence = await createHyperiaPostgresBackup({
      destinationContainerPath,
      releaseSha,
      boundaryId,
      expectedDatabaseName: TEST_DATABASE,
      queryTimeoutMs: 30_000,
      dumpTimeoutMs: BACKUP_TIMEOUT_MS,
      tooling,
    });
    const verified = await verifyHyperiaPostgresBackup({
      backupRootPath: activePath,
      expectedReleaseSha: releaseSha,
      expectedBoundaryId: boundaryId,
      expectedDatabaseName: TEST_DATABASE,
      toolTimeoutMs: 30_000,
      tooling,
    });
    assert(
      JSON.stringify(verified) === JSON.stringify(evidence),
      "independent verification changed backup evidence",
    );
    assert(
      readdirSync(destinationContainerPath).join(",") === "active",
      "published backup container must contain only active",
    );
    assert(
      (lstatSync(destinationContainerPath).mode & 0o777) === 0o700 &&
        (lstatSync(activePath).mode & 0o777) === 0o700 &&
        (lstatSync(path.join(activePath, "hyperia-postgres.dump")).mode &
          0o777) ===
          0o600 &&
        (lstatSync(path.join(activePath, "evidence.json")).mode & 0o777) ===
          0o600,
      "published backup permissions are not private",
    );
    const evidenceBytes = readFileSync(path.join(activePath, "evidence.json"));
    const dumpBytes = readFileSync(
      path.join(activePath, "hyperia-postgres.dump"),
    );
    assert(
      !evidenceBytes.includes(Buffer.from(password)) &&
        !dumpBytes.includes(Buffer.from(password)) &&
        !evidenceBytes.includes(Buffer.from(passwordFilePath)),
      "backup artifact leaked connection credentials",
    );

    await expectRejection(
      () =>
        createHyperiaPostgresBackup({
          destinationContainerPath,
          releaseSha,
          boundaryId,
          expectedDatabaseName: TEST_DATABASE,
          queryTimeoutMs: 30_000,
          dumpTimeoutMs: BACKUP_TIMEOUT_MS,
          tooling,
        }),
      "destination already exists",
    );
    negativeCases.push("destination_overwrite_rejected");
    await expectRejection(
      () =>
        verifyHyperiaPostgresBackup({
          backupRootPath: activePath,
          expectedReleaseSha: releaseSha,
          expectedBoundaryId: `${boundaryId}-drift`,
          expectedDatabaseName: TEST_DATABASE,
          toolTimeoutMs: 30_000,
          tooling,
        }),
      "identity does not match",
    );
    negativeCases.push("boundary_drift_rejected");

    const driftedMigrationsPath = path.join(testRoot, "drifted-migrations");
    cpSync(
      path.resolve(import.meta.dirname, "../src/database/migrations"),
      driftedMigrationsPath,
      { recursive: true },
    );
    const driftedLatestMigrationPath = path.join(
      driftedMigrationsPath,
      "0088_allow_zero_effect_committed_duel_food_observations.sql",
    );
    writeFileSync(
      driftedLatestMigrationPath,
      `${readFileSync(driftedLatestMigrationPath, "utf8")}\n-- test drift\n`,
      "utf8",
    );
    await expectRejection(
      () =>
        verifyHyperiaPostgresBackup({
          backupRootPath: activePath,
          expectedReleaseSha: releaseSha,
          expectedBoundaryId: boundaryId,
          expectedDatabaseName: TEST_DATABASE,
          toolTimeoutMs: 30_000,
          tooling,
          migrationsDirectory: driftedMigrationsPath,
        }),
      "source migration evidence does not match",
    );
    negativeCases.push("source_migration_byte_drift_rejected");

    const extraEntryActive = clonePublishedBackup(
      activePath,
      path.join(testRoot, "extra-entry"),
    );
    writeFileSync(path.join(extraEntryActive, "unexpected"), "x", {
      mode: 0o600,
      flag: "wx",
    });
    await expectRejection(
      () =>
        verifyHyperiaPostgresBackup({
          backupRootPath: extraEntryActive,
          expectedReleaseSha: releaseSha,
          expectedBoundaryId: boundaryId,
          expectedDatabaseName: TEST_DATABASE,
          toolTimeoutMs: 30_000,
          tooling,
        }),
      "unexpected entries",
    );
    negativeCases.push("unexpected_entry_rejected");

    const permissiveActive = clonePublishedBackup(
      activePath,
      path.join(testRoot, "permissive"),
    );
    chmodSync(path.join(permissiveActive, "evidence.json"), 0o644);
    await expectRejection(
      () =>
        verifyHyperiaPostgresBackup({
          backupRootPath: permissiveActive,
          expectedReleaseSha: releaseSha,
          expectedBoundaryId: boundaryId,
          expectedDatabaseName: TEST_DATABASE,
          toolTimeoutMs: 30_000,
          tooling,
        }),
      "mode-0600",
    );
    negativeCases.push("permissive_evidence_rejected");

    const malformedEvidenceActive = clonePublishedBackup(
      activePath,
      path.join(testRoot, "malformed-evidence"),
    );
    rewriteEvidence(malformedEvidenceActive, (value) => {
      value.pgDumpVersion = "unbounded\nversion";
    });
    await expectRejection(
      () =>
        verifyHyperiaPostgresBackup({
          backupRootPath: malformedEvidenceActive,
          expectedReleaseSha: releaseSha,
          expectedBoundaryId: boundaryId,
          expectedDatabaseName: TEST_DATABASE,
          toolTimeoutMs: 30_000,
          tooling,
        }),
      "evidence is invalid",
    );
    negativeCases.push("malformed_evidence_rejected");

    const driftedDumpActive = clonePublishedBackup(
      activePath,
      path.join(testRoot, "drifted-dump"),
    );
    const driftedDumpPath = path.join(
      driftedDumpActive,
      "hyperia-postgres.dump",
    );
    writeFileSync(
      driftedDumpPath,
      Buffer.concat([readFileSync(driftedDumpPath), Buffer.from("drift")]),
    );
    chmodSync(driftedDumpPath, 0o600);
    await expectRejection(
      () =>
        verifyHyperiaPostgresBackup({
          backupRootPath: driftedDumpActive,
          expectedReleaseSha: releaseSha,
          expectedBoundaryId: boundaryId,
          expectedDatabaseName: TEST_DATABASE,
          toolTimeoutMs: 30_000,
          tooling,
        }),
      "file binding does not match",
    );
    negativeCases.push("dump_byte_drift_rejected");

    const corruptArchiveActive = clonePublishedBackup(
      activePath,
      path.join(testRoot, "corrupt-archive"),
    );
    const corruptArchivePath = path.join(
      corruptArchiveActive,
      "hyperia-postgres.dump",
    );
    const corruptArchiveBytes = readFileSync(corruptArchivePath);
    assert(
      corruptArchiveBytes.byteLength > 16,
      "test archive is unexpectedly small",
    );
    corruptArchiveBytes[0] = corruptArchiveBytes[0] ^ 0xff;
    writeFileSync(corruptArchivePath, corruptArchiveBytes);
    chmodSync(corruptArchivePath, 0o600);
    rewriteEvidence(corruptArchiveActive, (value) => {
      value.backupSha256 = createHash("sha256")
        .update(corruptArchiveBytes)
        .digest("hex");
      value.backupBytes = corruptArchiveBytes.byteLength;
    });
    await expectRejection(
      () =>
        verifyHyperiaPostgresBackup({
          backupRootPath: corruptArchiveActive,
          expectedReleaseSha: releaseSha,
          expectedBoundaryId: boundaryId,
          expectedDatabaseName: TEST_DATABASE,
          toolTimeoutMs: 30_000,
          tooling,
        }),
      "Docker exec failed",
    );
    negativeCases.push("corrupt_archive_rejected_by_pg_restore");

    const symlinkPasswordPath = path.join(testRoot, "pgpass-link");
    symlinkSync(passwordFilePath, symlinkPasswordPath);
    process.env.PGPASSFILE = symlinkPasswordPath;
    await expectRejection(
      () =>
        createHyperiaPostgresBackup({
          destinationContainerPath: path.join(testRoot, "symlink-secret"),
          releaseSha,
          boundaryId,
          expectedDatabaseName: TEST_DATABASE,
          queryTimeoutMs: 30_000,
          dumpTimeoutMs: BACKUP_TIMEOUT_MS,
          tooling,
        }),
      "mode-0600 regular file",
    );
    process.env.PGPASSFILE = passwordFilePath;
    negativeCases.push("symlink_pgpass_rejected");

    process.env.PGPASSWORD = password;
    await expectRejection(
      () =>
        createHyperiaPostgresBackup({
          destinationContainerPath: path.join(testRoot, "password-alias"),
          releaseSha,
          boundaryId,
          expectedDatabaseName: TEST_DATABASE,
          queryTimeoutMs: 30_000,
          dumpTimeoutMs: BACKUP_TIMEOUT_MS,
          tooling,
        }),
      "without password-bearing aliases",
    );
    delete process.env.PGPASSWORD;
    negativeCases.push("password_alias_rejected");

    const latestMigration = await pool.query<{ id: number; hash: string }>(
      `SELECT "id", "hash" FROM "drizzle"."__drizzle_migrations"
       ORDER BY "id" DESC LIMIT 1`,
    );
    const latestMigrationRow = latestMigration.rows[0];
    assert(latestMigrationRow, "latest migration journal row is missing");
    await pool.query(
      `UPDATE "drizzle"."__drizzle_migrations" SET "hash" = $1 WHERE "id" = $2`,
      ["0".repeat(64), latestMigrationRow.id],
    );
    const migrationDriftDestinationPath = path.join(
      testRoot,
      "migration-drift",
    );
    try {
      await expectRejection(
        () =>
          createHyperiaPostgresBackup({
            destinationContainerPath: migrationDriftDestinationPath,
            releaseSha,
            boundaryId,
            expectedDatabaseName: TEST_DATABASE,
            queryTimeoutMs: 30_000,
            dumpTimeoutMs: BACKUP_TIMEOUT_MS,
            tooling,
          }),
        "migration journal does not match source",
      );
      assert(
        !existsSync(migrationDriftDestinationPath),
        "migration-drift rejection left a partial destination",
      );
    } finally {
      await pool.query(
        `UPDATE "drizzle"."__drizzle_migrations" SET "hash" = $1 WHERE "id" = $2`,
        [latestMigrationRow.hash, latestMigrationRow.id],
      );
    }
    negativeCases.push("migration_journal_drift_rejected");

    await pool.query('CREATE TABLE "unapproved_recovery_state" ("id" bigint)');
    const tableDriftDestinationPath = path.join(testRoot, "table-drift");
    try {
      await expectRejection(
        () =>
          createHyperiaPostgresBackup({
            destinationContainerPath: tableDriftDestinationPath,
            releaseSha,
            boundaryId,
            expectedDatabaseName: TEST_DATABASE,
            queryTimeoutMs: 30_000,
            dumpTimeoutMs: BACKUP_TIMEOUT_MS,
            tooling,
          }),
        "table inventory does not match recovery policy",
      );
      assert(
        !existsSync(tableDriftDestinationPath),
        "table-inventory rejection left a partial destination",
      );
    } finally {
      await pool.query('DROP TABLE "unapproved_recovery_state"');
    }
    negativeCases.push("unapproved_table_rejected");

    const contaminatedDestinationPath = path.join(testRoot, "contaminated");
    await expectRejection(
      () =>
        createHyperiaPostgresBackup({
          destinationContainerPath: contaminatedDestinationPath,
          releaseSha,
          boundaryId,
          expectedDatabaseName: TEST_DATABASE,
          queryTimeoutMs: 30_000,
          dumpTimeoutMs: BACKUP_TIMEOUT_MS,
          tooling,
          beforePublish: () => {
            const stagingName = readdirSync(contaminatedDestinationPath).find(
              (name) => name.startsWith(".staging-"),
            );
            assert(stagingName, "test staging root was not present");
            writeFileSync(
              path.join(contaminatedDestinationPath, stagingName, "unexpected"),
              "x",
              { mode: 0o600, flag: "wx" },
            );
          },
        }),
      "unexpected entries",
    );
    assert(
      !existsSync(contaminatedDestinationPath),
      "failed publish left a partial destination",
    );
    negativeCases.push("prepublish_contamination_removed");

    const restoredDatabase = `restored_${randomUUID().replaceAll("-", "")}`;
    await docker([
      "exec",
      containerName,
      "createdb",
      "--username",
      TEST_USER,
      restoredDatabase,
    ]);
    const restoreContainerPath = `/tmp/hyperia-restore-${randomUUID()}.dump`;
    try {
      await docker([
        "cp",
        path.join(activePath, "hyperia-postgres.dump"),
        `${containerName}:${restoreContainerPath}`,
      ]);
      await docker(
        [
          "exec",
          containerName,
          "pg_restore",
          "--username",
          TEST_USER,
          "--exit-on-error",
          "--no-owner",
          "--no-privileges",
          `--dbname=${restoredDatabase}`,
          restoreContainerPath,
        ],
        BACKUP_TIMEOUT_MS,
      );
    } finally {
      await docker([
        "exec",
        containerName,
        "rm",
        "-f",
        restoreContainerPath,
      ]).catch(() => undefined);
    }

    writeFileSync(
      passwordFilePath,
      `127.0.0.1:${port}:${restoredDatabase}:${TEST_USER}:${password}\n`,
      "utf8",
    );
    chmodSync(passwordFilePath, 0o600);
    process.env.PGDATABASE = restoredDatabase;
    await expectRejection(
      () =>
        verifyHyperiaPostgresRestore({
          backupRootPath: activePath,
          expectedReleaseSha: releaseSha,
          expectedBoundaryId: boundaryId,
          sourceDatabaseName: TEST_DATABASE,
          restoredDatabaseName: restoredDatabase,
          approvedTargetServerVersionNum: "990000",
          queryTimeoutMs: 30_000,
          toolTimeoutMs: 30_000,
          tooling,
          migrationsDirectory: path.resolve(
            import.meta.dirname,
            "../src/database/migrations",
          ),
        }),
      "major version approval does not match source",
    );
    negativeCases.push("unapproved_restore_version_rejected");
    let restoreVerification = await verifyHyperiaPostgresRestore({
      backupRootPath: activePath,
      expectedReleaseSha: releaseSha,
      expectedBoundaryId: boundaryId,
      sourceDatabaseName: TEST_DATABASE,
      restoredDatabaseName: restoredDatabase,
      approvedTargetServerVersionNum: evidence.serverVersionNum,
      queryTimeoutMs: 30_000,
      toolTimeoutMs: 30_000,
      tooling,
      migrationsDirectory: path.resolve(
        import.meta.dirname,
        "../src/database/migrations",
      ),
    });

    const restoredClient = new Client({
      host: "127.0.0.1",
      port,
      database: restoredDatabase,
      user: TEST_USER,
      password,
      connectionTimeoutMillis: 5_000,
    });
    await restoredClient.connect();
    try {
      await restoredClient.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const storage = await restoredClient.query<{ value: string }>(
        'SELECT "value" FROM "storage" WHERE "key" = $1',
        [storageKey],
      );
      const lease = await restoredClient.query<{
        holder_id: string;
        fencing_token: string;
      }>(
        `SELECT "holder_id", "fencing_token"::text AS "fencing_token"
           FROM "streaming_scheduler_leases" WHERE "lease_name" = $1`,
        [leaseName],
      );
      assert(
        storage.rows[0]?.value === storageValue,
        "restored storage marker does not match",
      );
      assert(
        lease.rows[0]?.holder_id === "backup-proof-holder" &&
          lease.rows[0]?.fencing_token === "7",
        "restored scheduler lease marker does not match",
      );
      await restoredClient.query("COMMIT");
      await restoredClient.query(
        'UPDATE "storage" SET "value" = $1 WHERE "key" = $2',
        [`${storageValue}-same-count-drift`, storageKey],
      );
      await expectRejection(
        () =>
          verifyHyperiaPostgresRestore({
            backupRootPath: activePath,
            expectedReleaseSha: releaseSha,
            expectedBoundaryId: boundaryId,
            sourceDatabaseName: TEST_DATABASE,
            restoredDatabaseName: restoredDatabase,
            approvedTargetServerVersionNum: evidence.serverVersionNum,
            queryTimeoutMs: 30_000,
            toolTimeoutMs: 30_000,
            tooling,
            migrationsDirectory: path.resolve(
              import.meta.dirname,
              "../src/database/migrations",
            ),
          }),
        "does not match backup evidence",
      );
      await restoredClient.query(
        'UPDATE "storage" SET "value" = $1 WHERE "key" = $2',
        [storageValue, storageKey],
      );
      restoreVerification = await verifyHyperiaPostgresRestore({
        backupRootPath: activePath,
        expectedReleaseSha: releaseSha,
        expectedBoundaryId: boundaryId,
        sourceDatabaseName: TEST_DATABASE,
        restoredDatabaseName: restoredDatabase,
        approvedTargetServerVersionNum: evidence.serverVersionNum,
        queryTimeoutMs: 30_000,
        toolTimeoutMs: 30_000,
        tooling,
        migrationsDirectory: path.resolve(
          import.meta.dirname,
          "../src/database/migrations",
        ),
      });
      negativeCases.push("same_count_row_content_drift_rejected");
    } catch (error) {
      await restoredClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await restoredClient.end();
    }
    const restoredInspection: HyperiaPostgresRecoveryInspection =
      restoreVerification.inspection;
    assert(
      restoredInspection.schemaSha256 === evidence.schemaSha256 &&
        restoredInspection.databaseMigrationJournalSha256 ===
          evidence.databaseMigrationJournalSha256 &&
        JSON.stringify(restoredInspection.schemaObjectCounts) ===
          JSON.stringify(evidence.schemaObjectCounts) &&
        JSON.stringify(restoredInspection.recoveryTableCounts) ===
          JSON.stringify(evidence.recoveryTableCounts) &&
        JSON.stringify(restoredInspection.recoveryTableSha256s) ===
          JSON.stringify(evidence.recoveryTableSha256s),
      "isolated restore inspection does not match backup evidence",
    );

    const restoreEvidenceDirectory = path.join(testRoot, "restore-evidence");
    mkdirSync(restoreEvidenceDirectory, { mode: 0o700 });
    chmodSync(restoreEvidenceDirectory, 0o700);
    const restoreEvidencePath = path.join(
      restoreEvidenceDirectory,
      "hyperia-postgres-restore-evidence.json",
    );
    const restoreEvidenceArguments = (command: "create" | "verify") => [
      "bun",
      "restore-evidence",
      command,
      `--source-database=${TEST_DATABASE}`,
      `--restored-database=${restoredDatabase}`,
      `--release-sha=${releaseSha}`,
      `--boundary-id=${boundaryId}`,
      `--backup-root=${activePath}`,
      `--restore-evidence=${restoreEvidencePath}`,
      `--approved-target-server-version-num=${evidence.serverVersionNum}`,
      "--query-timeout-ms=30000",
      "--tool-timeout-ms=30000",
    ];
    const restoreEvidenceOverrides = {
      tooling,
      migrationsDirectory: path.resolve(
        import.meta.dirname,
        "../src/database/migrations",
      ),
    };
    const createdRestoreEvidence = await runHyperiaPostgresRestoreEvidenceCli(
      restoreEvidenceArguments("create"),
      restoreEvidenceOverrides,
    );
    const verifiedRestoreEvidence = await runHyperiaPostgresRestoreEvidenceCli(
      restoreEvidenceArguments("verify"),
      restoreEvidenceOverrides,
    );
    assert(
      createdRestoreEvidence.restoreVerificationId ===
        verifiedRestoreEvidence.restoreVerificationId &&
        createdRestoreEvidence.restoredStateSha256 ===
          verifiedRestoreEvidence.restoredStateSha256 &&
        createdRestoreEvidence.productionCutoverAuthorized === false &&
        (lstatSync(restoreEvidencePath).mode & 0o777) === 0o600,
      "retained restore evidence did not independently verify",
    );
    const originalRestoreEvidence = readFileSync(restoreEvidencePath);
    assert(
      !originalRestoreEvidence.includes(Buffer.from(password)) &&
        !originalRestoreEvidence.includes(Buffer.from(passwordFilePath)),
      "restore evidence leaked connection credentials",
    );
    await expectRejection(
      () =>
        runHyperiaPostgresRestoreEvidenceCli(
          restoreEvidenceArguments("create"),
          restoreEvidenceOverrides,
        ),
      "already exists",
    );
    negativeCases.push("restore_evidence_overwrite_rejected");
    chmodSync(restoreEvidencePath, 0o644);
    await expectRejection(
      () =>
        runHyperiaPostgresRestoreEvidenceCli(
          restoreEvidenceArguments("verify"),
          restoreEvidenceOverrides,
        ),
      "mode-0600",
    );
    chmodSync(restoreEvidencePath, 0o600);
    negativeCases.push("permissive_restore_evidence_rejected");
    const driftedRestoreEvidence: unknown = JSON.parse(
      originalRestoreEvidence.toString("utf8"),
    );
    assert(
      driftedRestoreEvidence !== null &&
        typeof driftedRestoreEvidence === "object" &&
        !Array.isArray(driftedRestoreEvidence),
      "restore evidence fixture is invalid",
    );
    (driftedRestoreEvidence as Record<string, unknown>).restoredStateSha256 =
      "0".repeat(64);
    writeFileSync(
      restoreEvidencePath,
      `${JSON.stringify(driftedRestoreEvidence, null, 2)}\n`,
      "utf8",
    );
    chmodSync(restoreEvidencePath, 0o600);
    await expectRejection(
      () =>
        runHyperiaPostgresRestoreEvidenceCli(
          restoreEvidenceArguments("verify"),
          restoreEvidenceOverrides,
        ),
      "does not match current state",
    );
    writeFileSync(restoreEvidencePath, originalRestoreEvidence);
    chmodSync(restoreEvidencePath, 0o600);
    negativeCases.push("restore_evidence_state_digest_drift_rejected");

    const applicationReadinessDirectory = path.join(
      testRoot,
      "application-readiness",
    );
    mkdirSync(applicationReadinessDirectory, { mode: 0o700 });
    chmodSync(applicationReadinessDirectory, 0o700);
    const applicationReadinessPath = path.join(
      applicationReadinessDirectory,
      "hyperia-restored-duel-application-readiness.json",
    );
    const applicationReadinessArguments = (command: "create" | "verify") => [
      "bun",
      "application-readiness",
      command,
      `--source-database=${TEST_DATABASE}`,
      `--restored-database=${restoredDatabase}`,
      `--release-sha=${releaseSha}`,
      `--boundary-id=${boundaryId}`,
      `--backup-root=${activePath}`,
      `--restore-evidence=${restoreEvidencePath}`,
      `--application-readiness=${applicationReadinessPath}`,
      `--approved-target-server-version-num=${evidence.serverVersionNum}`,
      "--query-timeout-ms=30000",
      "--tool-timeout-ms=30000",
    ];
    const createdApplicationReadiness =
      await runHyperiaRestoredDuelApplicationReadinessCli(
        applicationReadinessArguments("create"),
        restoreEvidenceOverrides,
      );
    const verifiedApplicationReadiness =
      await runHyperiaRestoredDuelApplicationReadinessCli(
        applicationReadinessArguments("verify"),
        restoreEvidenceOverrides,
      );
    const expectedApplicationFacts = [
      {
        cycleId: RECOVERY_DUEL_FIXTURE.cycleId,
        duelId: RECOVERY_DUEL_FIXTURE.duelId,
        finishedAt: RECOVERY_DUEL_FIXTURE.terminalAt,
        outcome: "win",
        agent1Id: RECOVERY_DUEL_FIXTURE.agent1Id,
        agent2Id: RECOVERY_DUEL_FIXTURE.agent2Id,
        winnerId: RECOVERY_DUEL_FIXTURE.agent1Id,
        winReason: "kill",
        cancellationReason: null,
      },
    ];
    const expectedApplicationFactSha256 = createHash("sha256")
      .update(canonicalFixtureJson(expectedApplicationFacts))
      .digest("hex");
    assert(
      createdApplicationReadiness.applicationReadinessId ===
        verifiedApplicationReadiness.applicationReadinessId,
      "application readiness create and verify identities differ",
    );
    assert(
      createdApplicationReadiness.restoreVerificationId ===
        createdRestoreEvidence.restoreVerificationId,
      "application readiness prerequisite identity differs",
    );
    assert(
      createdApplicationReadiness.routeContract ===
        "/api/streaming/leaderboard/details" &&
        createdApplicationReadiness.historyLimit === 200,
      "application readiness route contract differs",
    );
    assert(
      createdApplicationReadiness.recentDuelCount === 1 &&
        createdApplicationReadiness.projectedCompetitiveDuelCount === 1,
      `application readiness projected ${createdApplicationReadiness.recentDuelCount}/${createdApplicationReadiness.projectedCompetitiveDuelCount} duel rows instead of 1/1`,
    );
    assert(
      createdApplicationReadiness.projectedCompetitiveDuelStateSha256 ===
        expectedApplicationFactSha256,
      `application readiness competitive digest differs: ${createdApplicationReadiness.projectedCompetitiveDuelStateSha256} != ${expectedApplicationFactSha256}`,
    );
    assert(
      createdApplicationReadiness.databaseMutationAuthorized === false &&
        createdApplicationReadiness.activationRequiresSeparateApproval ===
          true &&
        createdApplicationReadiness.productionCutoverAuthorized === false,
      "application readiness safety scope differs",
    );
    assert(
      (lstatSync(applicationReadinessPath).mode & 0o777) === 0o600,
      "application readiness evidence is not private",
    );
    const originalApplicationReadiness = readFileSync(applicationReadinessPath);
    const retainedApplicationReadiness: unknown = JSON.parse(
      originalApplicationReadiness.toString("utf8"),
    );
    assert(
      retainedApplicationReadiness !== null &&
        typeof retainedApplicationReadiness === "object" &&
        !Array.isArray(retainedApplicationReadiness) &&
        canonicalFixtureJson(
          (retainedApplicationReadiness as Record<string, unknown>)
            .projectedCompetitiveDuels,
        ) === canonicalFixtureJson(expectedApplicationFacts),
      "application readiness competitive facts differ",
    );
    assert(
      !originalApplicationReadiness.includes(Buffer.from(password)) &&
        !originalApplicationReadiness.includes(Buffer.from(passwordFilePath)),
      "application readiness evidence leaked connection credentials",
    );
    await expectRejection(
      () =>
        runHyperiaRestoredDuelApplicationReadinessCli(
          applicationReadinessArguments("create"),
          restoreEvidenceOverrides,
        ),
      "already exists",
    );
    negativeCases.push("application_readiness_overwrite_rejected");
    chmodSync(applicationReadinessPath, 0o644);
    await expectRejection(
      () =>
        runHyperiaRestoredDuelApplicationReadinessCli(
          applicationReadinessArguments("verify"),
          restoreEvidenceOverrides,
        ),
      "mode-0600",
    );
    chmodSync(applicationReadinessPath, 0o600);
    negativeCases.push("permissive_application_readiness_rejected");
    process.env.PGPASSWORD = password;
    await expectRejection(
      () =>
        inspectHyperiaRestoredDuelApplication({
          restoredDatabaseName: restoredDatabase,
          queryTimeoutMs: 30_000,
        }),
      "cannot use password-bearing aliases",
    );
    delete process.env.PGPASSWORD;
    negativeCases.push("application_password_alias_rejected");
    const driftedApplicationReadiness: unknown = JSON.parse(
      originalApplicationReadiness.toString("utf8"),
    );
    assert(
      driftedApplicationReadiness !== null &&
        typeof driftedApplicationReadiness === "object" &&
        !Array.isArray(driftedApplicationReadiness),
      "application readiness fixture is invalid",
    );
    (
      driftedApplicationReadiness as Record<string, unknown>
    ).publicRecentDuelsSha256 = "0".repeat(64);
    writeFileSync(
      applicationReadinessPath,
      `${JSON.stringify(driftedApplicationReadiness, null, 2)}\n`,
      "utf8",
    );
    chmodSync(applicationReadinessPath, 0o600);
    await expectRejection(
      () =>
        runHyperiaRestoredDuelApplicationReadinessCli(
          applicationReadinessArguments("verify"),
          restoreEvidenceOverrides,
        ),
      "does not match current state",
    );
    writeFileSync(applicationReadinessPath, originalApplicationReadiness);
    chmodSync(applicationReadinessPath, 0o600);
    negativeCases.push("application_readiness_state_digest_drift_rejected");

    const factDriftedApplicationReadiness: unknown = JSON.parse(
      originalApplicationReadiness.toString("utf8"),
    );
    assert(
      factDriftedApplicationReadiness !== null &&
        typeof factDriftedApplicationReadiness === "object" &&
        !Array.isArray(factDriftedApplicationReadiness),
      "application readiness fact-drift fixture is invalid",
    );
    const factDriftedRecord = factDriftedApplicationReadiness as Record<
      string,
      unknown
    >;
    assert(
      Array.isArray(factDriftedRecord.projectedCompetitiveDuels) &&
        factDriftedRecord.projectedCompetitiveDuels.length === 1,
      "application readiness projected-fact fixture is invalid",
    );
    (
      factDriftedRecord.projectedCompetitiveDuels[0] as Record<string, unknown>
    ).winnerId = RECOVERY_DUEL_FIXTURE.agent2Id;
    writeFileSync(
      applicationReadinessPath,
      `${JSON.stringify(factDriftedApplicationReadiness, null, 2)}\n`,
      "utf8",
    );
    chmodSync(applicationReadinessPath, 0o600);
    await expectRejection(
      () =>
        runHyperiaRestoredDuelApplicationReadinessCli(
          applicationReadinessArguments("verify"),
          restoreEvidenceOverrides,
        ),
      "evidence is invalid",
    );
    writeFileSync(applicationReadinessPath, originalApplicationReadiness);
    chmodSync(applicationReadinessPath, 0o600);
    negativeCases.push(
      "application_readiness_projected_fact_digest_drift_rejected",
    );

    const restoredServerLeaseName = `restored-startup-${randomUUID()}`;
    const restoredServerStartedAt = Date.now();
    const restoredServerStartup = await runRestoredServerStartup({
      port: await reserveLoopbackPort(),
      databaseName: restoredDatabase,
      databasePort: port,
      password,
      leaseName: restoredServerLeaseName,
    });
    const restoredServerStoppedAt = Date.now();
    const postStartupClient = new Client({
      host: "127.0.0.1",
      port,
      database: restoredDatabase,
      user: TEST_USER,
      password,
      connectionTimeoutMillis: 5_000,
    });
    await postStartupClient.connect();
    try {
      await postStartupClient.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const postStartupInspection = await inspectHyperiaPostgresRecoveryState(
        postStartupClient,
        restoreEvidenceOverrides.migrationsDirectory,
      );
      const changedTables = HYPERIA_RECOVERY_TABLES.filter(
        (tableName) =>
          postStartupInspection.recoveryTableCounts[tableName] !==
            restoredInspection.recoveryTableCounts[tableName] ||
          postStartupInspection.recoveryTableSha256s[tableName] !==
            restoredInspection.recoveryTableSha256s[tableName],
      );
      assert(
        postStartupInspection.schemaSha256 ===
          restoredInspection.schemaSha256 &&
          postStartupInspection.databaseMigrationJournalSha256 ===
            restoredInspection.databaseMigrationJournalSha256 &&
          canonicalFixtureJson(changedTables) ===
            canonicalFixtureJson(["storage", "streaming_scheduler_leases"]),
        `restored server startup mutated unexpected recovery state: ${changedTables.join(",")}`,
      );
      const startupEpoch = await postStartupClient.query<{
        value: string;
        updated_at: string;
      }>(
        `SELECT value, "updatedAt"::text AS updated_at
           FROM storage
          WHERE key = $1`,
        [BETTING_SOURCE_EPOCH_STORAGE_KEY],
      );
      const startupEpochValue: unknown = JSON.parse(
        startupEpoch.rows[0]?.value ?? "null",
      );
      assert(
        startupEpoch.rows.length === 1 &&
          startupEpochValue !== null &&
          typeof startupEpochValue === "object" &&
          !Array.isArray(startupEpochValue) &&
          Object.keys(startupEpochValue).length === 2 &&
          Object.hasOwn(startupEpochValue, "sourceEpoch") &&
          Object.hasOwn(startupEpochValue, "updatedAt") &&
          (startupEpochValue as Record<string, unknown>).sourceEpoch ===
            RECOVERY_BETTING_SOURCE_EPOCH + 1 &&
          Number.isSafeInteger(
            (startupEpochValue as Record<string, unknown>).updatedAt,
          ) &&
          Number((startupEpochValue as Record<string, unknown>).updatedAt) >=
            restoredServerStartedAt &&
          Number((startupEpochValue as Record<string, unknown>).updatedAt) <=
            restoredServerStoppedAt &&
          Number(startupEpoch.rows[0]?.updated_at) >= restoredServerStartedAt &&
          Number(startupEpoch.rows[0]?.updated_at) <= restoredServerStoppedAt,
        "restored server did not advance the betting source epoch exactly once",
      );
      const startupLease = await postStartupClient.query<{
        lease_name: string;
        expired: boolean;
      }>(
        `SELECT lease_name, expires_at <=
              (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS expired
           FROM streaming_scheduler_leases
          WHERE lease_name = $1`,
        [restoredServerLeaseName],
      );
      assert(
        startupLease.rows.length === 1 &&
          startupLease.rows[0]?.lease_name === restoredServerLeaseName &&
          startupLease.rows[0]?.expired === true,
        "restored server did not release its exact startup authority lease",
      );
      await postStartupClient.query("COMMIT");
      await postStartupClient.query("BEGIN");
      const epochCleanup = await postStartupClient.query(
        `UPDATE storage
            SET value = $2, "updatedAt" = $3
          WHERE key = $1`,
        [
          BETTING_SOURCE_EPOCH_STORAGE_KEY,
          JSON.stringify({
            sourceEpoch: RECOVERY_BETTING_SOURCE_EPOCH,
            updatedAt: RECOVERY_BETTING_SOURCE_EPOCH,
          }),
          RECOVERY_BETTING_SOURCE_EPOCH,
        ],
      );
      const leaseCleanup = await postStartupClient.query(
        `DELETE FROM streaming_scheduler_leases
          WHERE lease_name = $1
            AND expires_at <=
              (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint`,
        [restoredServerLeaseName],
      );
      assert(
        epochCleanup.rowCount === 1 && leaseCleanup.rowCount === 1,
        "restored server startup state cleanup was not exact",
      );
      await postStartupClient.query("COMMIT");
    } catch (error) {
      await postStartupClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await postStartupClient.end();
    }
    await runHyperiaPostgresRestoreEvidenceCli(
      restoreEvidenceArguments("verify"),
      restoreEvidenceOverrides,
    );
    await runHyperiaRestoredDuelApplicationReadinessCli(
      applicationReadinessArguments("verify"),
      restoreEvidenceOverrides,
    );

    if (input.retainedBackupContainerPath) {
      clonePublishedBackup(activePath, input.retainedBackupContainerPath);
    }
    if (input.retainedRestoreEvidencePath) {
      copyFileSync(restoreEvidencePath, input.retainedRestoreEvidencePath);
      chmodSync(input.retainedRestoreEvidencePath, 0o600);
    }
    if (input.retainedApplicationReadinessPath) {
      copyFileSync(
        applicationReadinessPath,
        input.retainedApplicationReadinessPath,
      );
      chmodSync(input.retainedApplicationReadinessPath, 0o600);
    }
    const restoreEvidenceSha256 = createHash("sha256")
      .update(readFileSync(restoreEvidencePath))
      .digest("hex");
    const applicationReadinessSha256 = createHash("sha256")
      .update(readFileSync(applicationReadinessPath))
      .digest("hex");

    return {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      sourceState: "dirty_worktree_test_only",
      postgresImage: "postgres:16-alpine",
      releaseSha,
      boundaryId,
      backupId: evidence.backupId,
      backupSha256: evidence.backupSha256,
      backupBytes: evidence.backupBytes,
      tocSha256: evidence.tocSha256,
      tocEntries: evidence.tocEntries,
      schemaSha256: evidence.schemaSha256,
      sourceMigrationCount: evidence.sourceMigrationCount,
      sourceLatestMigrationTag: evidence.sourceLatestMigrationTag,
      recoveryTableCount: HYPERIA_RECOVERY_TABLES.length,
      restoredRecoveryTableCountsSha256: countHash(
        restoredInspection.recoveryTableCounts,
      ),
      restoredRecoveryTableSha256sSha256: countHash(
        restoredInspection.recoveryTableSha256s,
      ),
      restoreVerificationId: createdRestoreEvidence.restoreVerificationId,
      restoreEvidenceSha256,
      applicationReadinessId:
        createdApplicationReadiness.applicationReadinessId,
      applicationReadinessSha256,
      applicationRecentDuelCount: createdApplicationReadiness.recentDuelCount,
      applicationProjectedCompetitiveDuelCount:
        createdApplicationReadiness.projectedCompetitiveDuelCount,
      applicationProjectedCompetitiveDuelStateSha256:
        createdApplicationReadiness.projectedCompetitiveDuelStateSha256,
      restoredApplicationHistoryReadCompatible: true,
      restoredServerStartupCompatible: true,
      restoredServerStatusCode: restoredServerStartup.statusCode,
      restoredServerHealthCode: restoredServerStartup.healthCode,
      restoredServerStreamingStateCode:
        restoredServerStartup.streamingStateCode,
      restoredServerStreamingHealthCode:
        restoredServerStartup.streamingHealthCode,
      restoredServerPublicHistoryDuelCount:
        restoredServerStartup.publicHistoryDuelCount,
      restoredServerExpectedMutationTables: [
        "storage",
        "streaming_scheduler_leases",
      ],
      restoredServerSourceEpochAdvancedExactlyOnce: true,
      restoredServerGracefulExitCode: restoredServerStartup.gracefulExitCode,
      restoredServerNodeVersion: restoredServerStartup.nodeVersion,
      restoredServerBundleSha256: restoredServerStartup.bundleSha256,
      restoredServerLogSha256: restoredServerStartup.logSha256,
      seededStorageValueRecovered: true,
      seededLeaseRecovered: true,
      seededTerminalDuelRecovered: true,
      negativeCases,
    };
  } finally {
    await pool?.end().catch(() => undefined);
    restoreManagedEnvironment(environmentSnapshot);
    if (containerStarted) {
      await docker(["rm", "--force", containerName], 30_000).catch(
        () => undefined,
      );
    }
    rmSync(testRoot, { recursive: true, force: true });
  }
}

try {
  const parsedArguments = new Map<string, string>();
  for (const argument of process.argv.slice(2)) {
    const match =
      /^--(evidence-output|retained-backup-container|retained-restore-evidence|retained-application-readiness)=(.+)$/u.exec(
        argument,
      );
    if (!match || parsedArguments.has(match[1])) {
      throw new Error(
        "usage: test-hyperia-postgres-backup [--evidence-output=PATH] [--retained-backup-container=PATH] [--retained-restore-evidence=PATH] [--retained-application-readiness=PATH]",
      );
    }
    parsedArguments.set(match[1], match[2]);
  }
  const retainedBackupArgument = parsedArguments.get(
    "retained-backup-container",
  );
  const retainedBackupContainerPath = retainedBackupArgument
    ? path.resolve(retainedBackupArgument)
    : undefined;
  if (retainedBackupContainerPath) {
    const parentStats = lstatSync(path.dirname(retainedBackupContainerPath));
    if (
      !parentStats.isDirectory() ||
      (parentStats.mode & 0o777) !== 0o700 ||
      existsSync(retainedBackupContainerPath)
    ) {
      throw new Error(
        "retained backup container must be new under a mode-0700 directory",
      );
    }
  }
  const retainedRestoreEvidenceArgument = parsedArguments.get(
    "retained-restore-evidence",
  );
  const retainedRestoreEvidencePath = retainedRestoreEvidenceArgument
    ? path.resolve(retainedRestoreEvidenceArgument)
    : undefined;
  if (retainedRestoreEvidencePath) {
    const parentStats = lstatSync(path.dirname(retainedRestoreEvidencePath));
    if (
      path.basename(retainedRestoreEvidencePath) !==
        "hyperia-postgres-restore-evidence.json" ||
      !parentStats.isDirectory() ||
      (parentStats.mode & 0o777) !== 0o700 ||
      existsSync(retainedRestoreEvidencePath)
    ) {
      throw new Error(
        "retained restore evidence must be new under a mode-0700 directory",
      );
    }
  }
  const retainedApplicationReadinessArgument = parsedArguments.get(
    "retained-application-readiness",
  );
  const retainedApplicationReadinessPath = retainedApplicationReadinessArgument
    ? path.resolve(retainedApplicationReadinessArgument)
    : undefined;
  if (retainedApplicationReadinessPath) {
    const parentStats = lstatSync(
      path.dirname(retainedApplicationReadinessPath),
    );
    if (
      path.basename(retainedApplicationReadinessPath) !==
        "hyperia-restored-duel-application-readiness.json" ||
      !parentStats.isDirectory() ||
      (parentStats.mode & 0o777) !== 0o700 ||
      existsSync(retainedApplicationReadinessPath)
    ) {
      throw new Error(
        "retained application readiness must be new under a mode-0700 directory",
      );
    }
  }
  const result = await run({
    retainedBackupContainerPath,
    retainedRestoreEvidencePath,
    retainedApplicationReadinessPath,
  });
  const evidenceArgument = parsedArguments.get("evidence-output");
  if (evidenceArgument !== undefined) {
    const outputPath = path.resolve(evidenceArgument);
    const parentStats = lstatSync(path.dirname(outputPath));
    if (
      path.basename(outputPath) !== "evidence.json" ||
      !parentStats.isDirectory() ||
      (parentStats.mode & 0o777) !== 0o700 ||
      existsSync(outputPath)
    ) {
      throw new Error(
        "evidence output must be a new evidence.json in a mode-0700 directory",
      );
    }
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(outputPath, 0o600);
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    `Hyperia PostgreSQL backup integration failed: ${
      error instanceof Error ? error.message : "unknown failure"
    }`,
  );
  process.exitCode = 1;
}
