import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HyperiaPostgresBackupTooling } from "./hyperia-postgres-backup";
import {
  createHyperiaPostgresRestoreEvidence,
  verifyHyperiaPostgresRestoreEvidence,
} from "./hyperia-postgres-restore-evidence";

const ARGUMENTS = [
  "source-database",
  "restored-database",
  "release-sha",
  "boundary-id",
  "backup-root",
  "restore-evidence",
  "approved-target-server-version-num",
  "query-timeout-ms",
  "tool-timeout-ms",
] as const;

type CliOverrides = {
  tooling?: HyperiaPostgresBackupTooling;
  migrationsDirectory?: string;
};

function validateArguments(arguments_: readonly string[]): "create" | "verify" {
  const command = arguments_[2];
  if (command !== "create" && command !== "verify") {
    throw new Error(
      "usage: hyperia-postgres-restore-evidence <create|verify> with the exact documented argument set",
    );
  }
  const allowed = new Set<string>(ARGUMENTS);
  const observed = new Set<string>();
  for (const argument of arguments_.slice(3)) {
    const name = /^--([a-z-]+)=/u.exec(argument)?.[1];
    if (!name || !allowed.has(name) || observed.has(name)) {
      throw new Error(
        "restore evidence command contains an unknown or duplicate argument",
      );
    }
    observed.add(name);
  }
  if (observed.size !== allowed.size) {
    throw new Error("restore evidence command argument set is incomplete");
  }
  return command;
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

export async function runHyperiaPostgresRestoreEvidenceCli(
  arguments_: readonly string[],
  overrides: CliOverrides = {},
) {
  const command = validateArguments(arguments_);
  const input = {
    backupRootPath: requireArg(arguments_, "backup-root"),
    restoreEvidencePath: requireArg(arguments_, "restore-evidence"),
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
    ...overrides,
  };
  const evidence =
    command === "create"
      ? await createHyperiaPostgresRestoreEvidence(input)
      : await verifyHyperiaPostgresRestoreEvidence(input);
  return {
    ok: true,
    action: command,
    restoreVerificationId: evidence.restoreVerificationId,
    backupId: evidence.backupId,
    releaseSha: evidence.releaseSha,
    boundaryId: evidence.boundaryId,
    sourceDatabaseName: evidence.sourceDatabaseName,
    restoredDatabaseName: evidence.restoredDatabaseName,
    targetServerVersionNum: evidence.targetServerVersionNum,
    restoredStateSha256: evidence.restoredStateSha256,
    recoveryTableCount: evidence.recoveryTableCount,
    verificationScope: evidence.verificationScope,
    activationRequiresSeparateApproval:
      evidence.activationRequiresSeparateApproval,
    productionCutoverAuthorized: evidence.productionCutoverAuthorized,
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
      JSON.stringify(await runHyperiaPostgresRestoreEvidenceCli(process.argv)),
    );
  } catch (error) {
    console.error(
      `Hyperia PostgreSQL restore evidence failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    );
    process.exitCode = 1;
  }
}
