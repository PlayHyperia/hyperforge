import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { World } from "@hyperforge/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import { sanitizePublicRecentDuel } from "../streaming/streaming-public-presentation.js";
import { MatchmakingManager } from "../systems/StreamingDuelScheduler/managers/MatchmakingManager.js";
import type { RecentDuelEntry } from "../systems/StreamingDuelScheduler/types.js";
import * as schema from "./schema.js";
import {
  verifyHyperiaPostgresRestoreEvidence,
  type VerifyHyperiaPostgresRestoreEvidenceInput,
} from "./hyperia-postgres-restore-evidence.js";

const { Pool } = pg;

const READINESS_FILE_NAME = "hyperia-restored-duel-application-readiness.json";
const MAX_READINESS_BYTES = 512 * 1024;
const MAX_RECENT_DUELS = 200;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATABASE_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,63}$/u;

type PrivateFileBinding = {
  fileName: string;
  sha256: string;
  bytes: number;
};

export type RestoredApplicationDuelFact = {
  cycleId: string;
  duelId: string;
  finishedAt: number;
  outcome: "win" | "draw" | "cancelled";
  agent1Id: string | null;
  agent2Id: string | null;
  winnerId: string | null;
  winReason: string | null;
  cancellationReason: string | null;
};

export type HyperiaRestoredDuelApplicationProjection = {
  databaseName: string;
  serverVersionNum: string;
  transactionReadOnly: true;
  routeContract: "/api/streaming/leaderboard/details";
  historyLimit: 200;
  recentDuelCount: number;
  projectedCompetitiveDuelCount: number;
  winCount: number;
  drawCount: number;
  cancelledCount: number;
  publicRecentDuelsSha256: string;
  projectedCompetitiveDuelStateSha256: string;
  facts: RestoredApplicationDuelFact[];
};

export type HyperiaRestoredDuelApplicationReadiness = {
  schemaVersion: 1;
  createdAt: string;
  applicationReadinessId: string;
  restoreVerificationId: string;
  releaseSha: string;
  boundaryId: string;
  restoredDatabaseName: string;
  targetServerVersionNum: string;
  restoreEvidence: PrivateFileBinding;
  routeContract: "/api/streaming/leaderboard/details";
  historyLimit: 200;
  recentDuelCount: number;
  projectedCompetitiveDuelCount: number;
  winCount: number;
  drawCount: number;
  cancelledCount: number;
  publicRecentDuelsSha256: string;
  projectedCompetitiveDuelStateSha256: string;
  projectedCompetitiveDuels: RestoredApplicationDuelFact[];
  verificationScope: "restored_hyperia_application_read_projection_only";
  databaseMutationAuthorized: false;
  activationRequiresSeparateApproval: true;
  productionCutoverAuthorized: false;
};

export type InspectHyperiaRestoredDuelApplicationInput = {
  restoredDatabaseName: string;
  queryTimeoutMs: number;
};

export type CreateHyperiaRestoredDuelApplicationReadinessInput =
  VerifyHyperiaPostgresRestoreEvidenceInput & {
    applicationReadinessPath: string;
    now?: () => Date;
    createId?: () => string;
  };

export type VerifyHyperiaRestoredDuelApplicationReadinessInput =
  VerifyHyperiaPostgresRestoreEvidenceInput & {
    applicationReadinessPath: string;
  };

