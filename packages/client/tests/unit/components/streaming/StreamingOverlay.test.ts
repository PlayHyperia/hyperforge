import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  getCancellationPresentation,
  getStreamingPreparationActivityLabel,
  isStreamingArenaHandoffComplete,
  StreamingOverlay,
} from "../../../../src/components/streaming/StreamingOverlay";
import type {
  AgentInfo,
  StreamingState,
} from "../../../../src/screens/StreamingMode";

function createAgent(id: string, name: string, rank: number): AgentInfo {
  return {
    id,
    name,
    provider: "scripted",
    model: "melee",
    hp: 55,
    maxHp: 55,
    combatLevel: 68,
    wins: 3,
    losses: 1,
    damageDealtThisFight: 12,
    highestHit: 6,
    attacksLanded: 4,
    healsUsed: 0,
    equipment: { weapon: "bronze_longsword" },
    inventory: [],
    loadoutFingerprint: `${id}-frozen-snapshot`,
    availableCombatStyles: ["melee"],
    combatLoadouts: {
      melee: {
        role: "melee",
        weaponId: "bronze_longsword",
        arrowsId: null,
        shieldId: "wooden_shield",
        spellId: null,
      },
    },
    loadoutFrozen: true,
    strategySummary: {
      schemaVersion: 1,
      approach: "balanced",
      tacticalMacro: "pressure",
      attackStyle: "aggressive",
      prayer: "superhuman_strength",
      preferredCombatRole: null,
      foodThreshold: 40,
      switchDefensiveAt: 30,
      source: "deterministic",
      policyVersion: "duel-preparation-role-v3",
    },
    rank,
    headToHeadWins: 2,
    headToHeadLosses: 1,
  };
}

function createFightingState(): StreamingState {
  return {
    type: "STREAMING_STATE_UPDATE",
    cycle: {
      cycleId: "cycle-1",
      phase: "FIGHTING",
      cycleStartTime: 1_000,
      phaseStartTime: 2_000,
      phaseEndTime: 62_000,
      timeRemaining: 60_000,
      agent1: createAgent("agent-a", "Riven Ash", 1),
      agent2: createAgent("agent-b", "Astra Vale", 2),
      duelId: "duel-1",
      countdown: null,
      fightStartTime: null,
      arenaPositions: {
        agent1: [350, 0.42, 405.35],
        agent2: [350, 0.42, 406.65],
      },
      winnerId: null,
      winnerName: null,
      outcome: null,
      winReason: null,
      actionObservations: [],
    },
    leaderboard: [],
    cameraTarget: "agent-a",
  };
}

function createResolutionState(): StreamingState {
  const state = createFightingState();
  state.cycle.phase = "RESOLUTION";
  state.cycle.timeRemaining = 4_000;
  state.cycle.winnerId = "agent-a";
  state.cycle.winnerName = "Riven Ash";
  state.cycle.outcome = "win";
  state.cycle.winReason = "kill";
  return state;
}

