import {
  assertValidCompetitiveSnapshot,
  type CompetitiveSnapshot,
} from "./competitive-snapshot.js";

export type CompetitiveTerminalForStats = {
  outcome: "win" | "draw" | "cancelled";
  winnerId: string | null;
  terminalAt: number;
};

export type CompetitiveTerminalStatUpdate = {
  agentId: string;
  opponentId: string;
  name: string;
  provider: string;
  model: string;
  result: "win" | "loss" | "draw";
  winDelta: 0 | 1;
  lossDelta: 0 | 1;
  drawDelta: 0 | 1;
  anchoredWins: number;
  anchoredLosses: number;
  damageDealt: number;
  damageTaken: number;
  terminalAt: number;
};

/**
 * Derive the exact aggregate mutations represented by one immutable terminal.
 * Persistence adapters share this pure contract so ordinary resolution and
 * lethal-damage co-commit paths cannot disagree about records or damage.
 */
export function buildCompetitiveTerminalStatUpdates(
  snapshot: CompetitiveSnapshot,
  terminal: CompetitiveTerminalForStats,
  damageByAgent: ReadonlyMap<string, number>,
): CompetitiveTerminalStatUpdate[] {
  assertValidCompetitiveSnapshot(snapshot);
  if (terminal.outcome === "cancelled") return [];
  if (
    !Number.isSafeInteger(terminal.terminalAt) ||
    terminal.terminalAt < snapshot.frozenAt ||
    (terminal.outcome === "win" &&
      !snapshot.contestants.some(
        (contestant) => contestant.agentId === terminal.winnerId,
      )) ||
    (terminal.outcome === "draw" && terminal.winnerId !== null)
  ) {
    throw new Error("competitive_terminal_stats_invalid");
  }

  const contestantIds = new Set(
    snapshot.contestants.map((contestant) => contestant.agentId),
  );
  if (contestantIds.size !== 2) {
    throw new Error("competitive_terminal_stats_invalid");
  }
  for (const [agentId, damage] of damageByAgent) {
    if (
      !contestantIds.has(agentId) ||
      !Number.isSafeInteger(damage) ||
      damage < 0
    ) {
      throw new Error("competitive_terminal_stats_damage_invalid");
    }
  }

  return snapshot.contestants.map((contestant, index) => {
    const opponent = snapshot.contestants[index === 0 ? 1 : 0];
    const won =
      terminal.outcome === "win" && terminal.winnerId === contestant.agentId;
    const lost =
      terminal.outcome === "win" && terminal.winnerId === opponent.agentId;
    const winDelta = won ? 1 : 0;
    const lossDelta = lost ? 1 : 0;
    const drawDelta = terminal.outcome === "draw" ? 1 : 0;
    const anchoredWins = contestant.wins + winDelta;
    const anchoredLosses = contestant.losses + lossDelta;
    const damageDealt = damageByAgent.get(contestant.agentId) ?? 0;
    const damageTaken = damageByAgent.get(opponent.agentId) ?? 0;
    if (
      !Number.isSafeInteger(anchoredWins) ||
      !Number.isSafeInteger(anchoredLosses) ||
      !Number.isSafeInteger(damageDealt) ||
      !Number.isSafeInteger(damageTaken)
    ) {
      throw new Error("competitive_terminal_stats_invalid");
    }
    return {
      agentId: contestant.agentId,
      opponentId: opponent.agentId,
      name: contestant.name,
      provider: contestant.provider,
      model: contestant.model,
      result: won ? "win" : lost ? "loss" : "draw",
      winDelta,
      lossDelta,
      drawDelta,
      anchoredWins,
      anchoredLosses,
      damageDealt,
      damageTaken,
      terminalAt: terminal.terminalAt,
    };
  });
}