type PgpassIdentity = {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!isRecord(candidate)) return candidate;
    return Object.fromEntries(
      Object.entries(candidate)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function assertPrivateRegularFile(
  filePath: string,
  label: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
) {
  const stats = lstatSync(filePath);
  if (
    !stats.isFile() ||
    stats.size <= 0 ||
    stats.size > maximumBytes ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be a bounded mode-0600 regular file`);
  }
  return stats;
}

function bindPrivateFile(
  filePath: string,
  label: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): PrivateFileBinding {
  const pathStats = assertPrivateRegularFile(filePath, label, maximumBytes);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== pathStats.dev ||
      opened.ino !== pathStats.ino ||
      opened.size !== pathStats.size ||
      (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error(`${label} changed while being hashed`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
    const final = fstatSync(descriptor);
    if (
      bytes !== opened.size ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${label} changed while being hashed`);
    }
    return {
      fileName: path.basename(filePath),
      sha256: hash.digest("hex"),
      bytes,
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parsePgpassLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      if (character !== ":" && character !== "\\") {
        throw new Error("PGPASSFILE contains an invalid escape");
      }
      field += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ":") {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (escaped) throw new Error("PGPASSFILE contains an incomplete escape");
  fields.push(field);
  return fields;
}

function validateApplicationPgEnvironment(databaseName: string): {
  host: string;
  port: number;
  user: string;
  password: () => Promise<string>;
  pgpass: PgpassIdentity;
} {
  for (const forbidden of [
    "PGPASSWORD",
    "DATABASE_URL",
    "POSTGRES_URL",
    "PGSERVICE",
    "PGOPTIONS",
  ]) {
    if (process.env[forbidden]?.trim()) {
      throw new Error(
        "application readiness connection cannot use password-bearing aliases or service overrides",
      );
    }
  }
  const host = process.env.PGHOST?.trim() ?? "";
  const portText = process.env.PGPORT?.trim() ?? "";
  const user = process.env.PGUSER?.trim() ?? "";
  const configuredDatabase = process.env.PGDATABASE?.trim() ?? "";
  const sslMode = process.env.PGSSLMODE?.trim() ?? "";
  const pgpassPath = process.env.PGPASSFILE?.trim() ?? "";
  if (
    !host ||
    host.length > 255 ||
    !/^[0-9]{1,5}$/u.test(portText) ||
    Number(portText) < 1 ||
    Number(portText) > 65_535 ||
    !user ||
    user.length > 63 ||
    configuredDatabase !== databaseName ||
    !DATABASE_NAME_PATTERN.test(databaseName) ||
    !["disable", "require", "verify-ca", "verify-full"].includes(sslMode) ||
    !pgpassPath
  ) {
    throw new Error("application readiness PostgreSQL connection is invalid");
  }
  const stats = assertPrivateRegularFile(pgpassPath, "PGPASSFILE", 64 * 1024);
  const descriptor = openSync(
    pgpassPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error("PGPASSFILE changed while being validated");
    }
    const content = readFileSync(descriptor, "utf8");
    const final = fstatSync(descriptor);
    if (
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("PGPASSFILE changed while being validated");
    }
    const lines = content.split(/\r?\n/u).filter(Boolean);
    const fields = lines.length === 1 ? parsePgpassLine(lines[0]!) : [];
    if (
      fields.length !== 5 ||
      fields[0] !== host ||
      fields[1] !== portText ||
      fields[2] !== databaseName ||
      fields[3] !== user ||
      !fields[4]
    ) {
      throw new Error(
        "PGPASSFILE credential does not exactly match the application readiness connection",
      );
    }
    return {
      host,
      port: Number(portText),
      user,
      password: async () => fields[4]!,
      pgpass: {
        path: pgpassPath,
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        ctimeMs: opened.ctimeMs,
      },
    };
  } finally {
    closeSync(descriptor);
  }
}

function assertPgpassUnchanged(identity: PgpassIdentity): void {
  const stats = lstatSync(identity.path);
  if (
    !stats.isFile() ||
    stats.dev !== identity.dev ||
    stats.ino !== identity.ino ||
    stats.size !== identity.size ||
    stats.mtimeMs !== identity.mtimeMs ||
    stats.ctimeMs !== identity.ctimeMs ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      "PGPASSFILE changed during application readiness inspection",
    );
  }
}

