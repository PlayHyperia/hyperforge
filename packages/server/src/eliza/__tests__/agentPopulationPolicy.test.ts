import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildLegacyModelAgentMapping,
  isExplicitlyEnabled,
  isLegacyModelAgentMappingClaimSafe,
  isPersistedStreamingDuelEligible,
  resolvePersistedStreamingDuelEligibility,
  resolveAgentPopulationPolicy,
} from "../agentPopulationPolicy.js";

const agentIndexSource = readFileSync(
  fileURLToPath(new URL("../index.ts", import.meta.url)),
  "utf8",
);
const modelAgentSpawnerSource = readFileSync(
  fileURLToPath(new URL("../ModelAgentSpawner.ts", import.meta.url)),
  "utf8",
);
const streamingSchedulerSource = readFileSync(
  fileURLToPath(
    new URL("../../systems/StreamingDuelScheduler/index.ts", import.meta.url),
  ),
  "utf8",
);
const agentRoutesSource = readFileSync(
  fileURLToPath(
    new URL("../../startup/routes/agent-routes.ts", import.meta.url),
  ),
  "utf8",
);
const adminRoutesSource = readFileSync(
  fileURLToPath(
    new URL("../../startup/routes/admin-routes.ts", import.meta.url),
  ),
  "utf8",
);
const uniqueMappingMigrationSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../database/migrations/0089_require_unique_agent_character_mapping.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const participationDefaultMigrationSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../database/migrations/0090_default_agent_streaming_duel_participation_off.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const participationAuthoritySource = readFileSync(
  fileURLToPath(
    new URL("../../database/streaming-duel-participation.ts", import.meta.url),
  ),
  "utf8",
);
const solanaAuthMigrationSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../database/migrations/0091_add_replay_safe_solana_agent_auth.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const solanaAuthStoreSource = readFileSync(
  fileURLToPath(
    new URL("../../database/solana-agent-auth.ts", import.meta.url),
  ),
  "utf8",
);
const credentialSessionMigrationSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../database/migrations/0092_add_revocable_agent_credential_sessions.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const credentialSessionStoreSource = readFileSync(
  fileURLToPath(
    new URL("../../database/agent-credential-sessions.ts", import.meta.url),
  ),
  "utf8",
);
const serverAuthenticationSource = readFileSync(
  fileURLToPath(
    new URL("../../systems/ServerNetwork/authentication.ts", import.meta.url),
  ),
  "utf8",
);
const elizaDuelBotSource = readFileSync(
  fileURLToPath(new URL("../ElizaDuelBot.ts", import.meta.url)),
  "utf8",
);
const pluginAppRuntimeSource = readFileSync(
  fileURLToPath(
    new URL("../../../../plugin-hyperia/src/app-runtime.ts", import.meta.url),
  ),
  "utf8",
);
const serverMainSource = readFileSync(
  fileURLToPath(new URL("../../main.ts", import.meta.url)),
  "utf8",
);

