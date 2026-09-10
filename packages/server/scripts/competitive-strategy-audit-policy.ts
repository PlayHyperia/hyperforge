export const DEFAULT_COMPETITIVE_STRATEGY_AUDIT_QUERY_LIMIT = 10_000;
export const MAX_COMPETITIVE_STRATEGY_AUDIT_QUERY_LIMIT = 50_000;
export const OWNED_LOCAL_DIAGNOSTIC_BOUNDARY = "owned_local_no_value";

export type CompetitiveStrategyAuditOptions = Readonly<{
  help: boolean;
  queryLimit: number;
  includeDiagnostics: boolean;
}>;

export type CompetitiveStrategyAuditDiagnosticScope = Readonly<{
  included: boolean;
  boundary: typeof OWNED_LOCAL_DIAGNOSTIC_BOUNDARY | "excluded";
  productionMetricsEligible: boolean;
}>;

export function readCompetitiveStrategyAuditOptions(
  argv: readonly string[],
): CompetitiveStrategyAuditOptions {
  let help = false;
  let rawLimit: string | null = null;
  let limitSpecified = false;
  let includeDiagnostics = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "--include-diagnostics") {
      if (includeDiagnostics) {
        throw new Error("--include-diagnostics may only be specified once");
      }
      includeDiagnostics = true;
      continue;
    }
    if (argument === "--limit") {
      if (limitSpecified) {
        throw new Error("--limit may only be specified once");
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--limit requires a value");
      }
      limitSpecified = true;
      rawLimit = next;
      index += 1;
      continue;
    }
    if (argument.startsWith("--limit=")) {
      if (limitSpecified) {
        throw new Error("--limit may only be specified once");
      }
      limitSpecified = true;
      rawLimit = argument.slice("--limit=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  const queryLimit =
    rawLimit === null
      ? DEFAULT_COMPETITIVE_STRATEGY_AUDIT_QUERY_LIMIT
      : Number(rawLimit);
  if (
    rawLimit !== null &&
    (!/^[1-9][0-9]*$/u.test(rawLimit) ||
      !Number.isSafeInteger(queryLimit) ||
      queryLimit > MAX_COMPETITIVE_STRATEGY_AUDIT_QUERY_LIMIT)
  ) {
    throw new Error(
      `--limit must be between 1 and ${MAX_COMPETITIVE_STRATEGY_AUDIT_QUERY_LIMIT}`,
    );
  }
  return Object.freeze({ help, queryLimit, includeDiagnostics });
}

export function resolveCompetitiveStrategyAuditDiagnosticScope({
  includeDiagnostics,
  connectionString,
  configuredBoundary,
}: {
  includeDiagnostics: boolean;
  connectionString: string;
  configuredBoundary?: string;
}): CompetitiveStrategyAuditDiagnosticScope {
  if (!includeDiagnostics) {
    return Object.freeze({
      included: false,
      boundary: "excluded",
      productionMetricsEligible: true,
    });
  }
  if (configuredBoundary !== OWNED_LOCAL_DIAGNOSTIC_BOUNDARY) {
    throw new Error(
      `--include-diagnostics requires COMPETITIVE_STRATEGY_AUDIT_DIAGNOSTIC_BOUNDARY=${OWNED_LOCAL_DIAGNOSTIC_BOUNDARY}`,
    );
  }
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    throw new Error("Diagnostic strategy audit database URL is invalid");
  }
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(hostname)) {
    throw new Error(
      "Diagnostic strategy audit is restricted to an owned loopback database",
    );
  }
  return Object.freeze({
    included: true,
    boundary: OWNED_LOCAL_DIAGNOSTIC_BOUNDARY,
    productionMetricsEligible: false,
  });
}
