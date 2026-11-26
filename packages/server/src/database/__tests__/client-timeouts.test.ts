import { describe, expect, it } from "vitest";

import { resolvePostgresPoolTimeouts } from "../client";

describe("resolvePostgresPoolTimeouts", () => {
  it("uses bounded defaults with server cancellation before client timeout", () => {
    expect(resolvePostgresPoolTimeouts({})).toEqual({
      connectionTimeoutMillis: 10_000,
      statementTimeoutMillis: 15_000,
      queryTimeoutMillis: 20_000,
    });
  });

  it("accepts explicit valid timeout limits", () => {
    expect(
      resolvePostgresPoolTimeouts({
        POSTGRES_CONNECTION_TIMEOUT_MS: "2500",
        POSTGRES_STATEMENT_TIMEOUT_MS: "4000",
        POSTGRES_QUERY_TIMEOUT_MS: "4500",
      }),
    ).toEqual({
      connectionTimeoutMillis: 2_500,
      statementTimeoutMillis: 4_000,
      queryTimeoutMillis: 4_500,
    });
  });

  it.each([
    ["POSTGRES_CONNECTION_TIMEOUT_MS", "999"],
    ["POSTGRES_STATEMENT_TIMEOUT_MS", "1.5"],
    ["POSTGRES_QUERY_TIMEOUT_MS", "not-a-duration"],
    ["POSTGRES_QUERY_TIMEOUT_MS", "300001"],
  ])("rejects an unsafe %s value", (name, value) => {
    expect(() => resolvePostgresPoolTimeouts({ [name]: value })).toThrow(name);
  });

  it("rejects a client timeout that cannot outlive server cancellation", () => {
    expect(() =>
      resolvePostgresPoolTimeouts({
        POSTGRES_STATEMENT_TIMEOUT_MS: "5000",
        POSTGRES_QUERY_TIMEOUT_MS: "5000",
      }),
    ).toThrow(
      "POSTGRES_QUERY_TIMEOUT_MS must be greater than POSTGRES_STATEMENT_TIMEOUT_MS",
    );
  });
});
