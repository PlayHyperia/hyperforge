import { describe, expect, it } from "vitest";

import {
  readCompetitiveStrategyAuditOptions,
  resolveCompetitiveStrategyAuditDiagnosticScope,
} from "./competitive-strategy-audit-policy.js";

describe("competitive strategy audit CLI policy", () => {
  it("parses the explicit diagnostic opt-in and bounded population", () => {
    expect(
      readCompetitiveStrategyAuditOptions([
        "--include-diagnostics",
        "--limit=50000",
      ]),
    ).toEqual({
      help: false,
      queryLimit: 50_000,
      includeDiagnostics: true,
    });
    expect(readCompetitiveStrategyAuditOptions(["--help"]).help).toBe(true);
  });

  it("rejects missing, duplicate, and out-of-range options", () => {
    expect(() => readCompetitiveStrategyAuditOptions(["--limit"])).toThrow(
      "--limit requires a value",
    );
    expect(() =>
      readCompetitiveStrategyAuditOptions(["--limit=10", "--limit=20"]),
    ).toThrow("--limit may only be specified once");
    expect(() =>
      readCompetitiveStrategyAuditOptions([
        "--include-diagnostics",
        "--include-diagnostics",
      ]),
    ).toThrow("--include-diagnostics may only be specified once");
    expect(() =>
      readCompetitiveStrategyAuditOptions(["--limit=50001"]),
    ).toThrow("--limit must be between 1 and 50000");
  });

  it("rejects diagnostic inclusion without the owned local no-value boundary", () => {
    expect(() =>
      resolveCompetitiveStrategyAuditDiagnosticScope({
        includeDiagnostics: true,
        connectionString: "postgresql://audit:secret@127.0.0.1:5432/audit",
      }),
    ).toThrow(
      "COMPETITIVE_STRATEGY_AUDIT_DIAGNOSTIC_BOUNDARY=owned_local_no_value",
    );
  });

  it("restricts diagnostic inclusion to loopback and marks it non-production", () => {
    expect(() =>
      resolveCompetitiveStrategyAuditDiagnosticScope({
        includeDiagnostics: true,
        connectionString: "postgresql://audit:secret@database.example/audit",
        configuredBoundary: "owned_local_no_value",
      }),
    ).toThrow("restricted to an owned loopback database");
    expect(
      resolveCompetitiveStrategyAuditDiagnosticScope({
        includeDiagnostics: true,
        connectionString: "postgresql://audit:secret@127.0.0.1:5432/audit",
        configuredBoundary: "owned_local_no_value",
      }),
    ).toEqual({
      included: true,
      boundary: "owned_local_no_value",
      productionMetricsEligible: false,
    });
  });

  it("keeps the default production scope diagnostic-free", () => {
    expect(
      resolveCompetitiveStrategyAuditDiagnosticScope({
        includeDiagnostics: false,
        connectionString: "postgresql://production.example/audit",
      }),
    ).toEqual({
      included: false,
      boundary: "excluded",
      productionMetricsEligible: true,
    });
  });
});
