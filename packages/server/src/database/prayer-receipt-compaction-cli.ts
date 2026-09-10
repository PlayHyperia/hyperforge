import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  runPrayerReceiptCompaction,
  type PrayerReceiptCompactionRequest,
} from "./prayer-receipt-compaction";

const { Pool } = pg;

const AUDIT_ARGUMENTS = new Set([
  "database-url",
  "cutoff-before-ms",
  "batch-limit",
  "statement-timeout-ms",
  "connection-timeout-ms",
]);
const EXECUTE_ARGUMENTS = new Set([
  ...AUDIT_ARGUMENTS,
  "retention-approval-id",
]);

export type PrayerReceiptCompactionCliOptions = Readonly<{
  databaseUrl: string;
  connectionTimeoutMs: number;
  request: PrayerReceiptCompactionRequest;
}>;

function requireArgument(arguments_: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const matching = arguments_.filter((value) => value.startsWith(prefix));
  const value = matching[0]?.slice(prefix.length).trim();
  if (matching.length !== 1 || !value) {
    throw new Error(`missing_or_duplicate_${name.replaceAll("-", "_")}`);
  }
  return value;
}

function requireIntegerArgument(
  arguments_: readonly string[],
  name: string,
): number {
  const value = Number(requireArgument(arguments_, name));
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name.replaceAll("-", "_")}_invalid`);
  }
  return value;
}

function validateDatabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("database_url_invalid");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === "/"
  ) {
    throw new Error("database_url_invalid");
  }
  return value;
}

export function parsePrayerReceiptCompactionCliArgs(
  arguments_: readonly string[],
): PrayerReceiptCompactionCliOptions {
  const mode = arguments_[2];
  const allowed =
    mode === "audit"
      ? AUDIT_ARGUMENTS
      : mode === "execute"
        ? EXECUTE_ARGUMENTS
        : null;
  if (!allowed) {
    throw new Error("prayer_receipt_compaction_mode_invalid");
  }
  const normalizedMode = mode as "audit" | "execute";
  const observed = new Set<string>();
  for (const argument of arguments_.slice(3)) {
    const match = /^--([a-z-]+)=/u.exec(argument);
    const name = match?.[1];
    if (!name || !allowed.has(name) || observed.has(name)) {
      throw new Error("prayer_receipt_compaction_argument_invalid");
    }
    observed.add(name);
  }
  if (observed.size !== allowed.size) {
    throw new Error("prayer_receipt_compaction_argument_set_incomplete");
  }

  return {
    databaseUrl: validateDatabaseUrl(
      requireArgument(arguments_, "database-url"),
    ),
    connectionTimeoutMs: requireIntegerArgument(
      arguments_,
      "connection-timeout-ms",
    ),
    request: {
      mode: normalizedMode,
      cutoffBeforeMs: requireIntegerArgument(arguments_, "cutoff-before-ms"),
      batchLimit: requireIntegerArgument(arguments_, "batch-limit"),
      statementTimeoutMs: requireIntegerArgument(
        arguments_,
        "statement-timeout-ms",
      ),
      ...(normalizedMode === "execute"
        ? {
            retentionApprovalId: requireArgument(
              arguments_,
              "retention-approval-id",
            ),
          }
        : {}),
    },
  };
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown failure";
  return message.replace(
    /postgres(?:ql)?:\/\/[^\s]+/giu,
    "[REDACTED_DATABASE_URL]",
  );
}

export async function runPrayerReceiptCompactionCli(
  arguments_: readonly string[],
): Promise<unknown> {
  const options = parsePrayerReceiptCompactionCliArgs(arguments_);
  if (
    !Number.isSafeInteger(options.connectionTimeoutMs) ||
    options.connectionTimeoutMs < 100 ||
    options.connectionTimeoutMs > 60_000
  ) {
    throw new Error("connection_timeout_ms_invalid");
  }
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: 1,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    allowExitOnIdle: true,
  });
  try {
    return await runPrayerReceiptCompaction(pool, options.request);
  } finally {
    await pool.end();
  }
}

const isMain =
  import.meta.main ||
  (process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false);
if (isMain) {
  try {
    console.log(
      JSON.stringify(await runPrayerReceiptCompactionCli(process.argv)),
    );
  } catch (error) {
    console.error(`Prayer receipt compaction failed: ${redactError(error)}`);
    process.exitCode = 1;
  }
}
