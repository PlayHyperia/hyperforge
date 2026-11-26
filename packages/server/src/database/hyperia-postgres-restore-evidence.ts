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

import {
  HYPERIA_RECOVERY_TABLES,
  type HyperiaPostgresRestoreVerification,
  type VerifyHyperiaPostgresRestoreInput,
  verifyHyperiaPostgresRestore,
} from "./hyperia-postgres-backup";

const RESTORE_EVIDENCE_FILE_NAME = "hyperia-postgres-restore-evidence.json";
const MAX_RESTORE_EVIDENCE_BYTES = 128 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BOUNDARY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,63}$/u;
const DATABASE_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,63}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type PrivateFileBinding = {
  fileName: string;
  sha256: string;
  bytes: number;
};

export type HyperiaPostgresRestoreEvidence = {
  schemaVersion: 1;
  createdAt: string;
  restoreVerificationId: string;
  backupId: string;
  releaseSha: string;
  boundaryId: string;
  sourceDatabaseName: string;
  restoredDatabaseName: string;
  targetServerVersionNum: string;
  sourceBackup: PrivateFileBinding;
  sourceEvidence: PrivateFileBinding;
  sourceMigrationJournalSha256: string;
  schemaSha256: string;
  recoveryTableCount: number;
  restoredStateSha256: string;
  verificationScope: "isolated_postgres_restore_evidence_only";
  activationRequiresSeparateApproval: true;
  productionCutoverAuthorized: false;
};

export type CreateHyperiaPostgresRestoreEvidenceInput =
  VerifyHyperiaPostgresRestoreInput & {
    restoreEvidencePath: string;
    now?: () => Date;
    createId?: () => string;
  };

export type VerifyHyperiaPostgresRestoreEvidenceInput =
  VerifyHyperiaPostgresRestoreInput & {
    restoreEvidencePath: string;
  };

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
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
    const finalStats = fstatSync(descriptor);
    if (
      bytes !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      (finalStats.mode & 0o777) !== 0o600 ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      throw new Error(`${label} changed while it was being hashed`);
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

function readPrivateEvidence(filePath: string): unknown {
  const binding = assertPrivateRegularFile(
    filePath,
    "PostgreSQL restore evidence",
    MAX_RESTORE_EVIDENCE_BYTES,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = fstatSync(descriptor);
    if (
      openedStats.dev !== binding.dev ||
      openedStats.ino !== binding.ino ||
      openedStats.size !== binding.size ||
      (openedStats.mode & 0o777) !== 0o600
    ) {
      throw new Error("PostgreSQL restore evidence changed while being read");
    }
    const bytes = readFileSync(descriptor);
    const finalStats = fstatSync(descriptor);
    if (
      bytes.byteLength !== openedStats.size ||
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      (finalStats.mode & 0o777) !== 0o600 ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      throw new Error("PostgreSQL restore evidence changed while being read");
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("PostgreSQL restore evidence is invalid");
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parsePrivateFileBinding(value: unknown): PrivateFileBinding | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["fileName", "sha256", "bytes"]) ||
    typeof value.fileName !== "string" ||
    value.fileName.length === 0 ||
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

function parseRestoreEvidence(value: unknown): HyperiaPostgresRestoreEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "restoreVerificationId",
      "backupId",
      "releaseSha",
      "boundaryId",
      "sourceDatabaseName",
      "restoredDatabaseName",
      "targetServerVersionNum",
      "sourceBackup",
      "sourceEvidence",
      "sourceMigrationJournalSha256",
      "schemaSha256",
      "recoveryTableCount",
      "restoredStateSha256",
      "verificationScope",
      "activationRequiresSeparateApproval",
      "productionCutoverAuthorized",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.restoreVerificationId !== "string" ||
    !UUID_V4_PATTERN.test(value.restoreVerificationId) ||
    typeof value.backupId !== "string" ||
    !UUID_V4_PATTERN.test(value.backupId) ||
    typeof value.releaseSha !== "string" ||
    !RELEASE_SHA_PATTERN.test(value.releaseSha) ||
    typeof value.boundaryId !== "string" ||
    !BOUNDARY_ID_PATTERN.test(value.boundaryId) ||
    typeof value.sourceDatabaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.sourceDatabaseName) ||
    typeof value.restoredDatabaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.restoredDatabaseName) ||
    typeof value.targetServerVersionNum !== "string" ||
    !/^[0-9]{5,6}$/u.test(value.targetServerVersionNum) ||
    typeof value.sourceMigrationJournalSha256 !== "string" ||
    !SHA256_PATTERN.test(value.sourceMigrationJournalSha256) ||
    typeof value.schemaSha256 !== "string" ||
    !SHA256_PATTERN.test(value.schemaSha256) ||
    value.recoveryTableCount !== HYPERIA_RECOVERY_TABLES.length ||
    typeof value.restoredStateSha256 !== "string" ||
    !SHA256_PATTERN.test(value.restoredStateSha256) ||
    value.verificationScope !== "isolated_postgres_restore_evidence_only" ||
    value.activationRequiresSeparateApproval !== true ||
    value.productionCutoverAuthorized !== false
  ) {
    throw new Error("PostgreSQL restore evidence is invalid");
  }
  const sourceBackup = parsePrivateFileBinding(value.sourceBackup);
  const sourceEvidence = parsePrivateFileBinding(value.sourceEvidence);
  if (!sourceBackup || !sourceEvidence) {
    throw new Error("PostgreSQL restore evidence is invalid");
  }
  return {
    ...(value as Omit<
      HyperiaPostgresRestoreEvidence,
      "sourceBackup" | "sourceEvidence"
    >),
    sourceBackup,
    sourceEvidence,
  };
}