describe("streaming cancellation presentation", () => {
  it("uses clear no-contest copy without exposing internal reason tokens", () => {
    const presentation = getCancellationPresentation(
      "invalid_resolution_participants",
    );

    expect(presentation).toEqual({
      eyebrow: "Round cancelled",
      title: "No contest",
      sub: "Arena officials stopped the round before an official result. No winner was declared.",
    });
    expect(JSON.stringify(presentation)).not.toContain(
      "invalid_resolution_participants",
    );
  });

  it("explains common cancellation classes in viewer language", () => {
    expect(getCancellationPresentation("no_combat_activity").sub).toContain(
      "without enough verified combat",
    );
    expect(getCancellationPresentation("both_agents_missing").sub).toContain(
      "contestant became unavailable",
    );
    expect(getCancellationPresentation("scheduler_shutdown").sub).toContain(
      "broadcast ended",
    );
  });

  it("binds active-fight HUD elements to responsive safe-crop classes", () => {
    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, { state: createFightingState() }),
    );

    for (const className of [
      "streaming-duel-info",
      "streaming-fight-timer",
      "streaming-fight-timer-outer",
      "streaming-fight-timer-inner",
      "streaming-agent-stats--left",
      "streaming-agent-stats--right",
      "streaming-lower-third",
    ]) {
      expect(markup).toContain(className);
    }
  });

  it("shows a neutral refund-review state after cancellation", () => {
    const state = createFightingState();
    state.cycle.phase = "IDLE";
    state.cycle.agent1 = null;
    state.cycle.agent2 = null;
    state.cycle.duelId = null;
    state.terminalNotice = {
      cycleId: "cycle-1",
      duelId: "duel-1",
      outcome: "cancelled",
      reason: "contestant_unavailable",
      occurredAt: Date.now() - 1_000,
      expiresAt: Date.now() + 9_000,
      agent1Id: "agent-a",
      agent1Name: "Riven Ash",
      agent2Id: "agent-b",
      agent2Name: "Astra Vale",
    };

    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, {
        state,
        bettingConfig: {
          configured: true,
          betUrl: "https://bet.example/duels",
          bettingBridgeEnabled: true,
          ready: true,
          unavailableReason: null,
          checkedAt: Date.now(),
        },
      }),
    );

    expect(markup).toContain("No contest");
    expect(markup).toContain("review this market&#x27;s refund status");
    expect(markup).toContain("Riven Ash vs Astra Vale");
    expect(markup).toContain("duel=duel-1");
    expect(markup).not.toContain("contestant_unavailable");
    expect(markup).not.toContain("refunded");
  });

  it("keeps the result surface focused on the matchup and stat summary", () => {
    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, {
        state: createResolutionState(),
      }),
    );

    expect(markup).toContain("Round complete");
    expect(markup).toContain("Next duel");
    expect(markup).not.toContain("streaming-combat-log");
    expect(markup).not.toContain("streaming-leaderboard-mount");
  });

  it("describes announcement fighters as already staged in the arena", () => {
    const state = createFightingState();
    state.cycle.phase = "ANNOUNCEMENT";
    state.leaderboard = [
      {
        rank: 1,
        characterId: "agent-a",
        name: "Riven Ash",
        provider: "scripted",
        model: "melee",
        wins: 3,
        losses: 1,
        draws: 0,
        combatLevel: 68,
        winRate: 75,
        currentStreak: 2,
      },
    ];

    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, { state }),
    );

    expect(markup).toContain("Fighters staged in the arena — the bell is next");
    expect(markup).toContain("Arena handoff complete");
    expect(markup).toContain("Matchup locked");
    expect(markup).toContain("streaming-between-matchup-compact");
    expect(markup).toContain("Riven Ash vs Astra Vale");
    expect(markup).not.toContain("streaming-leaderboard-mount");
    expect(markup.match(/Frozen loadouts/g)).toHaveLength(2);
    expect(markup.match(/Committed strategy/g)).toHaveLength(2);
    expect(markup.match(/Rules fallback/g)).toHaveLength(2);
    expect(markup).toContain("Bronze Longsword · Wooden Shield");
    expect(markup).not.toContain("heading to the arena");
  });

  it("keeps betting state inside the compact short-landscape action", () => {
    const state = createFightingState();
    state.cycle.phase = "ANNOUNCEMENT";

    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, {
        state,
        bettingConfig: {
          configured: true,
          betUrl: "https://bet.example/duels",
          bettingBridgeEnabled: true,
          ready: true,
          unavailableReason: null,
          checkedAt: Date.now(),
        },
      }),
    );

    expect(markup).toContain("streaming-betting-rail-cta-state");
    expect(markup).toContain("Betting open");
    expect(markup).toContain("Place a bet");
    expect(markup).toContain("duel=duel-1");
  });

  it("fails closed until two authoritative non-overlapping arena marks exist", () => {
    const state = createFightingState();
    state.cycle.phase = "ANNOUNCEMENT";
    state.cycle.arenaPositions = null;

    expect(isStreamingArenaHandoffComplete(state.cycle)).toBe(false);
    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, {
        state,
        bettingConfig: {
          configured: true,
          betUrl: "https://bet.example/duels",
          bettingBridgeEnabled: true,
          ready: true,
          unavailableReason: null,
          checkedAt: Date.now(),
        },
      }),
    );

    expect(markup).toContain("Finalizing arena handoff");
    expect(markup).toContain(
      "Arena handoff in progress — waiting for both fighters to be staged",
    );
    expect(markup).toContain(
      "Betting remains unavailable until both fighters are confirmed in the arena.",
    );
    expect(markup).not.toContain("Place a bet");
    expect(markup).not.toContain("Fighters staged in the arena");
  });

  it("rejects overlapping or non-finite public arena marks", () => {
    const state = createFightingState();
    state.cycle.phase = "ANNOUNCEMENT";
    state.cycle.arenaPositions = {
      agent1: [350, 0.42, 405.35],
      agent2: [350, 0.42, 405.35],
    };
    expect(isStreamingArenaHandoffComplete(state.cycle)).toBe(false);

    state.cycle.arenaPositions.agent2[2] = Number.NaN;
    expect(isStreamingArenaHandoffComplete(state.cycle)).toBe(false);
  });

  it("removes frozen-loadout disclosure as soon as the betting window closes", () => {
    const state = createFightingState();
    state.cycle.phase = "COUNTDOWN";

    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, { state }),
    );

    expect(markup).not.toContain("Frozen loadouts");
    expect(markup).not.toContain("data-loadout-fingerprint");
    expect(markup).not.toContain("Committed strategy");
    expect(markup).not.toContain("data-strategy-policy");
  });

  it("keeps a stable fight-log surface throughout countdown", () => {
    const state = createFightingState();
    state.cycle.phase = "COUNTDOWN";

    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, { state }),
    );

    expect(markup).toContain("streaming-combat-log");
    expect(markup).toContain("Waiting for the opening bell");
  });

  it("replaces idle combat chrome with an honest live-preparation surface", () => {
    const state = createFightingState();
    state.cycle.phase = "IDLE";
    state.preparation = {
      schemaVersion: 2,
      status: "preparing",
      selectedAt: 1_000,
      expiresAt: 61_000,
      agent1: {
        id: "agent-a",
        ready: false,
        activity: "gathering",
        mode: "working",
        activityTrail: ["planning", "gathering"],
      },
      agent2: {
        id: "agent-b",
        ready: false,
        activity: "gathering",
        mode: "working",
        activityTrail: ["planning", "gathering"],
      },
    };

    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, {
        state,
        preparationVisuals: {
          schemaVersion: 1,
          updatedAt: 12_000,
          activeCount: 2,
          readyCount: 2,
          ready: true,
          players: [
            {
              playerId: "agent-a",
              presentationActive: true,
              gatheringToolItemId: "harpoon",
              fishingPhase: "striking",
              desiredItemId: "harpoon",
              attachedItemId: "harpoon",
              heldVisualPresent: true,
              heldVisualVisible: true,
              worldVisualPresent: false,
              worldVisualVisible: false,
              attachedToCurrentAvatar: true,
              gatheringRevision: 1,
              fishingRevision: 7,
              ready: true,
            },
            {
              playerId: "agent-b",
              presentationActive: true,
              gatheringToolItemId: "harpoon",
              fishingPhase: "recovering",
              desiredItemId: "harpoon",
              attachedItemId: "harpoon",
              heldVisualPresent: true,
              heldVisualVisible: true,
              worldVisualPresent: false,
              worldVisualVisible: false,
              attachedToCurrentAvatar: true,
              gatheringRevision: 1,
              fishingRevision: 8,
              ready: true,
            },
          ],
        },
      }),
    );

    expect(markup).toContain("Live preparation");
    expect(markup).toContain("Building the loadout");
    expect(markup).toContain("Preparation is live");
    expect(markup).toContain("1:00 remaining");
    expect(markup.match(/Fishing/g)).toHaveLength(2);
    expect(markup).not.toContain("Starts in");
    expect(markup).not.toContain("streaming-leaderboard-mount");
    expect(markup).not.toContain("streaming-interstitial");
  });

  it("announces the arena handoff instead of claiming ready agents are still building", () => {
    const state = createFightingState();
    state.cycle.phase = "IDLE";
    state.preparation = {
      schemaVersion: 2,
      status: "ready",
      selectedAt: 1_000,
      expiresAt: 61_000,
      agent1: {
        id: "agent-a",
        ready: true,
        activity: "gathering",
        mode: "working",
        activityTrail: ["planning", "gathering"],
      },
      agent2: {
        id: "agent-b",
        ready: true,
        activity: "gathering",
        mode: "working",
        activityTrail: ["planning", "gathering"],
      },
    };

    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, { state }),
    );

    expect(markup).toContain("Ready for the arena");
    expect(markup).toContain("Equipment and strategy locked");
    expect(markup).toContain(
      "Preparation complete — both agents are ready for the arena",
    );
    expect(markup).not.toContain("Building the loadout");
    expect(markup).not.toContain("agents are building");
    expect(markup).not.toContain("remaining");
  });

  it("does not infer selected duel preparation from an incidental idle activity visual", () => {
    const state = createFightingState();
    state.cycle.phase = "IDLE";

    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, {
        state,
        preparationVisuals: {
          schemaVersion: 1,
          updatedAt: 12_000,
          activeCount: 1,
          readyCount: 1,
          ready: true,
          players: [
            {
              playerId: "agent-a",
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
        },
      }),
    );

    expect(markup).not.toContain("Live preparation");
    expect(markup).not.toContain("Building the loadout");
    expect(markup).toContain("Potential matchup");
    expect(markup).toContain("Readiness pending");
    expect(markup).toContain(
      "Agents preparing — betting opens only after both loadouts lock",
    );
    expect(markup).not.toContain("Matchup locked");
    expect(markup).not.toContain("Up next");
  });

  it("derives public preparation labels without leaking internal phase names", () => {
    expect(
      getStreamingPreparationActivityLabel({
        playerId: "agent-a",
        presentationActive: true,
        gatheringToolItemId: "harpoon",
        fishingPhase: null,
        desiredItemId: "harpoon",
        attachedItemId: "harpoon",
        heldVisualPresent: true,
        heldVisualVisible: true,
        worldVisualPresent: false,
        worldVisualVisible: false,
        attachedToCurrentAvatar: true,
        gatheringRevision: 1,
        fishingRevision: 1,
        ready: true,
      }),
    ).toBe("Fishing");
  });

  it("never exposes a betting action while runtime authority is unready", () => {
    const state = createFightingState();
    state.cycle.phase = "ANNOUNCEMENT";
    const markup = renderToStaticMarkup(
      React.createElement(StreamingOverlay, {
        state,
        bettingConfig: {
          configured: true,
          betUrl: null,
          bettingBridgeEnabled: true,
          ready: false,
          unavailableReason: "stream_services_unready",
          checkedAt: Date.now(),
        },
      }),
    );

    expect(markup).toContain("Betting unavailable");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toContain("Place a bet");
    expect(markup).not.toContain("Betting open on this matchup");
    expect(markup).not.toContain("stream_services_unready");
    expect(markup).not.toContain("https://bet.example/duels");
  });
});
