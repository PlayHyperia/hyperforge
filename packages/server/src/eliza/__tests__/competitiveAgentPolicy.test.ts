import { describe, expect, it, vi } from "vitest";

import { buildCompetitiveAgentPolicyBinding } from "../competitiveAgentPolicy.js";
import type { EmbeddedAgentConfig } from "../types.js";

const runtime = {
  useModel: vi.fn(),
  stop: vi.fn(),
} as never;

function config(
  overrides: Partial<EmbeddedAgentConfig> = {},
): EmbeddedAgentConfig {
  return {
    characterId: "agent-policy-a",
    accountId: "private-account",
    name: "Policy Agent",
    scriptedRole: "combat",
    enableLlm: true,
    modelProvider: "openai",
    model: "provider/model-a",
    characterConfig: {
      name: "Policy Agent",
      system: "Favor ranged spacing and preserve supplies.",
      bio: ["A careful arena tactician."],
      topics: ["combat"],
      adjectives: ["patient"],
      plugins: ["hyperia"],
      settings: {
        model: "provider/model-a",
        secrets: { OPENAI_API_KEY: "super-secret-value" },
      },
      style: { all: ["concise"], chat: [], post: [] },
    },
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return buildCompetitiveAgentPolicyBinding({
    config: config(),
    planningPolicyVersion: "duel-preparation-role-v1",
    llmEnabled: true,
    runtime,
    runtimeInfo: {
      provider: "openai",
      model: "provider/model-a",
      source: "character",
    },
    runtimeConfigSignature: "private-runtime-config-with-secret",
    authenticatedExternalDecision: false,
    externalExecutableBuildId: null,
    executableBuildId: "11".repeat(32),
    combatControllerEnabled: true,
    ...overrides,
  });
}

describe("competitive agent policy binding", () => {
  it("is stable for the same semantic configuration", () => {
    expect(binding().fingerprint).toBe(binding().fingerprint);
    expect(binding()).toMatchObject({
      provider: "openai",
      model: "provider/model-a",
      runtime,
      decisionRuntime: "embedded",
      combatControllerEnabled: true,
    });
  });

  it("labels authenticated external decisions without claiming remote model attestation", () => {
    expect(
      binding({
        runtime: null,
        runtimeInfo: null,
        runtimeConfigSignature: undefined,
        authenticatedExternalDecision: true,
        externalExecutableBuildId: "33".repeat(32),
      }),
    ).toMatchObject({
      provider: "external-elizaos",
      model: "authenticated-remote-strategy-v5",
      runtime: null,
      decisionRuntime: "authenticated_external",
    });
    expect(() => binding({ authenticatedExternalDecision: true })).toThrow(
      "multiple decision runtimes",
    );
    expect(() =>
      binding({
        runtime: null,
        runtimeInfo: null,
        authenticatedExternalDecision: true,
        externalExecutableBuildId: null,
      }),
    ).toThrow("external executable build identity is inconsistent");
  });

  it("changes for every runtime or executor control that can alter combat", () => {
    const fingerprints = [
      binding().fingerprint,
      binding({ planningPolicyVersion: "duel-preparation-role-v2" })
        .fingerprint,
      binding({ runtimeConfigSignature: "different-private-runtime-config" })
        .fingerprint,
      binding({ executableBuildId: "22".repeat(32) }).fingerprint,
      binding({
        runtime: null,
        runtimeInfo: null,
        runtimeConfigSignature: undefined,
        authenticatedExternalDecision: true,
        externalExecutableBuildId: "33".repeat(32),
      }).fingerprint,
      binding({
        runtime: null,
        runtimeInfo: null,
        runtimeConfigSignature: undefined,
        authenticatedExternalDecision: true,
        externalExecutableBuildId: "44".repeat(32),
      }).fingerprint,
      binding({ combatControllerEnabled: false }).fingerprint,
      binding({
        runtimeInfo: {
          provider: "openai",
          model: "provider/model-b",
          source: "character",
        },
      }).fingerprint,
      binding({
        config: config({
          characterConfig: {
            ...config().characterConfig!,
            system: "Use an aggressive melee plan.",
          },
        }),
      }).fingerprint,
    ];
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it("uses an explicit deterministic identity when no model runtime exists", () => {
    expect(binding({ runtime: null, runtimeInfo: null }).provider).toBe(
      "deterministic",
    );
    expect(binding({ runtime: null, runtimeInfo: null })).toMatchObject({
      model: "deterministic",
      runtime: null,
    });
  });

  it("rejects a runtime without its exact provider and model identity", () => {
    expect(() => binding({ runtimeInfo: null })).toThrow(
      /runtime identity is incomplete/,
    );
    expect(() => binding({ runtime: null })).toThrow(
      /runtime identity is incomplete/,
    );
  });

  it("exposes only a SHA-256 commitment rather than private configuration", () => {
    const result = binding();
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    expect(JSON.stringify(result)).not.toContain(
      "private-runtime-config-with-secret",
    );
  });
});
