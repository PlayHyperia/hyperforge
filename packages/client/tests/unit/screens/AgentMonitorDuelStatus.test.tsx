import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DuelsTab,
  DuelStatusBar,
  SidebarRecentDuels,
  type RecentDuelEntry,
  type DuelStatusResponse,
} from "../../../src/screens/AgentMonitorScreen";

afterEach(cleanup);

const baseStatus: DuelStatusResponse = {
  currentCycle: null,
  terminalNotice: null,
  leaderboard: [],
  recentDuels: [],
  operationalMetrics: null,
  streamHealth: null,
};

const cancelledDuel: RecentDuelEntry = {
  cycleId: "cycle-cancelled",
  duelId: "duel-cancelled",
  finishedAt: Date.now() - 2_000,
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
  cancellationReason: "combat_engagement_failed",
  damageAgent1: 0,
  damageAgent2: 0,
  damageWinner: null,
  damageLoser: null,
};

describe("AgentMonitor duel outcome status", () => {
  it("renders a cancellation as a neutral no-contest state", () => {
    render(
      <DuelStatusBar
        duelStatus={{
          ...baseStatus,
          terminalNotice: {
            cycleId: "cycle-1",
            duelId: "duel-1",
            outcome: "cancelled",
            reason: "agent_disconnect",
            occurredAt: Date.now() - 1_000,
            expiresAt: Date.now() + 9_000,
            agent1Id: "agent-a",
            agent1Name: "Riven Ash",
            agent2Id: "agent-b",
            agent2Name: "Astra Vale",
          },
        }}
      />,
    );

    expect(screen.getByText("CANCELLED")).toBeInTheDocument();
    expect(screen.getByText("Riven Ash vs Astra Vale")).toBeInTheDocument();
    expect(
      screen.getByText(/No contest — no winner declared/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/agent_disconnect/i)).not.toBeInTheDocument();
  });

  it("renders a resolution draw without assigning a winner", () => {
    render(
      <DuelStatusBar
        duelStatus={{
          ...baseStatus,
          currentCycle: {
            phase: "RESOLUTION",
            contestants: [
              {
                characterId: "agent-a",
                name: "Riven Ash",
                combatLevel: 42,
                currentHp: 8,
                maxHp: 20,
              },
              {
                characterId: "agent-b",
                name: "Astra Vale",
                combatLevel: 41,
                currentHp: 8,
                maxHp: 20,
              },
            ],
            startedAt: Date.now() - 30_000,
            phaseStartedAt: Date.now() - 1_000,
            winner: null,
            outcome: "draw",
            winReason: "draw",
          },
        }}
      />,
    );

    expect(screen.getByText("Draw — no winner")).toBeInTheDocument();
    expect(screen.queryByText(/wins/i)).not.toBeInTheDocument();
  });

  it("renders operational cancellation history without a win or loss", () => {
    const { unmount } = render(<SidebarRecentDuels duels={[cancelledDuel]} />);

    expect(screen.getByText("No contest:")).toBeInTheDocument();
    expect(screen.getByText(/Riven Ash vs Astra Vale/i)).toBeInTheDocument();
    expect(screen.queryByText(/beat/i)).not.toBeInTheDocument();

    unmount();
    render(
      <DuelsTab
        characterId="agent-a"
        duelStatus={{ ...baseStatus, recentDuels: [cancelledDuel] }}
      />,
    );

    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByText("Combat Engagement Failed")).toBeInTheDocument();
    expect(screen.queryByText("L")).not.toBeInTheDocument();
  });

  it("renders the bounded operational health window", () => {
    render(
      <DuelsTab
        characterId="agent-a"
        duelStatus={{
          ...baseStatus,
          operationalMetrics: {
            emittedAt: Date.now(),
            historyWindow: {
              size: 10,
              maxSize: 200,
              wins: 7,
              draws: 1,
              completed: 8,
              cancelled: 2,
              terminal: 10,
              completionRate: 0.8,
              cancellationReasons: {
                combat_engagement_failed: 2,
              },
            },
            engagement: {
              checks: 5,
              retries: 3,
              recoveries: 2,
              failures: 1,
              proximityCorrections: 2,
              currentRetryCount: 0,
            },
            current: {
              cycleId: null,
              phase: "IDLE",
              firstHitLatencyMs: null,
            },
          },
        }}
      />,
    );

    expect(screen.getByLabelText("Duel operations")).toBeInTheDocument();
    expect(screen.getByText("80.0%")).toBeInTheDocument();
    expect(screen.getByText("Combat Engagement Failed: 2")).toBeInTheDocument();
  });
});
