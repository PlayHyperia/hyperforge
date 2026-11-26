import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaderboardScreen } from "../../../src/screens/LeaderboardScreen";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const cycle = {
  cycleId: "cycle-1",
  phase: "IDLE",
  cycleStartTime: 1_000,
  phaseStartTime: 1_000,
  phaseEndTime: 1_000,
  timeRemaining: 0,
  agent1: null,
  agent2: null,
  countdown: null,
  winnerId: null,
  winnerName: null,
  outcome: null,
  winReason: null,
};

const leaderboard = [
  {
    rank: 1,
    characterId: "agent-a",
    name: "Riven Ash",
    provider: "scripted",
    model: "melee",
    wins: 2,
    draws: 1,
    losses: 3,
    winRate: 0.4,
    combatLevel: 42,
    currentStreak: 0,
  },
];

function mockLeaderboardResponse(payload: Record<string, unknown>): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => payload,
  } as Response);
}

describe("LeaderboardScreen outcomes", () => {
  it("renders an active cancellation as neutral viewer-safe no-contest copy", async () => {
    mockLeaderboardResponse({
      leaderboard,
      cycle,
      terminalNotice: {
        cycleId: "cycle-1",
        duelId: "duel-1",
        outcome: "cancelled",
        reason: "agent_disconnect",
        occurredAt: 1_000,
        expiresAt: 11_000,
        agent1Id: "agent-a",
        agent1Name: "Riven Ash",
        agent2Id: "agent-b",
        agent2Name: "Astra Vale",
      },
      recentDuels: [
        {
          cycleId: "cycle-1",
          duelId: "duel-1",
          finishedAt: Date.now(),
          outcome: "cancelled",
          agent1Id: "agent-a",
          agent1Name: "Riven Ash",
          agent2Id: "agent-b",
          agent2Name: "Astra Vale",
          winnerId: null,
          winnerName: null,
          loserId: null,
          loserName: null,
          winReason: null,
          cancellationReason: "agent_disconnect",
          damageAgent1: 0,
          damageAgent2: 0,
          damageWinner: null,
          damageLoser: null,
        },
      ],
      updatedAt: Date.now(),
    });

    render(<LeaderboardScreen />);

    expect(
      (await screen.findAllByText("No contest")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/No winner was declared/i)).toBeInTheDocument();
    expect(screen.getByText("Riven Ash vs Astra Vale")).toBeInTheDocument();
    expect(screen.queryByText(/agent_disconnect/i)).not.toBeInTheDocument();
  });

  it("renders draws neutrally and keeps them visible in the ladder record", async () => {
    mockLeaderboardResponse({
      leaderboard,
      cycle: {
        ...cycle,
        phase: "RESOLUTION",
        outcome: "draw",
        winReason: "draw",
      },
      terminalNotice: null,
      recentDuels: [
        {
          cycleId: "cycle-1",
          duelId: "duel-1",
          finishedAt: Date.now(),
          outcome: "draw",
          agent1Id: "agent-a",
          agent1Name: "Riven Ash",
          agent2Id: "agent-b",
          agent2Name: "Astra Vale",
          winnerId: null,
          winnerName: null,
          loserId: null,
          loserName: null,
          winReason: "draw",
          damageAgent1: 12,
          damageAgent2: 12,
          damageWinner: null,
          damageLoser: null,
        },
      ],
      updatedAt: Date.now(),
    });

    render(<LeaderboardScreen />);

    expect(await screen.findByText("Draw — no winner")).toBeInTheDocument();
    expect(await screen.findByText("DRAW")).toBeInTheDocument();
    expect(screen.getAllByText("Draw").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("2-1-3")).toHaveLength(2);
  });
});