function toApplicationFact(duel: RecentDuelEntry): RestoredApplicationDuelFact {
  return {
    cycleId: duel.cycleId,
    duelId: duel.duelId ?? "",
    finishedAt: duel.finishedAt,
    outcome: duel.outcome,
    agent1Id: duel.agent1Id,
    agent2Id: duel.agent2Id,
    winnerId: duel.winnerId,
    winReason: duel.winReason,
    cancellationReason: duel.cancellationReason,
  };
}

async function projectOnce(
  pool: pg.Pool,
  databaseName: string,
): Promise<HyperiaRestoredDuelApplicationProjection> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const metadata = await client.query<{
      databaseName: string;
      serverVersionNum: string;
      transactionReadOnly: string;
    }>(`SELECT current_database() AS "databaseName",
              current_setting('server_version_num') AS "serverVersionNum",
              current_setting('transaction_read_only') AS "transactionReadOnly"`);
    const database = drizzle(client, { schema });
    // MatchmakingManager imports the same concrete schema at query time, but
    // its legacy default generic is intentionally schema-agnostic.
    const matchmakingDatabase = database as unknown as NodePgDatabase;
    const world = {
      entities: { get: () => undefined },
    } as unknown as World;
    const manager = new MatchmakingManager(world, () => matchmakingDatabase, {
      minAgents: 2,
      maxRecentDuels: MAX_RECENT_DUELS,
      persistStatsToDatabase: true,
      maxAgentStats: 10_000,
      insufficientAgentsRetryInterval: 30_000,
      maxInsufficientAgentWarnings: 5,
    });
    await manager.hydrateRecentDuelsFromDatabase();
    const recentDuels = manager
      .getRecentDuels(MAX_RECENT_DUELS)
      .map(sanitizePublicRecentDuel);
    const byCycleId = new Map(recentDuels.map((duel) => [duel.cycleId, duel]));
    assert(
      byCycleId.size === recentDuels.length,
      "application recent-duel projection contains duplicate cycle identity",
    );
    const competitiveRows =
      recentDuels.length === 0
        ? { rows: [] as { cycleId: string; duelId: string }[] }
        : await client.query<{
            cycleId: string;
            duelId: string;
          }>(
            `SELECT "cycleId", "duelId"
              FROM "streaming_duel_competitive_snapshots"
              WHERE "lifecycleStatus" IN ('terminal', 'retired')
                AND "terminalAt" IS NOT NULL
                AND "cycleId" = ANY($1::text[])
              ORDER BY "cycleId" ASC`,
            [recentDuels.map((duel) => duel.cycleId)],
          );
    const facts = competitiveRows.rows.map((row) => {
      const duel = byCycleId.get(row.cycleId);
      if (
        !duel ||
        duel.duelId !== row.duelId ||
        !duel.duelId ||
        !duel.agent1Id ||
        !duel.agent2Id
      ) {
        throw new Error(
          "application recent-duel projection omitted or changed authoritative competitive identity or participants",
        );
      }
      return toApplicationFact(duel);
    });
    const sortedFacts = [...facts].sort((left, right) =>
      left.cycleId < right.cycleId ? -1 : left.cycleId > right.cycleId ? 1 : 0,
    );
    const meta = metadata.rows[0];
    assert(
      meta?.databaseName === databaseName &&
        /^[0-9]{5,6}$/u.test(meta.serverVersionNum) &&
        meta.transactionReadOnly === "on",
      "application readiness transaction is not bound read-only to the restored database",
    );
    const winCount = recentDuels.filter(
      (duel) => duel.outcome === "win",
    ).length;
    const drawCount = recentDuels.filter(
      (duel) => duel.outcome === "draw",
    ).length;
    const cancelledCount = recentDuels.filter(
      (duel) => duel.outcome === "cancelled",
    ).length;
    assert(
      winCount + drawCount + cancelledCount === recentDuels.length,
      "application recent-duel outcome accounting is invalid",
    );
    await client.query("COMMIT");
    return {
      databaseName: meta.databaseName,
      serverVersionNum: meta.serverVersionNum,
      transactionReadOnly: true,
      routeContract: "/api/streaming/leaderboard/details",
      historyLimit: MAX_RECENT_DUELS,
      recentDuelCount: recentDuels.length,
      projectedCompetitiveDuelCount: sortedFacts.length,
      winCount,
      drawCount,
      cancelledCount,
      publicRecentDuelsSha256: sha256(canonicalJson(recentDuels)),
      projectedCompetitiveDuelStateSha256: sha256(canonicalJson(sortedFacts)),
      facts: sortedFacts,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function inspectHyperiaRestoredDuelApplication(
  input: InspectHyperiaRestoredDuelApplicationInput,
): Promise<HyperiaRestoredDuelApplicationProjection> {
  if (
    !DATABASE_NAME_PATTERN.test(input.restoredDatabaseName) ||
    !Number.isSafeInteger(input.queryTimeoutMs) ||
    input.queryTimeoutMs < 1_000 ||
    input.queryTimeoutMs > 900_000
  ) {
    throw new Error("application readiness inspection input is invalid");
  }
  const connection = validateApplicationPgEnvironment(
    input.restoredDatabaseName,
  );
  const pool = new Pool({
    host: connection.host,
    port: connection.port,
    database: input.restoredDatabaseName,
    user: connection.user,
    password: connection.password,
    max: 1,
    min: 0,
    connectionTimeoutMillis: Math.min(input.queryTimeoutMs, 10_000),
    statement_timeout: input.queryTimeoutMs,
    query_timeout: input.queryTimeoutMs,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
    application_name: "hyperia-restored-duel-application-readiness",
  });
  try {
    const before = await projectOnce(pool, input.restoredDatabaseName);
    const after = await projectOnce(pool, input.restoredDatabaseName);
    if (canonicalJson(before) !== canonicalJson(after)) {
      throw new Error(
        "restored application duel projection changed during readiness inspection",
      );
    }
    assertPgpassUnchanged(connection.pgpass);
    return after;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function parsePrivateFileBinding(value: unknown): PrivateFileBinding | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["fileName", "sha256", "bytes"]) ||
    typeof value.fileName !== "string" ||
    !value.fileName ||
    value.fileName.length > 255 ||
    path.basename(value.fileName) !== value.fileName ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) <= 0
  ) {
    return null;
  }
  return {
    fileName: value.fileName,
    sha256: value.sha256,
    bytes: Number(value.bytes),
  };
}

