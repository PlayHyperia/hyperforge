import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StreamingOverlay } from "../src/components/streaming/StreamingOverlay";
import type { AgentInfo, StreamingState } from "../src/screens/StreamingMode";
import type { StreamingPreparationVisualDiagnostics } from "@hyperforge/shared";

function agent(id: string, name: string): AgentInfo {
  return {
    id,
    name,
    provider: "test",
    model: "test",
    hp: 10,
    maxHp: 10,
    combatLevel: 10,
    wins: 0,
    losses: 0,
    damageDealtThisFight: 0,
    highestHit: 0,
    attacksLanded: 0,
    healsUsed: 0,
    equipment: {},
    inventory: [],
    rank: 1,
    headToHeadWins: 0,
    headToHeadLosses: 0,
  };
}

describe("StreamingOverlay preparation recap", () => {
  it("accounts for both selected contestants when only one is active on camera", () => {
    const state: StreamingState = {
      type: "STREAMING_STATE_UPDATE",
      cycle: {
        cycleId: "",
        phase: "IDLE",
        cycleStartTime: 1,
        phaseStartTime: 1,
        phaseEndTime: 1,
        timeRemaining: 0,
        agent1: agent("alpha", "Alpha"),
        agent2: agent("beta", "Beta"),
        duelId: null,
        countdown: null,
        fightStartTime: null,
        arenaPositions: null,
        winnerId: null,
        winnerName: null,
        outcome: null,
        winReason: null,
        actionObservations: [],
      },
      leaderboard: [],
      cameraTarget: "alpha",
      terminalNotice: null,
      preparation: {
        schemaVersion: 2,
        status: "preparing",
        selectedAt: 1,
        expiresAt: 60_001,
        agent1: {
          id: "alpha",
          ready: false,
          activity: "gathering",
          mode: "working",
          activityTrail: ["planning", "gathering"],
        },
        agent2: {
          id: "beta",
          ready: false,
          activity: "training",
          mode: "traveling",
          activityTrail: ["planning", "training"],
        },
      },
    };
    const preparationVisuals: StreamingPreparationVisualDiagnostics = {
      schemaVersion: 1,
      updatedAt: 1,
      activeCount: 1,
      readyCount: 1,
      ready: true,
      players: [
        {
          playerId: "alpha",
          presentationActive: true,
          gatheringToolItemId: "bronze_hatchet",
          fishingPhase: null,
          desiredItemId: "bronze_hatchet",
          attachedItemId: "bronze_hatchet",
          heldVisualPresent: true,
          heldVisualVisible: true,
          worldVisualPresent: false,
          worldVisualVisible: false,
          attachedToCurrentAvatar: true,
          gatheringRevision: 1,
          fishingRevision: null,
          ready: true,
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <StreamingOverlay
        state={state}
        preparationVisuals={preparationVisuals}
      />,
    );

    expect(markup.match(/class="streaming-preparation-agent"/g)).toHaveLength(
      2,
    );
    expect(markup).toContain("Alpha");
    expect(markup).toContain("Gathering");
    expect(markup).toContain("Beta");
    expect(markup).toContain("Traveling to train");
    expect(markup).toContain("preparation path");
    expect(markup).not.toContain("bronze_hatchet");

    const readyMarkup = renderToStaticMarkup(
      <StreamingOverlay
        state={{
          ...state,
          preparation: {
            ...state.preparation!,
            agent1: {
              id: "alpha",
              ready: true,
              activity: "gathering",
              mode: "working",
              activityTrail: ["planning", "gathering"],
            },
          },
        }}
        preparationVisuals={preparationVisuals}
      />,
    );
    expect(readyMarkup).toContain('class="streaming-preparation-status">Ready');
    expect(readyMarkup).toContain("Planning → Gathering");
  });
});
