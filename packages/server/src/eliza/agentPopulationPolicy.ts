export type AgentPopulationDecisionReason =
  | "model_agents_not_requested"
  | "no_embedded_agents"
  | "mixed_population_explicitly_allowed"
  | "embedded_population_active";

export interface AgentPopulationPolicyInput {
  embeddedAgentCount: number;
  spawnModelAgentsRequested: boolean;
  allowModelAgentsWithEmbedded: boolean;
}

export interface AgentPopulationPolicyDecision {
  spawnModelAgents: boolean;
  reason: AgentPopulationDecisionReason;
}

export interface LegacyModelAgentMappingInput {
  agentId: string;
  accountId: string;
  characterId: string;
  agentName: string;
}

export interface ExistingAgentMappingIdentity {
  agentId: string;
  accountId: string;
  characterId: string;
}

/**
 * Keep the persisted embedded-agent population and the legacy model-agent
 * spawner mutually exclusive by default. They have different lifecycle and
 * mutation authorities, so silently running both makes population size and
 * custody ownership ambiguous.
 */
export function resolveAgentPopulationPolicy(
  input: AgentPopulationPolicyInput,
): AgentPopulationPolicyDecision {
  if (
    !Number.isSafeInteger(input.embeddedAgentCount) ||
    input.embeddedAgentCount < 0
  ) {
    throw new Error("embedded_agent_count_invalid");
  }

  if (!input.spawnModelAgentsRequested) {
    return {
      spawnModelAgents: false,
      reason: "model_agents_not_requested",
    };
  }

  if (input.embeddedAgentCount === 0) {
    return {
      spawnModelAgents: true,
      reason: "no_embedded_agents",
    };
  }

  if (input.allowModelAgentsWithEmbedded) {
    return {
      spawnModelAgents: true,
      reason: "mixed_population_explicitly_allowed",
    };
  }

  return {
    spawnModelAgents: false,
    reason: "embedded_population_active",
  };
}

export function isExplicitlyEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isPersistedStreamingDuelEligible(value: unknown): boolean {
  return value === true;
}

export function resolvePersistedStreamingDuelEligibility(
  values: readonly unknown[],
): boolean {
  return values.length === 1 && isPersistedStreamingDuelEligible(values[0]);
}

export function isLegacyModelAgentMappingClaimSafe(
  existingMappings: readonly ExistingAgentMappingIdentity[],
  expected: Pick<
    LegacyModelAgentMappingInput,
    "agentId" | "accountId" | "characterId"
  >,
): boolean {
  if (existingMappings.length === 0) return true;
  return (
    existingMappings.length === 1 &&
    existingMappings[0]?.agentId === expected.agentId &&
    existingMappings[0]?.accountId === expected.accountId &&
    existingMappings[0]?.characterId === expected.characterId
  );
}

export function buildLegacyModelAgentMapping(
  input: LegacyModelAgentMappingInput,
  timestamp: Date,
) {
  if (
    Object.values(input).some(
      (value) => typeof value !== "string" || value.trim().length === 0,
    ) ||
    !Number.isFinite(timestamp.getTime())
  ) {
    throw new Error("legacy_model_agent_mapping_invalid");
  }

  const common = {
    accountId: input.accountId,
    characterId: input.characterId,
    agentName: input.agentName,
    streamingDuelEnabled: false as const,
    updatedAt: timestamp,
  };
  return {
    insert: {
      agentId: input.agentId,
      ...common,
      createdAt: timestamp,
    },
    update: common,
  };
}
