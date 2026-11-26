export const AGENT_CREDENTIAL_SESSION_VERSION = 1 as const;
export const AGENT_CREDENTIAL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AGENT_CREDENTIAL_AUTH_METHODS = [
  "sol-wallet-signature-v1",
  "owner-credential-v1",
  "local-diagnostic-wallet-v1",
  "server-managed-agent-v1",
] as const;

export type AgentCredentialAuthMethod =
  (typeof AGENT_CREDENTIAL_AUTH_METHODS)[number];

export type AgentCredentialSession = {
  accountId: string;
  authMethod: AgentCredentialAuthMethod;
  characterId: string;
  expiresAt: string;
  revokedSessionIds: string[];
  sessionId: string;
};

export type AgentCredentialClaims = {
  accountId: string;
  authMethod: AgentCredentialAuthMethod;
  characterId: string;
  expiresAt: string;
  sessionId: string;
};

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isBoundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isAgentCredentialAuthMethod(
  value: unknown,
): value is AgentCredentialAuthMethod {
  return AGENT_CREDENTIAL_AUTH_METHODS.some((method) => method === value);
}

export function buildAgentCredentialJwtPayload(
  session: Omit<AgentCredentialSession, "revokedSessionIds">,
  additionalClaims: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...additionalClaims,
    agentCredentialVersion: AGENT_CREDENTIAL_SESSION_VERSION,
    agentSessionExpiresAt: session.expiresAt,
    agentSessionId: session.sessionId,
    authMethod: session.authMethod,
    characterId: session.characterId,
    isAgent: true,
    jti: session.sessionId,
    userId: session.accountId,
  };
}

export function parseAgentCredentialClaims(
  payload: Record<string, unknown>,
): AgentCredentialClaims | null {
  if (
    payload.isAgent !== true ||
    payload.agentCredentialVersion !== AGENT_CREDENTIAL_SESSION_VERSION ||
    typeof payload.agentSessionId !== "string" ||
    !UUID_V4_PATTERN.test(payload.agentSessionId) ||
    payload.jti !== payload.agentSessionId ||
    !isBoundedIdentity(payload.userId) ||
    !isBoundedIdentity(payload.characterId) ||
    !isAgentCredentialAuthMethod(payload.authMethod) ||
    typeof payload.agentSessionExpiresAt !== "string"
  ) {
    return null;
  }

  const expiresAt = new Date(payload.agentSessionExpiresAt);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.toISOString() !== payload.agentSessionExpiresAt
  ) {
    return null;
  }

  return {
    accountId: payload.userId,
    authMethod: payload.authMethod,
    characterId: payload.characterId,
    expiresAt: payload.agentSessionExpiresAt,
    sessionId: payload.agentSessionId,
  };
}
