import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import pg from "pg";

const { Client } = pg;

const ACTIVE_ROOT_NAME = "active";
const BACKUP_FILE_NAME = "hyperia-postgres.dump";
const EVIDENCE_FILE_NAME = "evidence.json";
const MAX_EVIDENCE_BYTES = 128 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_QUERY_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_DUMP_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BOUNDARY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,63}$/u;
const DATABASE_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,63}$/u;
const MIGRATION_TAG_PATTERN = /^[0-9]{4}_[a-z0-9_]+$/u;
const PG_TOOL_VERSION_PATTERN =
  /^pg_(?:dump|restore) \(PostgreSQL\) [0-9][0-9A-Za-z.+-]{0,63}(?: \([^\r\n\u0000]{1,128}\))?$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const HYPERIA_RECOVERY_TABLES = [
  "action_bar_storage",
  "activity_log",
  "agent_autonomy_checkpoints",
  "agent_autonomy_lifecycle_events",
  "agent_autonomy_lifecycle_heads",
  "agent_autonomy_progression_events",
  "agent_autonomy_progression_heads",
  "agent_bank_operation_items",
  "agent_bank_operations",
  "agent_credential_sessions",
  "agent_duel_stats",
  "agent_mappings",
  "agent_store_operations",
  "agent_thoughts",
  "anti_cheat_violations",
  "bank_placeholders",
  "bank_storage",
  "bank_tabs",
  "bone_burial_operations",
  "character_templates",
  "characters",
  "chunk_activity",
  "combat_stat_events",
  "config",
  "distributed_rate_limit_buckets",
  "duel_settlements",
  "entities",
  "equipment",
  "failed_transactions",
  "friend_requests",
  "friendships",
  "gathering_resource_states",
  "ignore_list",
  "inventory",
  "items",
  "layout_presets",
  "npc_kills",
  "onchain_outbox",
  "operations_log",
  "player_combat_stats",
  "player_deaths",
  "player_sessions",
  "processing_active_fires",
  "quest_audit_log",
  "quest_gathering_progress_receipts",
  "quest_processing_progress_receipts",
  "quest_kill_progress_receipts",
  "quest_progress",
  "retired_arena_integration_records",
  "solana_agent_auth_challenges",
  "storage",
  "streaming_duel_action_observation_heads",
  "streaming_duel_action_observations",
  "streaming_duel_bank_open_events",
  "streaming_duel_competitive_snapshots",
  "streaming_duel_history",
  "streaming_duel_preparation_unavailability_reports",
  "streaming_duel_preparations",
  "streaming_duel_transition_events",
  "streaming_scheduler_leases",
  "trades",
  "user_bans",
  "users",
  "world_chunks",
] as const;

type RecoveryTable = (typeof HYPERIA_RECOVERY_TABLES)[number];

export type PostgresBackupToolResult = {
  version: string;
  stdout: string;
};

export type HyperiaPostgresBackupTooling = {
  dump(input: {
    snapshotId: string;
    databaseName: string;
    destinationPath: string;
    timeoutMs: number;
  }): Promise<PostgresBackupToolResult>;
  list(input: {
    backupPath: string;
    timeoutMs: number;
  }): Promise<PostgresBackupToolResult>;
};

export type HyperiaPostgresBackupEvidence = {
  schemaVersion: 1;
  createdAt: string;
  backupId: string;
  releaseSha: string;
  boundaryId: string;
  databaseName: string;
  serverVersionNum: string;
  databaseEncoding: string;
  snapshotIsolation: "repeatable_read_read_only_exported_snapshot";
  verificationScope: "postgres_snapshot_dump_only";
  quiescentBoundaryWitnessRequired: true;
  restoreCompatibilityApprovalRequired: true;
  sourceMigrationJournalSha256: string;
  sourceMigrationCount: number;
  sourceLatestMigrationTag: string;
  databaseMigrationJournalSha256: string;
  schemaSha256: string;
  schemaObjectCounts: {
    relations: number;
    columns: number;
    constraints: number;
    indexes: number;
    triggers: number;
    functions: number;
  };
  recoveryTableCounts: Record<RecoveryTable, string>;
  recoveryTableSha256s: Record<RecoveryTable, string>;
  backupFileName: typeof BACKUP_FILE_NAME;
  backupSha256: string;
  backupBytes: number;
  tocSha256: string;
  tocEntries: number;
  pgDumpVersion: string;
  pgRestoreVersionAtCreate: string;
};

type CreateHyperiaPostgresBackupInput = {
  destinationContainerPath: string;
  releaseSha: string;
  boundaryId: string;
  expectedDatabaseName: string;
  queryTimeoutMs: number;
  dumpTimeoutMs: number;
  tooling?: HyperiaPostgresBackupTooling;
  migrationsDirectory?: string;
  now?: () => Date;
  createId?: () => string;
  beforePublish?: () => void | Promise<void>;
};

type VerifyHyperiaPostgresBackupInput = {
  backupRootPath: string;
  expectedReleaseSha: string;
  expectedBoundaryId: string;
  expectedDatabaseName: string;
  toolTimeoutMs: number;
  tooling?: HyperiaPostgresBackupTooling;
  migrationsDirectory?: string;
};

