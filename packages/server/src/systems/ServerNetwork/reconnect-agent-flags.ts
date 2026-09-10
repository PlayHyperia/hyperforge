type ReconnectEntityShape = {
  isAgent?: unknown;
  isEmbeddedAgent?: unknown;
  data?: {
    isAgent?: unknown;
    isEmbeddedAgent?: unknown;
  };
};

const isTrueFlag = (value: unknown): boolean => value === true || value === 1;

/**
 * Reconstruct immutable agent routing flags from the retained server entity.
 * Reconnect packets are never trusted to declare these capabilities.
 */
export function resolveReconnectAgentFlags(entity: unknown): {
  isAgent: boolean;
  isEmbeddedAgent: boolean;
} {
  const candidate = (entity ?? {}) as ReconnectEntityShape;
  const isEmbeddedAgent =
    isTrueFlag(candidate.isEmbeddedAgent) ||
    isTrueFlag(candidate.data?.isEmbeddedAgent);
  return {
    isEmbeddedAgent,
    isAgent:
      isEmbeddedAgent ||
      isTrueFlag(candidate.isAgent) ||
      isTrueFlag(candidate.data?.isAgent),
  };
}