function parseProjectedCompetitiveDuel(
  value: unknown,
): RestoredApplicationDuelFact | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "cycleId",
      "duelId",
      "finishedAt",
      "outcome",
      "agent1Id",
      "agent2Id",
      "winnerId",
      "winReason",
      "cancellationReason",
    ])
  ) {
    return null;
  }
  const boundedText = (candidate: unknown, max: number): candidate is string =>
    typeof candidate === "string" &&
    candidate.trim() === candidate &&
    candidate.length > 0 &&
    candidate.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(candidate);
  if (
    !boundedText(value.cycleId, 256) ||
    !boundedText(value.duelId, 256) ||
    !Number.isSafeInteger(value.finishedAt) ||
    Number(value.finishedAt) < 0 ||
    (value.outcome !== "win" &&
      value.outcome !== "draw" &&
      value.outcome !== "cancelled") ||
    !boundedText(value.agent1Id, 128) ||
    !boundedText(value.agent2Id, 128) ||
    (value.winnerId !== null && !boundedText(value.winnerId, 128)) ||
    (value.winReason !== null && !boundedText(value.winReason, 64)) ||
    (value.cancellationReason !== null &&
      !boundedText(value.cancellationReason, 64))
  ) {
    return null;
  }
  if (
    (value.outcome === "win" &&
      (value.winnerId === null ||
        ![value.agent1Id, value.agent2Id].includes(value.winnerId) ||
        !["kill", "forfeit", "hp_advantage", "damage_advantage"].includes(
          String(value.winReason),
        ) ||
        value.cancellationReason !== null)) ||
    (value.outcome === "draw" &&
      (value.winnerId !== null ||
        value.winReason !== "draw" ||
        value.cancellationReason !== null)) ||
    (value.outcome === "cancelled" &&
      (value.winnerId !== null ||
        value.winReason !== null ||
        ![
          "insufficient_verified_combat",
          "contestant_unavailable",
          "broadcast_interrupted",
          "no_contest",
        ].includes(String(value.cancellationReason))))
  ) {
    return null;
  }
  return value as RestoredApplicationDuelFact;
}