export type VerifyHyperiaPostgresRestoreInput = {
  backupRootPath: string;
  expectedReleaseSha: string;
  expectedBoundaryId: string;
  sourceDatabaseName: string;
  restoredDatabaseName: string;
  approvedTargetServerVersionNum: string;
  queryTimeoutMs: number;
  toolTimeoutMs: number;
  tooling?: HyperiaPostgresBackupTooling;
  migrationsDirectory?: string;
};

export type HyperiaPostgresRestoreVerification = {
  sourceEvidence: HyperiaPostgresBackupEvidence;
  restoredDatabaseName: string;
  targetServerVersionNum: string;
  inspection: HyperiaPostgresRecoveryInspection;
  verificationScope: "isolated_postgres_restore_only";
  activationRequiresSeparateApproval: true;
};

type CanonicalToc = {
  sha256: string;
  entries: number;
};

type SourceMigration = {
  tag: string;
  when: string;
  hash: string;
};

type SourceMigrationJournal = {
  sha256: string;
  migrations: SourceMigration[];
};

type SnapshotInspection = Pick<
  HyperiaPostgresBackupEvidence,
  | "serverVersionNum"
  | "databaseEncoding"
  | "databaseMigrationJournalSha256"
  | "schemaSha256"
  | "schemaObjectCounts"
  | "recoveryTableCounts"
  | "recoveryTableSha256s"
>;

export type HyperiaPostgresRecoveryInspection = SnapshotInspection;

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

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function assertReleaseSha(value: string): string {
  const normalized = value.trim();
  if (!RELEASE_SHA_PATTERN.test(normalized)) {
    throw new Error("release SHA must be one full lowercase commit SHA");
  }
  return normalized;
}

function assertBoundaryId(value: string): string {
  const normalized = value.trim();
  if (!BOUNDARY_ID_PATTERN.test(normalized)) {
    throw new Error("boundary ID must be 8-64 lowercase non-secret characters");
  }
  return normalized;
}

function assertDatabaseName(value: string): string {
  const normalized = value.trim();
  if (!DATABASE_NAME_PATTERN.test(normalized)) {
    throw new Error("expected database name is invalid");
  }
  return normalized;
}

function assertTimeout(
  value: number,
  label: string,
  maximumMs: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > maximumMs
  ) {
    throw new Error(`${label} is outside the supported bounded range`);
  }
  return value;
}

