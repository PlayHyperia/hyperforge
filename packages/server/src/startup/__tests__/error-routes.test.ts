import { describe, expect, it } from "vitest";

import { normalizeFrontendErrorReport } from "../routes/error-routes.js";

describe("frontend error report normalization", () => {
  it("bounds every caller-controlled field and trusts the request user agent", () => {
    const report = normalizeFrontendErrorReport(
      {
        message: "m".repeat(3_000),
        stack: "s".repeat(20_000),
        url: "u".repeat(3_000),
        userAgent: "caller-controlled-agent",
        context: { value: "c".repeat(8_000) },
      },
      "request-agent",
    );

    expect(report.message).toHaveLength(2_000);
    expect(report.stack).toHaveLength(16_000);
    expect(report.url).toHaveLength(2_048);
    expect(report.context?.length).toBeLessThanOrEqual(4_096);
    expect(report.userAgent).toBe("request-agent");
    expect(JSON.stringify(report)).not.toContain("caller-controlled-agent");
  });

  it("normalizes malformed bodies without reflecting arbitrary values", () => {
    expect(
      normalizeFrontendErrorReport("private raw value", undefined),
    ).toEqual({
      message: "Unknown frontend error",
      stack: undefined,
      url: undefined,
      userAgent: undefined,
      context: undefined,
    });
  });
});