function parseReadiness(
  value: unknown,
): HyperiaRestoredDuelApplicationReadiness {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "applicationReadinessId",
      "restoreVerificationId",
      "releaseSha",
      "boundaryId",
      "restoredDatabaseName",
      "targetServerVersionNum",
      "restoreEvidence",
      "routeContract",
      "historyLimit",
      "recentDuelCount",
      "projectedCompetitiveDuelCount",
      "winCount",
      "drawCount",
      "cancelledCount",
      "publicRecentDuelsSha256",
      "projectedCompetitiveDuelStateSha256",
      "projectedCompetitiveDuels",
      "verificationScope",
      "databaseMutationAuthorized",
      "activationRequiresSeparateApproval",
      "productionCutoverAuthorized",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.applicationReadinessId !== "string" ||
    !UUID_V4_PATTERN.test(value.applicationReadinessId) ||
    typeof value.restoreVerificationId !== "string" ||
    !UUID_V4_PATTERN.test(value.restoreVerificationId) ||
    typeof value.releaseSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.releaseSha) ||
    typeof value.boundaryId !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{7,63}$/u.test(value.boundaryId) ||
    typeof value.restoredDatabaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.restoredDatabaseName) ||
    typeof value.targetServerVersionNum !== "string" ||
    !/^[0-9]{5,6}$/u.test(value.targetServerVersionNum) ||
    value.routeContract !== "/api/streaming/leaderboard/details" ||
    value.historyLimit !== MAX_RECENT_DUELS ||
    !Number.isSafeInteger(value.recentDuelCount) ||
    Number(value.recentDuelCount) < 0 ||
    Number(value.recentDuelCount) > MAX_RECENT_DUELS ||
    !Number.isSafeInteger(value.projectedCompetitiveDuelCount) ||
    Number(value.projectedCompetitiveDuelCount) < 0 ||
    Number(value.projectedCompetitiveDuelCount) >
      Number(value.recentDuelCount) ||
    !Number.isSafeInteger(value.winCount) ||
    !Number.isSafeInteger(value.drawCount) ||
    !Number.isSafeInteger(value.cancelledCount) ||
    Number(value.winCount) < 0 ||
    Number(value.drawCount) < 0 ||
    Number(value.cancelledCount) < 0 ||
    Number(value.winCount) +
      Number(value.drawCount) +
      Number(value.cancelledCount) !==
      Number(value.recentDuelCount) ||
    typeof value.publicRecentDuelsSha256 !== "string" ||
    !SHA256_PATTERN.test(value.publicRecentDuelsSha256) ||
    typeof value.projectedCompetitiveDuelStateSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectedCompetitiveDuelStateSha256) ||
    !Array.isArray(value.projectedCompetitiveDuels) ||
    value.verificationScope !==
      "restored_hyperia_application_read_projection_only" ||
    value.databaseMutationAuthorized !== false ||
    value.activationRequiresSeparateApproval !== true ||
    value.productionCutoverAuthorized !== false
  ) {
    throw new Error("restored duel application readiness evidence is invalid");
  }
  const restoreEvidence = parsePrivateFileBinding(value.restoreEvidence);
  const projectedCompetitiveDuels = Array.isArray(
    value.projectedCompetitiveDuels,
  )
    ? value.projectedCompetitiveDuels.map(parseProjectedCompetitiveDuel)
    : [];
  if (
    !restoreEvidence ||
    projectedCompetitiveDuels.some((duel) => duel === null) ||
    projectedCompetitiveDuels.length !==
      Number(value.projectedCompetitiveDuelCount) ||
    new Set(projectedCompetitiveDuels.map((duel) => duel?.cycleId)).size !==
      projectedCompetitiveDuels.length ||
    projectedCompetitiveDuels.some(
      (duel, index) =>
        index > 0 &&
        projectedCompetitiveDuels[index - 1]!.cycleId >= duel!.cycleId,
    ) ||
    sha256(canonicalJson(projectedCompetitiveDuels)) !==
      value.projectedCompetitiveDuelStateSha256
  ) {
    throw new Error("restored duel application readiness evidence is invalid");
  }
  return {
    ...(value as Omit<
      HyperiaRestoredDuelApplicationReadiness,
      "restoreEvidence" | "projectedCompetitiveDuels"
    >),
    restoreEvidence,
    projectedCompetitiveDuels:
      projectedCompetitiveDuels as RestoredApplicationDuelFact[],
  };
}

