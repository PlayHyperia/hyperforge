import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createHyperiaPostgresBackup,
  verifyHyperiaPostgresBackup,
  verifyHyperiaPostgresRestore,
} from "./hyperia-postgres-backup";

const COMMON_ARGUMENTS = ["database", "release-sha", "boundary-id"] as const;
const CREATE_ARGUMENTS = [
  ...COMMON_ARGUMENTS,
  "destination-container",
  "query-timeout-ms",
  "dump-timeout-ms",
] as const;
const VERIFY_ARGUMENTS = [
  ...COMMON_ARGUMENTS,
  "backup-root",
  "tool-timeout-ms",
] as const;
const VERIFY_RESTORED_ARGUMENTS = [
  "source-database",
  "restored-database",
  "release-sha",
  "boundary-id",
  "backup-root",
  "approved-target-server-version-num",
  "query-timeout-ms",
  "tool-timeout-ms",
] as const;

function validateArguments(
  arguments_: readonly string[],
  command: string,
): void {
  const allowed =
    command === "create"
      ? new Set<string>(CREATE_ARGUMENTS)
      : command === "verify"
        ? new Set<string>(VERIFY_ARGUMENTS)
        : command === "verify-restored"
          ? new Set<string>(VERIFY_RESTORED_ARGUMENTS)
          : null;
  if (!allowed) {
    throw new Error(
      "usage: hyperia-postgres-backup <create|verify|verify-restored> with the exact documented argument set",
    );
  }
  const observed = new Set<string>();
  for (const argument of arguments_.slice(3)) {
    const match = /^--([a-z-]+)=/u.exec(argument);
    const name = match?.[1];
    if (!name || !allowed.has(name) || observed.has(name)) {
      throw new Error(
        "backup command contains an unknown or duplicate argument",
      );
    }
    observed.add(name);
  }
  if (observed.size !== allowed.size) {
    throw new Error("backup command argument set is incomplete");
  }
}

function requireArg(arguments_: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const argument = arguments_.find((value) => value.startsWith(prefix));
  const value = argument?.slice(prefix.length).trim();
  if (!value) throw new Error(`missing required --${name}=<value>`);
  return value;
}

function requireIntegerArg(
  arguments_: readonly string[],
  name: string,
): number {
  const value = Number(requireArg(arguments_, name));
  if (!Number.isSafeInteger(value)) {
    throw new Error(`--${name} must be a safe integer`);
  }
  return value;
}

export async function runHyperiaPostgresBackupCli(
  arguments_: readonly string[],
) {
  const command = arguments_[2];
  validateArguments(arguments_, command ?? "");
  if (command === "verify-restored") {
    const result = await verifyHyperiaPostgresRestore({
      backupRootPath: requireArg(arguments_, "backup-root"),
      expectedReleaseSha: requireArg(arguments_, "release-sha"),
      expectedBoundaryId: requireArg(arguments_, "boundary-id"),
      sourceDatabaseName: requireArg(arguments_, "source-database"),
      restoredDatabaseName: requireArg(arguments_, "restored-database"),
      approvedTargetServerVersionNum: requireArg(
        arguments_,
        "approved-target-server-version-num",
      ),
      queryTimeoutMs: requireIntegerArg(arguments_, "query-timeout-ms"),
      toolTimeoutMs: requireIntegerArg(arguments_, "tool-timeout-ms"),
    });
    return {
      ok: true,
      action: command,
      backupId: result.sourceEvidence.backupId,
      releaseSha: result.sourceEvidence.releaseSha,
      boundaryId: result.sourceEvidence.boundaryId,
      sourceDatabaseName: result.sourceEvidence.databaseName,
      restoredDatabaseName: result.restoredDatabaseName,
      sourceMigrationCount: result.sourceEvidence.sourceMigrationCount,
      sourceLatestMigrationTag: result.sourceEvidence.sourceLatestMigrationTag,
      schemaSha256: result.inspection.schemaSha256,
      targetServerVersionNum: result.targetServerVersionNum,
      recoveryTableCount: Object.keys(result.inspection.recoveryTableCounts)
        .length,
      verificationScope: result.verificationScope,
      activationRequiresSeparateApproval:
        result.activationRequiresSeparateApproval,
    };
  }
  const expectedDatabaseName = requireArg(arguments_, "database");
  const releaseSha = requireArg(arguments_, "release-sha");
  const boundaryId = requireArg(arguments_, "boundary-id");
  const evidence =
    command === "create"
      ? await createHyperiaPostgresBackup({
          destinationContainerPath: requireArg(
            arguments_,
            "destination-container",
          ),
          releaseSha,
          boundaryId,
          expectedDatabaseName,
          queryTimeoutMs: requireIntegerArg(arguments_, "query-timeout-ms"),
          dumpTimeoutMs: requireIntegerArg(arguments_, "dump-timeout-ms"),
        })
      : command === "verify"
        ? await verifyHyperiaPostgresBackup({
            backupRootPath: requireArg(arguments_, "backup-root"),
            expectedReleaseSha: releaseSha,
            expectedBoundaryId: boundaryId,
            expectedDatabaseName,
            toolTimeoutMs: requireIntegerArg(arguments_, "tool-timeout-ms"),
          })
        : null;
  if (!evidence) throw new Error("backup command is invalid");
  return {
    ok: true,
    action: command,
    backupId: evidence.backupId,
    releaseSha: evidence.releaseSha,
    boundaryId: evidence.boundaryId,
    databaseName: evidence.databaseName,
    sourceMigrationCount: evidence.sourceMigrationCount,
    sourceLatestMigrationTag: evidence.sourceLatestMigrationTag,
    schemaSha256: evidence.schemaSha256,
    backupSha256: evidence.backupSha256,
    backupBytes: evidence.backupBytes,
    tocSha256: evidence.tocSha256,
    tocEntries: evidence.tocEntries,
    verificationScope: evidence.verificationScope,
    quiescentBoundaryWitnessRequired: evidence.quiescentBoundaryWitnessRequired,
    restoreCompatibilityApprovalRequired:
      evidence.restoreCompatibilityApprovalRequired,
  };
}

const isMain =
  import.meta.main ||
  (process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false);
if (isMain) {
  try {
    console.log(
      JSON.stringify(await runHyperiaPostgresBackupCli(process.argv)),
    );
  } catch (error) {
    console.error(
      `Hyperia PostgreSQL backup failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    );
    process.exitCode = 1;
  }
}