describe("agent population policy", () => {
  it("does not spawn a second population beside persisted embedded agents", () => {
    expect(
      resolveAgentPopulationPolicy({
        embeddedAgentCount: 10,
        spawnModelAgentsRequested: true,
        allowModelAgentsWithEmbedded: false,
      }),
    ).toEqual({
      spawnModelAgents: false,
      reason: "embedded_population_active",
    });
  });

  it("allows the model spawner when it is the only requested population", () => {
    expect(
      resolveAgentPopulationPolicy({
        embeddedAgentCount: 0,
        spawnModelAgentsRequested: true,
        allowModelAgentsWithEmbedded: false,
      }),
    ).toEqual({
      spawnModelAgents: true,
      reason: "no_embedded_agents",
    });
  });

  it("requires an explicit mixed-population override", () => {
    expect(
      resolveAgentPopulationPolicy({
        embeddedAgentCount: 2,
        spawnModelAgentsRequested: true,
        allowModelAgentsWithEmbedded: true,
      }),
    ).toEqual({
      spawnModelAgents: true,
      reason: "mixed_population_explicitly_allowed",
    });
  });

  it("honors an explicit model-spawner disable", () => {
    expect(
      resolveAgentPopulationPolicy({
        embeddedAgentCount: 0,
        spawnModelAgentsRequested: false,
        allowModelAgentsWithEmbedded: true,
      }),
    ).toEqual({
      spawnModelAgents: false,
      reason: "model_agents_not_requested",
    });
  });

  it("fails closed on an invalid embedded population count", () => {
    for (const embeddedAgentCount of [-1, 1.5, Number.NaN]) {
      expect(() =>
        resolveAgentPopulationPolicy({
          embeddedAgentCount,
          spawnModelAgentsRequested: true,
          allowModelAgentsWithEmbedded: false,
        }),
      ).toThrow("embedded_agent_count_invalid");
    }
  });

  it("accepts only the exact true boolean spelling after normalization", () => {
    expect(isExplicitlyEnabled("true")).toBe(true);
    expect(isExplicitlyEnabled(" TRUE ")).toBe(true);
    for (const value of [undefined, "", "false", "1", "yes", "true-ish"]) {
      expect(isExplicitlyEnabled(value)).toBe(false);
    }
  });

  it("requires an exact persisted positive duel preference", () => {
    expect(isPersistedStreamingDuelEligible(true)).toBe(true);
    for (const value of [false, undefined, null, 1, "true", {}]) {
      expect(isPersistedStreamingDuelEligible(value)).toBe(false);
    }
    expect(resolvePersistedStreamingDuelEligibility([true])).toBe(true);
    for (const values of [[], [false], [true, true], [true, false]]) {
      expect(resolvePersistedStreamingDuelEligibility(values)).toBe(false);
    }
  });

  it("allows the legacy runtime to claim only its exact existing mapping", () => {
    const expected = {
      agentId: "agent-openai-example",
      accountId: "model-agents-account",
      characterId: "agent-openai-example",
    };
    expect(isLegacyModelAgentMappingClaimSafe([], expected)).toBe(true);
    expect(isLegacyModelAgentMappingClaimSafe([expected], expected)).toBe(true);
    expect(
      isLegacyModelAgentMappingClaimSafe(
        [{ ...expected, accountId: "owner-account" }],
        expected,
      ),
    ).toBe(false);
    expect(
      isLegacyModelAgentMappingClaimSafe([expected, expected], expected),
    ).toBe(false);
  });

  it("builds both legacy model-agent mapping writes as explicit opt-outs", () => {
    const timestamp = new Date("2026-08-27T04:00:00.000Z");
    const mapping = buildLegacyModelAgentMapping(
      {
        agentId: "agent-openai-example",
        accountId: "model-agents-account",
        characterId: "agent-openai-example",
        agentName: "Example",
      },
      timestamp,
    );

    expect(mapping).toEqual({
      insert: {
        agentId: "agent-openai-example",
        accountId: "model-agents-account",
        characterId: "agent-openai-example",
        agentName: "Example",
        streamingDuelEnabled: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      update: {
        accountId: "model-agents-account",
        characterId: "agent-openai-example",
        agentName: "Example",
        streamingDuelEnabled: false,
        updatedAt: timestamp,
      },
    });
    expect(() =>
      buildLegacyModelAgentMapping(
        {
          agentId: "",
          accountId: "model-agents-account",
          characterId: "agent-openai-example",
          agentName: "Example",
        },
        timestamp,
      ),
    ).toThrow("legacy_model_agent_mapping_invalid");
  });

  it("applies the population decision before any model plugin discovery", () => {
    expect(agentIndexSource).toContain(
      "embeddedAgentCount = manager.getAllAgents().length",
    );
    expect(agentIndexSource).toContain(
      "isExplicitlyEnabled(process.env.SPAWN_MODEL_AGENTS_WITH_EMBEDDED)",
    );
    expect(
      agentIndexSource.indexOf("resolveAgentPopulationPolicy({"),
    ).toBeLessThan(agentIndexSource.indexOf("getAvailableModels()"));
    expect(agentIndexSource).toContain(
      "const shouldSpawnAgents = populationDecision.spawnModelAgents",
    );
  });

  it("fails startup when the streaming-duel agent authority cannot initialize", () => {
    const agentInitialization = serverMainSource.slice(
      serverMainSource.indexOf("// Step 9: Initialize embedded agents"),
      serverMainSource.indexOf(
        "// Step 10: Initialize stream capture pipeline",
      ),
    );
    expect(agentInitialization).toContain("if (streamingDuelEnabled)");
    expect(agentInitialization).toContain(
      "Streaming duel agent initialization failed",
    );
    expect(
      agentInitialization.indexOf("if (streamingDuelEnabled)"),
    ).toBeLessThan(agentInitialization.indexOf("continuing without agents"));
  });

  it("keeps the legacy model-only population outside competitive matchmaking", () => {
    expect(modelAgentSpawnerSource).toContain(".insert(agentMappings)");
    expect(modelAgentSpawnerSource).toContain("buildLegacyModelAgentMapping(");
    expect(modelAgentSpawnerSource).toContain(
      "isLegacyModelAgentMappingClaimSafe(existingMappings",
    );
    expect(
      modelAgentSpawnerSource.indexOf(".insert(agentMappings)"),
    ).toBeLessThan(
      modelAgentSpawnerSource.indexOf(
        '_ensureServiceStarted("hyperiaService")',
      ),
    );
    expect(streamingSchedulerSource).toContain(
      "resolvePersistedStreamingDuelEligibility(",
    );
    expect(streamingSchedulerSource).toContain(".limit(2)");
    expect(streamingSchedulerSource).not.toContain("bypassStreamingDuelOptOut");
    expect(streamingSchedulerSource).toContain(
      "assertLocalDiagnosticContestantAuthority(process.env)",
    );
    expect(
      adminRoutesSource.match(
        /preHandler: \[requireAdmin, requireDiagnosticContestantAuthority\]/gu,
      ),
    ).toHaveLength(3);
    expect(streamingSchedulerSource).toContain(
      "Matchmaking remains disabled for this agent.",
    );
    expect(streamingSchedulerSource).toContain(
      "Database-backed duel participation authority is unavailable. Matchmaking remains disabled for unverified agents.",
    );
    expect(streamingSchedulerSource).toContain(
      "isLocalDiagnosticDuelRuntime(process.env)",
    );
    expect(agentRoutesSource).toContain(
      "streamingDuelEnabled: mapping.streamingDuelEnabled === true",
    );
    expect(agentRoutesSource).toMatch(
      /if \(runningAgentMapping\)[\s\S]*?streamingDuelEnabled: false/,
    );
    expect(uniqueMappingMigrationSource).toContain("HAVING count(*) > 1");
    expect(uniqueMappingMigrationSource).toContain(
      'CREATE UNIQUE INDEX "idx_agent_mappings_character"',
    );
    expect(participationDefaultMigrationSource).toContain(
      'ALTER COLUMN "streaming_duel_enabled" SET DEFAULT false',
    );
    expect(participationAuthoritySource).toContain(
      "lockAndAssertPersistedStreamingDuelParticipation",
    );
    expect(participationAuthoritySource).toContain(
      "snapshot.\"lifecycleStatus\" IN ('frozen', 'terminal')",
    );
    expect(participationAuthoritySource).toContain(
      '"streaming_duel_enabled", "created_at", "updated_at"',
    );
    expect(agentRoutesSource).toContain(
      "updatePersistedStreamingDuelParticipation",
    );
    expect(agentRoutesSource).not.toContain(
      "scheduler?.unregisterAgent(agentId)",
    );
    expect(
      agentRoutesSource.match(/preHandler: requireOwnedAgentMutation/gu),
    ).toHaveLength(25);
    expect(agentRoutesSource).toMatch(
      /fastify\.post\("\/api\/agents\/wallet-auth"[\s\S]*?if \(!isLocalDiagnosticDuelRuntime\(process\.env\)\)/u,
    );
    expect(agentRoutesSource).not.toContain("Auto-creating character");
    expect(agentRoutesSource).toContain("executeOwnedAgentMutation");
    expect(agentRoutesSource).toContain("savePersistedAgentMapping");
  });

  it("keeps the production external-agent credential path SOL-only and proof-bound", () => {
    expect(agentRoutesSource).toContain(
      '"/api/agents/sol-wallet-auth/challenge"',
    );
    expect(agentRoutesSource).toContain('"/api/agents/sol-wallet-auth/verify"');
    expect(agentRoutesSource).toMatch(
      /verifyAndConsumeSolanaAgentAuthChallenge[\s\S]*?createAgentCredentialToken\([\s\S]*?identity\.credentialSession/u,
    );
    expect(agentRoutesSource).toMatch(
      /fastify\.post\("\/api\/agents\/wallet-auth"[\s\S]*?isLocalDiagnosticDuelRuntime/u,
    );
    expect(solanaAuthStoreSource).toContain("FOR UPDATE");
    expect(solanaAuthStoreSource).toContain("pg_advisory_xact_lock");
    expect(solanaAuthStoreSource).toContain("MAX_FAILED_ATTEMPTS = 5");
    expect(solanaAuthMigrationSource).toContain(
      "enforce_solana_agent_auth_challenge_immutability",
    );
    expect(credentialSessionMigrationSource).toContain(
      'CREATE UNIQUE INDEX "idx_agent_credential_sessions_one_active"',
    );
    expect(credentialSessionMigrationSource).toContain(
      "enforce_agent_credential_session_immutability",
    );
    expect(credentialSessionStoreSource).toContain(
      "rotateAgentCredentialSessionWithClient",
    );
    expect(serverAuthenticationSource).toContain(
      "verifyAgentCredentialSessionWithSystemDatabase",
    );
    expect(modelAgentSpawnerSource).toContain(
      'authMethod: "server-managed-agent-v1"',
    );
    expect(modelAgentSpawnerSource).toContain("buildAgentCredentialJwtPayload");
    expect(elizaDuelBotSource).toMatch(
      /connect\(\): Promise<void>[\s\S]*?isLocalDiagnosticDuelRuntime\(process\.env\)[\s\S]*?createJWT/u,
    );
    expect(pluginAppRuntimeSource).toContain(
      'new URL("/api/agents/sol-wallet-auth/challenge"',
    );
    expect(pluginAppRuntimeSource).toContain(
      '"/api/agents/credentials/status"',
    );
    expect(pluginAppRuntimeSource).toContain(
      'new URL("/api/agents/sol-wallet-auth/verify"',
    );
    expect(pluginAppRuntimeSource).toContain("signSolanaMessage");
    expect(pluginAppRuntimeSource).not.toContain(
      'new URL("/api/agents/wallet-auth"',
    );
    expect(pluginAppRuntimeSource).not.toContain('walletType: "evm"');
  });
});