function readPrivateReadiness(filePath: string): unknown {
  const pathStats = assertPrivateRegularFile(
    filePath,
    "restored duel application readiness evidence",
    MAX_READINESS_BYTES,
  );
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== pathStats.dev ||
      opened.ino !== pathStats.ino ||
      opened.size !== pathStats.size
    ) {
      throw new Error(
        "restored duel application readiness evidence changed while being read",
      );
    }
    const bytes = readFileSync(descriptor);
    const final = fstatSync(descriptor);
    if (
      bytes.byteLength !== opened.size ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(
        "restored duel application readiness evidence changed while being read",
      );
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(
        "restored duel application readiness evidence is invalid",
      );
    }
  } finally {
    closeSync(descriptor);
  }
}

async function expectedReadinessFields(
  input: VerifyHyperiaRestoredDuelApplicationReadinessInput,
) {
  const restore = await verifyHyperiaPostgresRestoreEvidence(input);
  const projection = await inspectHyperiaRestoredDuelApplication({
    restoredDatabaseName: input.restoredDatabaseName,
    queryTimeoutMs: input.queryTimeoutMs,
  });
  if (
    projection.databaseName !== restore.restoredDatabaseName ||
    projection.serverVersionNum !== restore.targetServerVersionNum
  ) {
    throw new Error(
      "restored application projection does not match restore evidence identity",
    );
  }
  return {
    restoreCreatedAt: restore.createdAt,
    fields: {
      restoreVerificationId: restore.restoreVerificationId,
      releaseSha: restore.releaseSha,
      boundaryId: restore.boundaryId,
      restoredDatabaseName: restore.restoredDatabaseName,
      targetServerVersionNum: restore.targetServerVersionNum,
      restoreEvidence: bindPrivateFile(
        input.restoreEvidencePath,
        "PostgreSQL restore evidence",
        MAX_READINESS_BYTES,
      ),
      routeContract: projection.routeContract,
      historyLimit: projection.historyLimit,
      recentDuelCount: projection.recentDuelCount,
      projectedCompetitiveDuelCount: projection.projectedCompetitiveDuelCount,
      winCount: projection.winCount,
      drawCount: projection.drawCount,
      cancelledCount: projection.cancelledCount,
      publicRecentDuelsSha256: projection.publicRecentDuelsSha256,
      projectedCompetitiveDuelStateSha256:
        projection.projectedCompetitiveDuelStateSha256,
      projectedCompetitiveDuels: projection.facts,
      verificationScope:
        "restored_hyperia_application_read_projection_only" as const,
      databaseMutationAuthorized: false as const,
      activationRequiresSeparateApproval: true as const,
      productionCutoverAuthorized: false as const,
    },
  };
}

