export const DUEL_PREPARATION_EXTERNAL_AGENT_BUILD_IDS_ENV =
  "DUEL_PREPARATION_EXTERNAL_AGENT_BUILD_IDS" as const;

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_ALLOWED_EXTERNAL_AGENT_BUILDS = 32;

/**
 * Resolve the deployment-owned allowlist for external ElizaOS executable
 * builds. Production never accepts an unpinned self-reported build identity.
 * A null policy is limited to non-production diagnostics and tests.
 */
export function resolveExternalAgentBuildAllowlist(input: {
  nodeEnv: string | undefined;
  configuredBuildIds: string | undefined;
}): ReadonlySet<string> | null {
  const configured = input.configuredBuildIds ?? "";
  if (!configured) {
    if (input.nodeEnv === "production" || input.nodeEnv === "staging") {
      throw new Error(
        `${DUEL_PREPARATION_EXTERNAL_AGENT_BUILD_IDS_ENV} is required in production and staging`,
      );
    }
    return null;
  }
  const values = configured.split(",");
  if (
    values.length < 1 ||
    values.length > MAX_ALLOWED_EXTERNAL_AGENT_BUILDS ||
    values.some((value) => !SHA256_HEX.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(
      `${DUEL_PREPARATION_EXTERNAL_AGENT_BUILD_IDS_ENV} must contain one to ${MAX_ALLOWED_EXTERNAL_AGENT_BUILDS} unique lowercase SHA-256 build IDs`,
    );
  }
  return new Set(values);
}

export function isExternalAgentBuildAllowed(input: {
  buildId: string;
  nodeEnv?: string;
  configuredBuildIds?: string;
}): boolean {
  if (!SHA256_HEX.test(input.buildId)) return false;
  const allowlist = resolveExternalAgentBuildAllowlist({
    nodeEnv: input.nodeEnv ?? process.env.NODE_ENV,
    configuredBuildIds:
      input.configuredBuildIds ??
      process.env[DUEL_PREPARATION_EXTERNAL_AGENT_BUILD_IDS_ENV],
  });
  return allowlist === null || allowlist.has(input.buildId);
}