function restoredStateSha256(
  verification: HyperiaPostgresRestoreVerification,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        targetServerVersionNum: verification.targetServerVersionNum,
        inspection: verification.inspection,
      }),
    )
    .digest("hex");
}

function sourceBindings(backupRootPath: string) {
  const root = path.resolve(backupRootPath);
  return {
    sourceBackup: bindPrivateFile(
      path.join(root, "hyperia-postgres.dump"),
      "PostgreSQL source backup",
    ),
    sourceEvidence: bindPrivateFile(
      path.join(root, "evidence.json"),
      "PostgreSQL source backup evidence",
      MAX_RESTORE_EVIDENCE_BYTES,
    ),
  };
}

function expectedEvidenceFields(
  verification: HyperiaPostgresRestoreVerification,
  backupRootPath: string,
) {
  return {
    backupId: verification.sourceEvidence.backupId,
    releaseSha: verification.sourceEvidence.releaseSha,
    boundaryId: verification.sourceEvidence.boundaryId,
    sourceDatabaseName: verification.sourceEvidence.databaseName,
    restoredDatabaseName: verification.restoredDatabaseName,
    targetServerVersionNum: verification.targetServerVersionNum,
    ...sourceBindings(backupRootPath),
    sourceMigrationJournalSha256:
      verification.sourceEvidence.sourceMigrationJournalSha256,
    schemaSha256: verification.inspection.schemaSha256,
    recoveryTableCount: HYPERIA_RECOVERY_TABLES.length,
    restoredStateSha256: restoredStateSha256(verification),
    verificationScope: "isolated_postgres_restore_evidence_only" as const,
    activationRequiresSeparateApproval: true as const,
    productionCutoverAuthorized: false as const,
  };
}

function resolveNewEvidencePath(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  if (path.basename(absolutePath) !== RESTORE_EVIDENCE_FILE_NAME) {
    throw new Error(
      `PostgreSQL restore evidence must be named ${RESTORE_EVIDENCE_FILE_NAME}`,
    );
  }
  if (existsSync(absolutePath)) {
    throw new Error("PostgreSQL restore evidence already exists");
  }
  const parent = lstatSync(path.dirname(absolutePath));
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) {
    throw new Error("PostgreSQL restore evidence parent must be mode-0700");
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

function writePrivateEvidence(
  filePath: string,
  evidence: HyperiaPostgresRestoreEvidence,
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

export async function createHyperiaPostgresRestoreEvidence(
  input: CreateHyperiaPostgresRestoreEvidenceInput,
): Promise<HyperiaPostgresRestoreEvidence> {
  const restoreEvidencePath = resolveNewEvidencePath(input.restoreEvidencePath);
  const verification = await verifyHyperiaPostgresRestore(input);
  const restoreVerificationId = (input.createId ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(restoreVerificationId)) {
    throw new Error("PostgreSQL restore evidence ID is invalid");
  }
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  if (
    Date.parse(createdAt) < Date.parse(verification.sourceEvidence.createdAt)
  ) {
    throw new Error("PostgreSQL restore evidence clock regressed");
  }
  const evidence: HyperiaPostgresRestoreEvidence = {
    schemaVersion: 1,
    createdAt,
    restoreVerificationId,
    ...expectedEvidenceFields(verification, input.backupRootPath),
  };
  writePrivateEvidence(restoreEvidencePath, evidence);
  try {
    return await verifyHyperiaPostgresRestoreEvidence(input);
  } catch (error) {
    unlinkSync(restoreEvidencePath);
    fsyncParent(restoreEvidencePath);
    throw error;
  }
}

export async function verifyHyperiaPostgresRestoreEvidence(
  input: VerifyHyperiaPostgresRestoreEvidenceInput,
): Promise<HyperiaPostgresRestoreEvidence> {
  const restoreEvidencePath = path.resolve(input.restoreEvidencePath);
  if (path.basename(restoreEvidencePath) !== RESTORE_EVIDENCE_FILE_NAME) {
    throw new Error(
      `PostgreSQL restore evidence must be named ${RESTORE_EVIDENCE_FILE_NAME}`,
    );
  }
  const evidence = parseRestoreEvidence(
    readPrivateEvidence(restoreEvidencePath),
  );
  const verification = await verifyHyperiaPostgresRestore(input);
  const expected = expectedEvidenceFields(verification, input.backupRootPath);
  const observed = {
    backupId: evidence.backupId,
    releaseSha: evidence.releaseSha,
    boundaryId: evidence.boundaryId,
    sourceDatabaseName: evidence.sourceDatabaseName,
    restoredDatabaseName: evidence.restoredDatabaseName,
    targetServerVersionNum: evidence.targetServerVersionNum,
    sourceBackup: evidence.sourceBackup,
    sourceEvidence: evidence.sourceEvidence,
    sourceMigrationJournalSha256: evidence.sourceMigrationJournalSha256,
    schemaSha256: evidence.schemaSha256,
    recoveryTableCount: evidence.recoveryTableCount,
    restoredStateSha256: evidence.restoredStateSha256,
    verificationScope: evidence.verificationScope,
    activationRequiresSeparateApproval:
      evidence.activationRequiresSeparateApproval,
    productionCutoverAuthorized: evidence.productionCutoverAuthorized,
  };
  if (
    Date.parse(evidence.createdAt) <
      Date.parse(verification.sourceEvidence.createdAt) ||
    JSON.stringify(observed) !== JSON.stringify(expected)
  ) {
    throw new Error("PostgreSQL restore evidence does not match current state");
  }
  return evidence;
}