function resolveNewReadinessPath(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  if (path.basename(absolutePath) !== READINESS_FILE_NAME) {
    throw new Error(
      `restored duel application readiness evidence must be named ${READINESS_FILE_NAME}`,
    );
  }
  if (existsSync(absolutePath)) {
    throw new Error(
      "restored duel application readiness evidence already exists",
    );
  }
  const parent = lstatSync(path.dirname(absolutePath));
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) {
    throw new Error(
      "restored duel application readiness evidence parent must be mode-0700",
    );
  }
  return absolutePath;
}

function fsyncParent(filePath: string): void {
  const descriptor = openSync(path.dirname(filePath), "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateReadiness(
  filePath: string,
  evidence: HyperiaRestoredDuelApplicationReadiness,
): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    chmodSync(filePath, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  fsyncParent(filePath);
}

export async function createHyperiaRestoredDuelApplicationReadiness(
  input: CreateHyperiaRestoredDuelApplicationReadinessInput,
): Promise<HyperiaRestoredDuelApplicationReadiness> {
  const applicationReadinessPath = resolveNewReadinessPath(
    input.applicationReadinessPath,
  );
  const expected = await expectedReadinessFields(input);
  const applicationReadinessId = (input.createId ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(applicationReadinessId)) {
    throw new Error("restored duel application readiness ID is invalid");
  }
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  if (
    !isCanonicalIsoTimestamp(expected.restoreCreatedAt) ||
    Date.parse(createdAt) < Date.parse(expected.restoreCreatedAt)
  ) {
    throw new Error("restored duel application readiness clock regressed");
  }
  const evidence: HyperiaRestoredDuelApplicationReadiness = {
    schemaVersion: 1,
    createdAt,
    applicationReadinessId,
    ...expected.fields,
  };
  writePrivateReadiness(applicationReadinessPath, evidence);
  try {
    return await verifyHyperiaRestoredDuelApplicationReadiness(input);
  } catch (error) {
    unlinkSync(applicationReadinessPath);
    fsyncParent(applicationReadinessPath);
    throw error;
  }
}

export async function verifyHyperiaRestoredDuelApplicationReadiness(
  input: VerifyHyperiaRestoredDuelApplicationReadinessInput,
): Promise<HyperiaRestoredDuelApplicationReadiness> {
  const applicationReadinessPath = path.resolve(input.applicationReadinessPath);
  if (path.basename(applicationReadinessPath) !== READINESS_FILE_NAME) {
    throw new Error(
      `restored duel application readiness evidence must be named ${READINESS_FILE_NAME}`,
    );
  }
  const evidence = parseReadiness(
    readPrivateReadiness(applicationReadinessPath),
  );
  const expected = (await expectedReadinessFields(input)).fields;
  const observed = {
    restoreVerificationId: evidence.restoreVerificationId,
    releaseSha: evidence.releaseSha,
    boundaryId: evidence.boundaryId,
    restoredDatabaseName: evidence.restoredDatabaseName,
    targetServerVersionNum: evidence.targetServerVersionNum,
    restoreEvidence: evidence.restoreEvidence,
    routeContract: evidence.routeContract,
    historyLimit: evidence.historyLimit,
    recentDuelCount: evidence.recentDuelCount,
    projectedCompetitiveDuelCount: evidence.projectedCompetitiveDuelCount,
    winCount: evidence.winCount,
    drawCount: evidence.drawCount,
    cancelledCount: evidence.cancelledCount,
    publicRecentDuelsSha256: evidence.publicRecentDuelsSha256,
    projectedCompetitiveDuelStateSha256:
      evidence.projectedCompetitiveDuelStateSha256,
    projectedCompetitiveDuels: evidence.projectedCompetitiveDuels,
    verificationScope: evidence.verificationScope,
    databaseMutationAuthorized: evidence.databaseMutationAuthorized,
    activationRequiresSeparateApproval:
      evidence.activationRequiresSeparateApproval,
    productionCutoverAuthorized: evidence.productionCutoverAuthorized,
  };
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error(
      "restored duel application readiness evidence does not match current state",
    );
  }
  return evidence;
}
