import { describe, expect, it } from "vitest";

import {
  isExternalAgentBuildAllowed,
  resolveExternalAgentBuildAllowlist,
} from "../external-agent-build-policy.js";

const buildA = "11".repeat(32);
const buildB = "22".repeat(32);

describe("external agent executable build policy", () => {
  it("requires an exact deployment-owned production allowlist", () => {
    expect(() =>
      resolveExternalAgentBuildAllowlist({
        nodeEnv: "production",
        configuredBuildIds: undefined,
      }),
    ).toThrow("required in production and staging");
    expect(
      isExternalAgentBuildAllowed({
        buildId: buildA,
        nodeEnv: "production",
        configuredBuildIds: `${buildA},${buildB}`,
      }),
    ).toBe(true);
    expect(
      isExternalAgentBuildAllowed({
        buildId: "33".repeat(32),
        nodeEnv: "production",
        configuredBuildIds: `${buildA},${buildB}`,
      }),
    ).toBe(false);
  });

  it("rejects malformed, duplicate, uppercase, and oversized configuration", () => {
    for (const configuredBuildIds of [
      "not-a-digest",
      `${buildA},${buildA}`,
      "ab".repeat(32).toUpperCase(),
      ` ${buildA}`,
      `${buildA}, ${buildB}`,
      Array.from({ length: 33 }, (_, index) =>
        index.toString(16).padStart(64, "0"),
      ).join(","),
    ]) {
      expect(() =>
        resolveExternalAgentBuildAllowlist({
          nodeEnv: "production",
          configuredBuildIds,
        }),
      ).toThrow("unique lowercase SHA-256");
    }
  });

  it("allows a structurally valid unpinned identity only outside production", () => {
    expect(
      isExternalAgentBuildAllowed({ buildId: buildA, nodeEnv: "test" }),
    ).toBe(true);
    expect(
      isExternalAgentBuildAllowed({ buildId: "invalid", nodeEnv: "test" }),
    ).toBe(false);
    expect(() =>
      resolveExternalAgentBuildAllowlist({
        nodeEnv: "staging",
        configuredBuildIds: undefined,
      }),
    ).toThrow("required in production and staging");
  });
});