function assertPrivateFile(
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

function assertPrivateDirectory(directoryPath: string, label: string): void {
  const stats = lstatSync(directoryPath);
  if (!stats.isDirectory() || (stats.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must be a mode-0700 directory`);
  }
}

function fsyncDirectory(directoryPath: string): void {
  const descriptor = openSync(directoryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hashPrivateFile(
  filePath: string,
  label: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): { sha256: string; bytes: number } {
  const pathStats = assertPrivateFile(filePath, label, maximumBytes);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = fstatSync(descriptor);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.size !== pathStats.size ||
      (openedStats.mode & 0o777) !== 0o600
    ) {
      throw new Error(`${label} changed while it was being hashed`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      bytes += read;
      hash.update(buffer.subarray(0, read));
    }
    const finalStats = fstatSync(descriptor);
    if (
      bytes !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      throw new Error(`${label} changed while it was being hashed`);
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    chmodSync(filePath, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function readPrivateJson(filePath: string, maximumBytes: number): unknown {
  const pathStats = assertPrivateFile(
    filePath,
    "PostgreSQL backup evidence",
    maximumBytes,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = fstatSync(descriptor);
    if (
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.size !== pathStats.size ||
      (openedStats.mode & 0o777) !== 0o600
    ) {
      throw new Error("PostgreSQL backup evidence changed while being read");
    }
    const contents = readFileSync(descriptor);
    const finalStats = fstatSync(descriptor);
    if (
      contents.byteLength !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      (finalStats.mode & 0o777) !== 0o600 ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      throw new Error("PostgreSQL backup evidence changed while being read");
    }
    return JSON.parse(contents.toString("utf8"));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function readStablePrivateCredentialFile(filePath: string): Buffer {
  const pathStats = assertPrivateFile(filePath, "PGPASSFILE", 64 * 1024);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = fstatSync(descriptor);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.size !== pathStats.size ||
      (openedStats.mode & 0o777) !== 0o600
    ) {
      throw new Error("PGPASSFILE changed while it was being validated");
    }
    const contents = readFileSync(descriptor);
    const finalStats = fstatSync(descriptor);
    if (
      contents.byteLength !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      (finalStats.mode & 0o777) !== 0o600 ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      throw new Error("PGPASSFILE changed while it was being validated");
    }
    return contents;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function requireExactEntries(
  directoryPath: string,
  expected: readonly string[],
  label: string,
): void {
  const observed = readdirSync(directoryPath).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
    throw new Error(`${label} contains unexpected entries`);
  }
}

function resolveDestinationContainer(destinationPath: string): string {
  const absolutePath = path.resolve(destinationPath);
  const name = path.basename(absolutePath);
  if (!name || name === "." || name === ".." || name.length > 128) {
    throw new Error("PostgreSQL backup destination has an invalid name");
  }
  if (existsSync(absolutePath)) {
    throw new Error("PostgreSQL backup destination already exists");
  }
  if (!lstatSync(path.dirname(absolutePath)).isDirectory()) {
    throw new Error("PostgreSQL backup parent must be a directory");
  }
  return absolutePath;
}

function resolveConnectionEnvironment(expectedDatabaseName: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  if (
    process.env.PGPASSWORD ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.PGSERVICE ||
    process.env.PGOPTIONS
  ) {
    throw new Error(
      "backup connection must use explicit PG variables and PGPASSFILE without password-bearing aliases",
    );
  }
  const host = process.env.PGHOST?.trim() ?? "";
  const user = process.env.PGUSER?.trim() ?? "";
  const database = process.env.PGDATABASE?.trim() ?? "";
  const port = Number(process.env.PGPORT);
  const passwordFile = process.env.PGPASSFILE?.trim() ?? "";
  if (
    !host ||
    host.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(host) ||
    !DATABASE_NAME_PATTERN.test(user) ||
    database !== expectedDatabaseName ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port > 65_535 ||
    !path.isAbsolute(passwordFile)
  ) {
    throw new Error("backup PostgreSQL connection variables are invalid");
  }
  const passwordContents = readStablePrivateCredentialFile(passwordFile);
  const text = passwordContents.toString("utf8");
  if (
    !Buffer.from(text, "utf8").equals(passwordContents) ||
    text.includes("\r") ||
    text.includes("\0") ||
    !text.endsWith("\n") ||
    text.slice(0, -1).includes("\n")
  ) {
    throw new Error("PGPASSFILE must contain one canonical credential entry");
  }
  const fields: string[] = [];
  let field = "";
  let escaping = false;
  for (const character of text.slice(0, -1)) {
    if (escaping) {
      if (character !== ":" && character !== "\\") {
        throw new Error("PGPASSFILE contains an invalid escape");
      }
      field += character;
      escaping = false;
    } else if (character === "\\") {
      escaping = true;
    } else if (character === ":") {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (escaping) {
    throw new Error("PGPASSFILE contains an incomplete escape");
  }
  fields.push(field);
  const [passwordHost, passwordPort, passwordDatabase, passwordUser, password] =
    fields;
  if (
    fields.length !== 5 ||
    passwordHost !== host ||
    passwordPort !== String(port) ||
    passwordDatabase !== database ||
    passwordUser !== user ||
    !password ||
    password.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(password)
  ) {
    throw new Error(
      "PGPASSFILE credential does not exactly match the connection",
    );
  }
  return { host, port, database, user, password };
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "LANG",
    "LC_ALL",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSFILE",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "PGSSLCERT",
    "PGSSLKEY",
    "PGCHANNELBINDING",
    "PGTARGETSESSIONATTRS",
  ] as const;
  return Object.fromEntries(
    names.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
}

async function runBoundedCommand(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("PostgreSQL backup tool timed out"));
      }
    }, timeoutMs);
    const capture = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_TOOL_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("PostgreSQL backup tool output exceeded its bound"));
        }
        return;
      }
      stdout.push(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_TOOL_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("PostgreSQL backup tool could not start"));
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || bytes > MAX_TOOL_OUTPUT_BYTES) {
        reject(new Error("PostgreSQL backup tool failed"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function toolVersion(executable: string, timeoutMs: number) {
  const value = (
    await runBoundedCommand(
      executable,
      ["--version"],
      timeoutMs,
      commandEnvironment(),
    )
  ).trim();
  if (!PG_TOOL_VERSION_PATTERN.test(value)) {
    throw new Error("PostgreSQL backup tool version is invalid");
  }
  return value;
}

export function createLocalPostgresBackupTooling(
  input: {
    pgDumpExecutable?: string;
    pgRestoreExecutable?: string;
  } = {},
): HyperiaPostgresBackupTooling {
  const pgDumpExecutable = input.pgDumpExecutable ?? "pg_dump";
  const pgRestoreExecutable = input.pgRestoreExecutable ?? "pg_restore";
  return {
    async dump({ snapshotId, databaseName, destinationPath, timeoutMs }) {
      const version = await toolVersion(pgDumpExecutable, timeoutMs);
      await runBoundedCommand(
        pgDumpExecutable,
        [
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          `--snapshot=${snapshotId}`,
          `--file=${destinationPath}`,
          `--dbname=${databaseName}`,
        ],
        timeoutMs,
        commandEnvironment(),
      );
      return { version, stdout: "" };
    },
    async list({ backupPath, timeoutMs }) {
      const version = await toolVersion(pgRestoreExecutable, timeoutMs);
      const stdout = await runBoundedCommand(
        pgRestoreExecutable,
        ["--list", backupPath],
        timeoutMs,
        commandEnvironment(),
      );
      return { version, stdout };
    },
  };
}

function canonicalizeToc(value: string): CanonicalToc {
  if (Buffer.byteLength(value, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    throw new Error("PostgreSQL archive TOC exceeded its bound");
  }
  const lines = value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith(";"));
  if (lines.length === 0 || lines.length > 100_000) {
    throw new Error("PostgreSQL archive TOC is empty or excessive");
  }
  return {
    sha256: createHash("sha256").update(lines.join("\n")).digest("hex"),
    entries: lines.length,
  };
}

function loadSourceMigrationJournal(
  migrationsDirectory: string,
): SourceMigrationJournal {
  const journalPath = path.join(migrationsDirectory, "meta/_journal.json");
  const journalBytes = readFileSync(journalPath);
  const value: unknown = JSON.parse(journalBytes.toString("utf8"));
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("source migration journal is invalid");
  }
  const migrations = value.entries.map((entry): SourceMigration => {
    if (
      !isRecord(entry) ||
      typeof entry.tag !== "string" ||
      !MIGRATION_TAG_PATTERN.test(entry.tag) ||
      !Number.isSafeInteger(entry.when) ||
      Number(entry.when) <= 0
    ) {
      throw new Error("source migration journal is invalid");
    }
    const sql = readFileSync(
      path.join(migrationsDirectory, `${entry.tag}.sql`),
    );
    return {
      tag: entry.tag,
      when: String(entry.when),
      hash: createHash("sha256").update(sql).digest("hex"),
    };
  });
  if (migrations.length === 0) {
    throw new Error("source migration journal is empty");
  }
  const journalSha256 = createHash("sha256").update(journalBytes).digest("hex");
  return {
    sha256: createHash("sha256")
      .update(JSON.stringify({ journalSha256, migrations }))
      .digest("hex"),
    migrations,
  };
}

async function configureCanonicalInspectionSession(client: pg.Client) {
  await client.query(`
    SET LOCAL TIME ZONE 'UTC';
    SET LOCAL DateStyle TO 'ISO, YMD';
    SET LOCAL IntervalStyle TO 'iso_8601';
    SET LOCAL extra_float_digits TO 3;
    SET LOCAL bytea_output TO 'hex'
  `);
}

async function inspectRecoveryTable(
  client: pg.Client,
  tableName: RecoveryTable,
  ordinal: number,
): Promise<{ count: string; sha256: string }> {
  const cursorName = `hyperia_recovery_hash_${ordinal}`;
  const hash = createHash("sha256");
  hash.update(`hyperia_postgres_table_v1\u0000${tableName}\u0000`);
  let rowCount = 0n;
  await client.query(
    `DECLARE "${cursorName}" NO SCROLL CURSOR FOR
       SELECT to_jsonb(t)::text AS row_json
         FROM "public"."${tableName}" AS t
        ORDER BY to_jsonb(t)::text COLLATE "C"`,
  );
  try {
    for (;;) {
      const batch = await client.query<{ row_json: string }>(
        `FETCH FORWARD 1000 FROM "${cursorName}"`,
      );
      if (batch.rows.length === 0) break;
      for (const row of batch.rows) {
        if (typeof row.row_json !== "string") {
          throw new Error(
            `required recovery table row is invalid: ${tableName}`,
          );
        }
        const bytes = Buffer.from(row.row_json, "utf8");
        const length = Buffer.allocUnsafe(8);
        length.writeBigUInt64BE(BigInt(bytes.byteLength));
        hash.update(length);
        hash.update(bytes);
        rowCount += 1n;
      }
    }
  } finally {
    await client.query(`CLOSE "${cursorName}"`).catch(() => undefined);
  }
  return { count: rowCount.toString(), sha256: hash.digest("hex") };
}

async function inspectSnapshot(
  client: pg.Client,
  sourceJournal: SourceMigrationJournal,
): Promise<SnapshotInspection> {
  await configureCanonicalInspectionSession(client);
  const metadata = await client.query<{
    database_name: string;
    server_version_num: string;
    database_encoding: string;
  }>(`
    SELECT current_database() AS database_name,
           current_setting('server_version_num') AS server_version_num,
           pg_encoding_to_char(encoding) AS database_encoding
      FROM pg_database
     WHERE datname = current_database()
  `);
  const metadataRow = metadata.rows[0];
  if (
    !metadataRow ||
    !/^[0-9]{5,6}$/u.test(metadataRow.server_version_num) ||
    !/^[A-Z0-9_-]{1,32}$/u.test(metadataRow.database_encoding)
  ) {
    throw new Error("PostgreSQL database metadata is invalid");
  }

  const journalRelations = await client.query<{
    schema_name: string;
    table_name: string;
  }>(`
    SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r'
       AND c.relname = '__drizzle_migrations'
       AND n.nspname IN ('public', 'drizzle')
     ORDER BY n.nspname
  `);
  if (journalRelations.rows.length !== 1) {
    throw new Error("exactly one Drizzle migration journal is required");
  }
  const journalRelation = journalRelations.rows[0];
  const journalName =
    journalRelation.schema_name === "drizzle"
      ? '"drizzle"."__drizzle_migrations"'
      : '"public"."__drizzle_migrations"';
  const databaseJournal = await client.query<{
    hash: string;
    created_at: string;
  }>(`SELECT hash, created_at::text FROM ${journalName} ORDER BY id`);
  if (databaseJournal.rows.length !== sourceJournal.migrations.length) {
    throw new Error("database migration count does not match source");
  }
  for (let index = 0; index < sourceJournal.migrations.length; index += 1) {
    const expected = sourceJournal.migrations[index];
    const observed = databaseJournal.rows[index];
    if (
      !observed ||
      observed.hash !== expected.hash ||
      observed.created_at !== expected.when
    ) {
      throw new Error(
        `database migration journal does not match source at ordinal ${index + 1} (${expected.tag}; hash=${observed?.hash === expected.hash ? "match" : "mismatch"}; timestamp=${observed?.created_at === expected.when ? "match" : "mismatch"})`,
      );
    }
  }
  const databaseMigrationJournalSha256 = createHash("sha256")
    .update(JSON.stringify(databaseJournal.rows))
    .digest("hex");

  const schemaSections: Array<[string, unknown[]]> = [];
  const schemaQueries = [
    [
      "relations",
      `SELECT c.relkind, c.relname
         FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
        ORDER BY c.relkind, c.relname`,
    ],
    [
      "columns",
      `SELECT table_name, column_name, ordinal_position, data_type, udt_name,
              is_nullable, column_default, identity_generation, is_generated,
              generation_expression, collation_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`,
    ],
    [
      "constraints",
      `SELECT c.relname AS table_name, con.conname,
              pg_get_constraintdef(con.oid, true) AS definition
         FROM pg_constraint AS con
         JOIN pg_class AS c ON c.oid = con.conrelid
         JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
        ORDER BY c.relname, con.conname`,
    ],
    [
      "indexes",
      `SELECT c.relname AS table_name, i.relname AS index_name,
              pg_get_indexdef(i.oid) AS definition
         FROM pg_index AS x
         JOIN pg_class AS c ON c.oid = x.indrelid
         JOIN pg_class AS i ON i.oid = x.indexrelid
         JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
        ORDER BY c.relname, i.relname`,
    ],
    [
      "triggers",
      `SELECT c.relname AS table_name, t.tgname,
              pg_get_triggerdef(t.oid, true) AS definition
         FROM pg_trigger AS t
         JOIN pg_class AS c ON c.oid = t.tgrelid
         JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
        ORDER BY c.relname, t.tgname`,
    ],
    [
      "functions",
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
              pg_get_functiondef(p.oid) AS definition
         FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
        ORDER BY p.proname, arguments`,
    ],
  ] as const;
  for (const [name, query] of schemaQueries) {
    schemaSections.push([name, (await client.query(query)).rows]);
  }
  const schemaSha256 = createHash("sha256")
    .update(JSON.stringify(schemaSections))
    .digest("hex");
  const schemaObjectCounts = {
    relations: schemaSections[0]?.[1].length ?? 0,
    columns: schemaSections[1]?.[1].length ?? 0,
    constraints: schemaSections[2]?.[1].length ?? 0,
    indexes: schemaSections[3]?.[1].length ?? 0,
    triggers: schemaSections[4]?.[1].length ?? 0,
    functions: schemaSections[5]?.[1].length ?? 0,
  };
  if (Object.values(schemaObjectCounts).some((count) => count <= 0)) {
    throw new Error("PostgreSQL schema inspection is incomplete");
  }

  const recoveryTableCounts = {} as Record<RecoveryTable, string>;
  const recoveryTableSha256s = {} as Record<RecoveryTable, string>;
  const publicTables = await client.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname
  `);
  if (
    JSON.stringify(publicTables.rows.map((row) => row.table_name)) !==
    JSON.stringify(HYPERIA_RECOVERY_TABLES)
  ) {
    throw new Error(
      "public PostgreSQL table inventory does not match recovery policy",
    );
  }
  for (const [ordinal, tableName] of HYPERIA_RECOVERY_TABLES.entries()) {
    const table = await inspectRecoveryTable(client, tableName, ordinal);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(table.count)) {
      throw new Error(`required recovery table count is invalid: ${tableName}`);
    }
    recoveryTableCounts[tableName] = table.count;
    recoveryTableSha256s[tableName] = table.sha256;
  }
  return {
    serverVersionNum: metadataRow.server_version_num,
    databaseEncoding: metadataRow.database_encoding,
    databaseMigrationJournalSha256,
    schemaSha256,
    schemaObjectCounts,
    recoveryTableCounts,
    recoveryTableSha256s,
  };
}

export async function inspectHyperiaPostgresRecoveryState(
  client: pg.Client,
  migrationsDirectory = path.join(import.meta.dirname, "migrations"),
): Promise<HyperiaPostgresRecoveryInspection> {
  return await inspectSnapshot(
    client,
    loadSourceMigrationJournal(migrationsDirectory),
  );
}

function parseEvidence(value: unknown): HyperiaPostgresBackupEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "backupId",
      "releaseSha",
      "boundaryId",
      "databaseName",
      "serverVersionNum",
      "databaseEncoding",
      "snapshotIsolation",
      "verificationScope",
      "quiescentBoundaryWitnessRequired",
      "restoreCompatibilityApprovalRequired",
      "sourceMigrationJournalSha256",
      "sourceMigrationCount",
      "sourceLatestMigrationTag",
      "databaseMigrationJournalSha256",
      "schemaSha256",
      "schemaObjectCounts",
      "recoveryTableCounts",
      "recoveryTableSha256s",
      "backupFileName",
      "backupSha256",
      "backupBytes",
      "tocSha256",
      "tocEntries",
      "pgDumpVersion",
      "pgRestoreVersionAtCreate",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.backupId !== "string" ||
    !UUID_V4_PATTERN.test(value.backupId) ||
    typeof value.releaseSha !== "string" ||
    !RELEASE_SHA_PATTERN.test(value.releaseSha) ||
    typeof value.boundaryId !== "string" ||
    !BOUNDARY_ID_PATTERN.test(value.boundaryId) ||
    typeof value.databaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.databaseName) ||
    typeof value.serverVersionNum !== "string" ||
    !/^[0-9]{5,6}$/u.test(value.serverVersionNum) ||
    typeof value.databaseEncoding !== "string" ||
    !/^[A-Z0-9_-]{1,32}$/u.test(value.databaseEncoding) ||
    value.snapshotIsolation !== "repeatable_read_read_only_exported_snapshot" ||
    value.verificationScope !== "postgres_snapshot_dump_only" ||
    value.quiescentBoundaryWitnessRequired !== true ||
    value.restoreCompatibilityApprovalRequired !== true ||
    typeof value.sourceMigrationJournalSha256 !== "string" ||
    !SHA256_PATTERN.test(value.sourceMigrationJournalSha256) ||
    !Number.isSafeInteger(value.sourceMigrationCount) ||
    Number(value.sourceMigrationCount) <= 0 ||
    typeof value.sourceLatestMigrationTag !== "string" ||
    !MIGRATION_TAG_PATTERN.test(value.sourceLatestMigrationTag) ||
    typeof value.databaseMigrationJournalSha256 !== "string" ||
    !SHA256_PATTERN.test(value.databaseMigrationJournalSha256) ||
    typeof value.schemaSha256 !== "string" ||
    !SHA256_PATTERN.test(value.schemaSha256) ||
    !isRecord(value.schemaObjectCounts) ||
    !hasExactKeys(value.schemaObjectCounts, [
      "relations",
      "columns",
      "constraints",
      "indexes",
      "triggers",
      "functions",
    ]) ||
    Object.values(value.schemaObjectCounts).some(
      (count) => !Number.isSafeInteger(count) || Number(count) <= 0,
    ) ||
    !isRecord(value.recoveryTableCounts) ||
    !hasExactKeys(value.recoveryTableCounts, HYPERIA_RECOVERY_TABLES) ||
    Object.values(value.recoveryTableCounts).some(
      (count) =>
        typeof count !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(count),
    ) ||
    !isRecord(value.recoveryTableSha256s) ||
    !hasExactKeys(value.recoveryTableSha256s, HYPERIA_RECOVERY_TABLES) ||
    Object.values(value.recoveryTableSha256s).some(
      (hash) => typeof hash !== "string" || !SHA256_PATTERN.test(hash),
    ) ||
    value.backupFileName !== BACKUP_FILE_NAME ||
    typeof value.backupSha256 !== "string" ||
    !SHA256_PATTERN.test(value.backupSha256) ||
    !Number.isSafeInteger(value.backupBytes) ||
    Number(value.backupBytes) <= 0 ||
    typeof value.tocSha256 !== "string" ||
    !SHA256_PATTERN.test(value.tocSha256) ||
    !Number.isSafeInteger(value.tocEntries) ||
    Number(value.tocEntries) <= 0 ||
    typeof value.pgDumpVersion !== "string" ||
    !PG_TOOL_VERSION_PATTERN.test(value.pgDumpVersion) ||
    typeof value.pgRestoreVersionAtCreate !== "string" ||
    !PG_TOOL_VERSION_PATTERN.test(value.pgRestoreVersionAtCreate)
  ) {
    throw new Error("PostgreSQL backup evidence is invalid");
  }
  return value as HyperiaPostgresBackupEvidence;
}

export async function createHyperiaPostgresBackup(
  input: CreateHyperiaPostgresBackupInput,
): Promise<HyperiaPostgresBackupEvidence> {
  const releaseSha = assertReleaseSha(input.releaseSha);
  const boundaryId = assertBoundaryId(input.boundaryId);
  const databaseName = assertDatabaseName(input.expectedDatabaseName);
  const queryTimeoutMs = assertTimeout(
    input.queryTimeoutMs,
    "query timeout",
    MAX_QUERY_TIMEOUT_MS,
  );
  const dumpTimeoutMs = assertTimeout(
    input.dumpTimeoutMs,
    "dump timeout",
    MAX_DUMP_TIMEOUT_MS,
  );
  const connection = resolveConnectionEnvironment(databaseName);
  const destinationContainerPath = resolveDestinationContainer(
    input.destinationContainerPath,
  );
  const sourceJournal = loadSourceMigrationJournal(
    input.migrationsDirectory ?? path.join(import.meta.dirname, "migrations"),
  );
  const backupId = (input.createId ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(backupId)) {
    throw new Error("PostgreSQL backup ID generator returned an invalid UUID");
  }
  const tooling = input.tooling ?? createLocalPostgresBackupTooling();
  const stagingPath = path.join(
    destinationContainerPath,
    `.staging-${backupId}`,
  );
  const activePath = path.join(destinationContainerPath, ACTIVE_ROOT_NAME);
  let ownsDestination = false;
  const client = new Client({
    ...connection,
    application_name: "hyperia_backup_snapshot_v1",
    connectionTimeoutMillis: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
    query_timeout: queryTimeoutMs,
  });
  let transactionOpen = false;
  try {
    mkdirSync(destinationContainerPath, { mode: 0o700 });
    ownsDestination = true;
    chmodSync(destinationContainerPath, 0o700);
    mkdirSync(stagingPath, { mode: 0o700 });
    chmodSync(stagingPath, 0o700);
    const backupPath = path.join(stagingPath, BACKUP_FILE_NAME);
    const evidencePath = path.join(stagingPath, EVIDENCE_FILE_NAME);

    await client.connect();
    const databaseIdentity = await client.query<{ database_name: string }>(
      "SELECT current_database() AS database_name",
    );
    if (databaseIdentity.rows[0]?.database_name !== databaseName) {
      throw new Error("connected PostgreSQL database does not match approval");
    }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const snapshot = await client.query<{ snapshot_id: string }>(
      "SELECT pg_export_snapshot() AS snapshot_id",
    );
    const snapshotId = snapshot.rows[0]?.snapshot_id;
    if (!snapshotId || !/^[0-9A-Fa-f-]{8,128}$/u.test(snapshotId)) {
      throw new Error("PostgreSQL exported snapshot identity is invalid");
    }
    const inspection = await inspectSnapshot(client, sourceJournal);
    const dumpResult = await tooling.dump({
      snapshotId,
      databaseName,
      destinationPath: backupPath,
      timeoutMs: dumpTimeoutMs,
    });
    chmodSync(backupPath, 0o600);
    const backup = hashPrivateFile(backupPath, "PostgreSQL backup");
    const listResult = await tooling.list({
      backupPath,
      timeoutMs: queryTimeoutMs,
    });
    const toc = canonicalizeToc(listResult.stdout);
    await client.query("COMMIT");
    transactionOpen = false;

    const createdAt = (input.now ?? (() => new Date()))().toISOString();
    const evidence: HyperiaPostgresBackupEvidence = {
      schemaVersion: 1,
      createdAt,
      backupId,
      releaseSha,
      boundaryId,
      databaseName,
      ...inspection,
      snapshotIsolation: "repeatable_read_read_only_exported_snapshot",
      verificationScope: "postgres_snapshot_dump_only",
      quiescentBoundaryWitnessRequired: true,
      restoreCompatibilityApprovalRequired: true,
      sourceMigrationJournalSha256: sourceJournal.sha256,
      sourceMigrationCount: sourceJournal.migrations.length,
      sourceLatestMigrationTag:
        sourceJournal.migrations[sourceJournal.migrations.length - 1].tag,
      backupFileName: BACKUP_FILE_NAME,
      backupSha256: backup.sha256,
      backupBytes: backup.bytes,
      tocSha256: toc.sha256,
      tocEntries: toc.entries,
      pgDumpVersion: dumpResult.version,
      pgRestoreVersionAtCreate: listResult.version,
    };
    writePrivateJson(evidencePath, evidence);
    fsyncDirectory(stagingPath);
    await verifyBackupPayload({
      backupRootPath: stagingPath,
      expectedReleaseSha: releaseSha,
      expectedBoundaryId: boundaryId,
      expectedDatabaseName: databaseName,
      toolTimeoutMs: queryTimeoutMs,
      tooling,
      migrationsDirectory: input.migrationsDirectory,
    });
    await input.beforePublish?.();
    if (existsSync(activePath)) {
      throw new Error("PostgreSQL active backup root already exists");
    }
    renameSync(stagingPath, activePath);
    fsyncDirectory(destinationContainerPath);
    fsyncDirectory(path.dirname(destinationContainerPath));
    await verifyHyperiaPostgresBackup({
      backupRootPath: activePath,
      expectedReleaseSha: releaseSha,
      expectedBoundaryId: boundaryId,
      expectedDatabaseName: databaseName,
      toolTimeoutMs: queryTimeoutMs,
      tooling,
      migrationsDirectory: input.migrationsDirectory,
    });
    return evidence;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    if (ownsDestination) {
      rmSync(destinationContainerPath, { recursive: true, force: true });
      fsyncDirectory(path.dirname(destinationContainerPath));
    }
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function verifyHyperiaPostgresBackup(
  input: VerifyHyperiaPostgresBackupInput,
): Promise<HyperiaPostgresBackupEvidence> {
  const backupRootPath = path.resolve(input.backupRootPath);
  if (path.basename(backupRootPath) !== ACTIVE_ROOT_NAME) {
    throw new Error("PostgreSQL published backup root must be named active");
  }
  const destinationContainerPath = path.dirname(backupRootPath);
  assertPrivateDirectory(
    destinationContainerPath,
    "PostgreSQL backup destination container",
  );
  requireExactEntries(
    destinationContainerPath,
    [ACTIVE_ROOT_NAME],
    "PostgreSQL backup destination container",
  );
  return await verifyBackupPayload({ ...input, backupRootPath });
}

async function verifyBackupPayload(
  input: VerifyHyperiaPostgresBackupInput,
): Promise<HyperiaPostgresBackupEvidence> {
  const releaseSha = assertReleaseSha(input.expectedReleaseSha);
  const boundaryId = assertBoundaryId(input.expectedBoundaryId);
  const databaseName = assertDatabaseName(input.expectedDatabaseName);
  const timeoutMs = assertTimeout(
    input.toolTimeoutMs,
    "tool timeout",
    MAX_QUERY_TIMEOUT_MS,
  );
  const backupRootPath = path.resolve(input.backupRootPath);
  assertPrivateDirectory(backupRootPath, "PostgreSQL active backup root");
  requireExactEntries(
    backupRootPath,
    [BACKUP_FILE_NAME, EVIDENCE_FILE_NAME],
    "PostgreSQL active backup root",
  );
  const evidence = parseEvidence(
    readPrivateJson(
      path.join(backupRootPath, EVIDENCE_FILE_NAME),
      MAX_EVIDENCE_BYTES,
    ),
  );
  const sourceJournal = loadSourceMigrationJournal(
    input.migrationsDirectory ?? path.join(import.meta.dirname, "migrations"),
  );
  if (
    evidence.releaseSha !== releaseSha ||
    evidence.boundaryId !== boundaryId ||
    evidence.databaseName !== databaseName
  ) {
    throw new Error("PostgreSQL backup identity does not match");
  }
  if (
    evidence.sourceMigrationJournalSha256 !== sourceJournal.sha256 ||
    evidence.sourceMigrationCount !== sourceJournal.migrations.length ||
    evidence.sourceLatestMigrationTag !==
      sourceJournal.migrations[sourceJournal.migrations.length - 1]?.tag
  ) {
    throw new Error(
      "PostgreSQL backup source migration evidence does not match",
    );
  }
  const backupPath = path.join(backupRootPath, BACKUP_FILE_NAME);
  const backup = hashPrivateFile(backupPath, "PostgreSQL backup");
  if (
    backup.sha256 !== evidence.backupSha256 ||
    backup.bytes !== evidence.backupBytes
  ) {
    throw new Error("PostgreSQL backup file binding does not match");
  }
  const listResult = await (
    input.tooling ?? createLocalPostgresBackupTooling()
  ).list({ backupPath, timeoutMs });
  const toc = canonicalizeToc(listResult.stdout);
  if (
    toc.sha256 !== evidence.tocSha256 ||
    toc.entries !== evidence.tocEntries
  ) {
    throw new Error("PostgreSQL backup TOC does not match evidence");
  }
  return evidence;
}

function postgresMajorVersion(serverVersionNum: string): number {
  if (!/^[0-9]{5,6}$/u.test(serverVersionNum)) {
    throw new Error("approved PostgreSQL server version is invalid");
  }
  const numeric = Number(serverVersionNum);
  const major =
    numeric >= 100_000
      ? Math.floor(numeric / 10_000)
      : Math.floor(numeric / 100);
  if (!Number.isSafeInteger(major) || major < 16 || major > 99) {
    throw new Error("approved PostgreSQL major version is unsupported");
  }
  return major;
}

export async function verifyHyperiaPostgresRestore(
  input: VerifyHyperiaPostgresRestoreInput,
): Promise<HyperiaPostgresRestoreVerification> {
  const restoredDatabaseName = assertDatabaseName(input.restoredDatabaseName);
  const approvedTargetServerVersionNum =
    input.approvedTargetServerVersionNum.trim();
  const queryTimeoutMs = assertTimeout(
    input.queryTimeoutMs,
    "query timeout",
    MAX_QUERY_TIMEOUT_MS,
  );
  const approvedMajor = postgresMajorVersion(approvedTargetServerVersionNum);
  const sourceEvidence = await verifyHyperiaPostgresBackup({
    backupRootPath: input.backupRootPath,
    expectedReleaseSha: input.expectedReleaseSha,
    expectedBoundaryId: input.expectedBoundaryId,
    expectedDatabaseName: input.sourceDatabaseName,
    toolTimeoutMs: input.toolTimeoutMs,
    tooling: input.tooling,
    migrationsDirectory: input.migrationsDirectory,
  });
  if (postgresMajorVersion(sourceEvidence.serverVersionNum) !== approvedMajor) {
    throw new Error(
      "restored PostgreSQL major version approval does not match source",
    );
  }
  const connection = resolveConnectionEnvironment(restoredDatabaseName);
  const client = new Client({
    ...connection,
    application_name: "hyperia_restore_verification_v1",
    connectionTimeoutMillis: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
    query_timeout: queryTimeoutMs,
  });
  let transactionOpen = false;
  try {
    await client.connect();
    const databaseIdentity = await client.query<{ database_name: string }>(
      "SELECT current_database() AS database_name",
    );
    if (databaseIdentity.rows[0]?.database_name !== restoredDatabaseName) {
      throw new Error(
        "connected PostgreSQL restore database does not match approval",
      );
    }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const inspection = await inspectHyperiaPostgresRecoveryState(
      client,
      input.migrationsDirectory ?? path.join(import.meta.dirname, "migrations"),
    );
    if (inspection.serverVersionNum !== approvedTargetServerVersionNum) {
      throw new Error(
        "restored PostgreSQL server version does not match approval",
      );
    }
    if (
      inspection.databaseEncoding !== sourceEvidence.databaseEncoding ||
      inspection.databaseMigrationJournalSha256 !==
        sourceEvidence.databaseMigrationJournalSha256 ||
      inspection.schemaSha256 !== sourceEvidence.schemaSha256 ||
      JSON.stringify(inspection.schemaObjectCounts) !==
        JSON.stringify(sourceEvidence.schemaObjectCounts) ||
      JSON.stringify(inspection.recoveryTableCounts) !==
        JSON.stringify(sourceEvidence.recoveryTableCounts) ||
      JSON.stringify(inspection.recoveryTableSha256s) !==
        JSON.stringify(sourceEvidence.recoveryTableSha256s)
    ) {
      throw new Error(
        "isolated PostgreSQL restore does not match backup evidence",
      );
    }
    await client.query("COMMIT");
    transactionOpen = false;
    return {
      sourceEvidence,
      restoredDatabaseName,
      targetServerVersionNum: inspection.serverVersionNum,
      inspection,
      verificationScope: "isolated_postgres_restore_only",
      activationRequiresSeparateApproval: true,
    };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}
