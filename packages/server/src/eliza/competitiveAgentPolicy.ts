import { createHash } from "node:crypto";
import type { AgentRuntime } from "@elizaos/core";
import {
  EXTERNAL_DUEL_PREPARATION_MODEL,
  EXTERNAL_DUEL_PREPARATION_MODEL_PROVIDER,
  EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION,
} from "@hyperforge/shared";

import { DUEL_COMBAT_POLICY_VERSION } from "../systems/StreamingDuelScheduler/competitive-snapshot.js";
import type { EmbeddedAgentConfig } from "./types.js";

export const COMPETITIVE_AGENT_POLICY_BINDING_VERSION =
  "competitive-agent-policy-v2" as const;

export type CompetitiveAgentPolicyBinding = {
  fingerprint: string;
  provider: string;
  model: string;
  runtime: AgentRuntime | null;
  decisionRuntime: "embedded" | "authenticated_external" | "none";
  combatControllerEnabled: boolean;
};

type RuntimeInfo = {
  provider: string;
  model: string;
  source: string;
} | null;

const SAFE_POLICY_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,127}$/;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("competitive agent policy contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("competitive agent policy contains an unsupported value");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicCharacterPolicy(config: EmbeddedAgentConfig): object {
  const character = config.characterConfig;
  return {
    name: character?.name ?? config.name,
    username: character?.username ?? null,
    system: character?.system ?? null,
    bio: character?.bio ?? [],
    topics: character?.topics ?? [],
    adjectives: character?.adjectives ?? [],
    plugins: character?.plugins ?? [],
    style: {
      all: character?.style?.all ?? [],
      chat: character?.style?.chat ?? [],
      post: character?.style?.post ?? [],
    },
    modelProvider: character?.modelProvider ?? config.modelProvider ?? null,
    model:
      typeof character?.settings?.model === "string"
        ? character.settings.model
        : (config.model ?? null),
  };
}

/**
 * Commit the complete policy boundary that can affect a competitive duel.
 * Secrets never enter the public commitment. The already-private runtime
 * configuration signature is hashed once more so a runtime replacement is
 * detectable without making credentials or their serialized form observable.
 */
export function buildCompetitiveAgentPolicyBinding(input: {
  config: EmbeddedAgentConfig;
  planningPolicyVersion: string;
  llmEnabled: boolean;
  runtime: AgentRuntime | null;
  runtimeInfo: RuntimeInfo;
  runtimeConfigSignature?: string;
  authenticatedExternalDecision: boolean;
  externalExecutableBuildId: string | null;
  executableBuildId: string;
  combatControllerEnabled: boolean;
}): CompetitiveAgentPolicyBinding {
  if (!SAFE_POLICY_VERSION.test(input.planningPolicyVersion)) {
    throw new Error("invalid competitive planning policy version");
  }
  if ((input.runtime === null) !== (input.runtimeInfo === null)) {
    throw new Error("competitive agent runtime identity is incomplete");
  }
  if (input.authenticatedExternalDecision && input.runtime !== null) {
    throw new Error("competitive agent policy has multiple decision runtimes");
  }
  if (
    (input.authenticatedExternalDecision &&
      !/^[0-9a-f]{64}$/u.test(input.externalExecutableBuildId ?? "")) ||
    (!input.authenticatedExternalDecision &&
      input.externalExecutableBuildId !== null)
  ) {
    throw new Error(
      "competitive external executable build identity is inconsistent",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.executableBuildId)) {
    throw new Error("competitive executable build identity is invalid");
  }

  const decisionRuntime = input.runtime
    ? "embedded"
    : input.authenticatedExternalDecision
      ? "authenticated_external"
      : "none";
  const provider =
    input.runtimeInfo?.provider ??
    (input.authenticatedExternalDecision
      ? EXTERNAL_DUEL_PREPARATION_MODEL_PROVIDER
      : "deterministic");
  const model =
    input.runtimeInfo?.model ??
    (input.authenticatedExternalDecision
      ? EXTERNAL_DUEL_PREPARATION_MODEL
      : "deterministic");
  const payload = {
    bindingVersion: COMPETITIVE_AGENT_POLICY_BINDING_VERSION,
    combatPolicyVersion: DUEL_COMBAT_POLICY_VERSION,
    planningPolicyVersion: input.planningPolicyVersion,
    executableBuildId: input.executableBuildId,
    characterId: input.config.characterId,
    displayName: input.config.name,
    scriptedRole: input.config.scriptedRole ?? null,
    llmEnabled: input.llmEnabled,
    combatControllerEnabled: input.combatControllerEnabled,
    runtime: {
      available: input.runtime !== null,
      decisionRuntime,
      provider,
      model,
      source:
        input.runtimeInfo?.source ??
        (input.authenticatedExternalDecision
          ? EXTERNAL_DUEL_PREPARATION_STRATEGY_PROTOCOL_VERSION
          : "deterministic"),
      externalExecutableBuildId: input.externalExecutableBuildId,
      configFingerprint: input.runtimeConfigSignature
        ? hashText(input.runtimeConfigSignature)
        : null,
    },
    characterPolicy: publicCharacterPolicy(input.config),
  };

  return {
    fingerprint: hashText(canonicalJson(payload)),
    provider,
    model,
    runtime: input.runtime,
    decisionRuntime,
    combatControllerEnabled: input.combatControllerEnabled,
  };
}
