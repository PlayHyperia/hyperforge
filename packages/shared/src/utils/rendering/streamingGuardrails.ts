export type StreamingGuardrailPhase =
  "IDLE" | "ANNOUNCEMENT" | "COUNTDOWN" | "FIGHTING" | "RESOLUTION";

export type StreamingGuardrailAgentSnapshot = {
  id: string | null | undefined;
  name: string | null | undefined;
  hp: number | null | undefined;
  maxHp: number | null | undefined;
};

export type StreamingGuardrailArenaPositions = {
  agent1: readonly number[] | null | undefined;
  agent2: readonly number[] | null | undefined;
};

export type ValidStreamingGuardrailArenaPositions = {
  agent1: readonly [number, number, number];
  agent2: readonly [number, number, number];
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isActiveStreamingGuardrailPhase(
  phase: StreamingGuardrailPhase | null | undefined,
): boolean {
  return Boolean(phase && phase !== "IDLE");
}

export function requiresStreamingArenaPositions(
  phase: StreamingGuardrailPhase | null | undefined,
): boolean {
  return (
    phase === "ANNOUNCEMENT" ||
    phase === "COUNTDOWN" ||
    phase === "FIGHTING" ||
    phase === "RESOLUTION"
  );
}

export function hasValidStreamingGuardrailAgentSnapshot(
  agent: StreamingGuardrailAgentSnapshot | null | undefined,
): boolean {
  if (!agent) return false;
  if (!agent.id?.trim() || !agent.name?.trim()) return false;
  if (!isFiniteNumber(agent.maxHp) || agent.maxHp <= 0) return false;
  if (!isFiniteNumber(agent.hp) || agent.hp < 0 || agent.hp > agent.maxHp) {
    return false;
  }
  return true;
}

export function hasValidStreamingGuardrailArenaPositions(
  arenaPositions: StreamingGuardrailArenaPositions | null | undefined,
): arenaPositions is ValidStreamingGuardrailArenaPositions {
  if (!arenaPositions) return false;
  const { agent1, agent2 } = arenaPositions;
  if (!Array.isArray(agent1) || !Array.isArray(agent2)) return false;
  if (agent1.length !== 3 || agent2.length !== 3) return false;
  if (![...agent1, ...agent2].every((value) => isFiniteNumber(value))) {
    return false;
  }
  const dx = agent1[0] - agent2[0];
  const dz = agent1[2] - agent2[2];
  return dx * dx + dz * dz >= 0.25 * 0.25;
}

export function deriveStreamingGuardrailReason(params: {
  phase: StreamingGuardrailPhase | null | undefined;
  agent1: StreamingGuardrailAgentSnapshot | null | undefined;
  agent2: StreamingGuardrailAgentSnapshot | null | undefined;
  arenaPositions: StreamingGuardrailArenaPositions | null | undefined;
}): string | null {
  if (!isActiveStreamingGuardrailPhase(params.phase)) {
    return null;
  }

  if (!params.agent1 || !params.agent2) {
    return "agents_missing";
  }

  if (
    !hasValidStreamingGuardrailAgentSnapshot(params.agent1) ||
    !hasValidStreamingGuardrailAgentSnapshot(params.agent2)
  ) {
    return "invalid_agent_hp";
  }

  if (
    requiresStreamingArenaPositions(params.phase) &&
    !hasValidStreamingGuardrailArenaPositions(params.arenaPositions)
  ) {
    return "arena_positions_invalid";
  }

  return null;
}
