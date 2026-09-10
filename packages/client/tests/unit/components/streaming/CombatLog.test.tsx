import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CombatLog,
  getStreamingCombatLogName,
} from "../../../../src/components/streaming/CombatLog";
import type {
  AgentInfo,
  StreamingState,
} from "../../../../src/screens/StreamingMode";

function createAgent(id: string, name: string, weaponId: string): AgentInfo {
  return {
    id,
    name,
    provider: "embedded",
    model: "planner-v1",
    hp: 55,
    maxHp: 55,
    combatLevel: 68,
    wins: 3,
    losses: 1,
    damageDealtThisFight: 0,
    highestHit: 0,
    attacksLanded: 0,
    healsUsed: 0,
    equipment:
      weaponId === "shortbow"
        ? { weapon: weaponId, arrows: "iron_arrow" }
        : { weapon: weaponId },
    inventory: [],
    loadoutFingerprint: `${id}-frozen-loadout`,
    availableCombatStyles: ["melee", "ranged", "mage"],
    combatLoadouts: {
      melee: {
        role: "melee",
        weaponId: "bronze_longsword",
        arrowsId: null,
        shieldId: null,
        spellId: null,
      },
      ranged: {
        role: "ranged",
        weaponId: "shortbow",
        arrowsId: "iron_arrow",
        shieldId: null,
        spellId: null,
      },
      mage: {
        role: "mage",
        weaponId: "staff_of_air",
        arrowsId: null,
        shieldId: null,
        spellId: "wind_strike",
      },
    },
    loadoutFrozen: true,
    rank: id === "agent-a" ? 1 : 2,
    headToHeadWins: 2,
    headToHeadLosses: 1,
  };
}

function createState(
  cycleId: string,
  phase: StreamingState["cycle"]["phase"],
  agent1Weapon = "bronze_longsword",
): StreamingState {
  return {
    type: "STREAMING_STATE_UPDATE",
    cycle: {
      cycleId,
      phase,
      cycleStartTime: 1_000,
      phaseStartTime: 2_000,
      phaseEndTime: 62_000,
      timeRemaining: 60_000,
      agent1: createAgent("agent-a", "Riven Ash", agent1Weapon),
      agent2: createAgent("agent-b", "Astra Vale", "bronze_longsword"),
      duelId: `duel-${cycleId}`,
      countdown: phase === "COUNTDOWN" ? 3 : null,
      fightStartTime: phase === "FIGHTING" ? 2_000 : null,
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

afterEach(cleanup);

describe("CombatLog", () => {
  it("removes a repeated matchup prefix from compact broadcast events", () => {
    expect(
      getStreamingCombatLogName(
        "Persisted Chaos Alpha",
        "Persisted Chaos Beta",
      ),
    ).toBe("Alpha");
    expect(
      getStreamingCombatLogName(
        "Persisted Chaos Beta",
        "Persisted Chaos Alpha",
      ),
    ).toBe("Beta");
    expect(getStreamingCombatLogName("Riven Ash", "Astra Vale")).toBe(
      "Riven Ash",
    );
  });

  it("announces a legal frozen-loadout style switch", async () => {
    const { rerender } = render(
      <CombatLog state={createState("cycle-1", "FIGHTING")} />,
    );
    await screen.findByText("Riven Ash vs Astra Vale — FIGHT!");

    rerender(
      <CombatLog state={createState("cycle-1", "FIGHTING", "shortbow")} />,
    );

    const switchEvent = await screen.findByText("Riven Ash switches to Ranged");
    expect(switchEvent).toBeInTheDocument();
    expect(switchEvent.closest("[data-event-kind]")).toHaveAttribute(
      "data-event-kind",
      "style_switch",
    );
  });

  it("clears prior-fight events when a different cycle reaches countdown", async () => {
    const fighting = createState("cycle-1", "FIGHTING");
    const { rerender } = render(<CombatLog state={fighting} />);
    await screen.findByText("Riven Ash vs Astra Vale — FIGHT!");

    const damaged = createState("cycle-1", "FIGHTING");
    damaged.cycle.agent1!.hp = 50;
    rerender(<CombatLog state={damaged} />);
    await screen.findByText("Astra Vale hits Riven Ash — 5 dmg");

    rerender(<CombatLog state={createState("cycle-2", "COUNTDOWN")} />);

    await waitFor(() => {
      expect(
        screen.getByText("Waiting for the opening bell"),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Astra Vale hits Riven Ash — 5 dmg"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Riven Ash vs Astra Vale — FIGHT!"),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps only the seven latest events mounted in the arena view", async () => {
    const { container, rerender } = render(
      <CombatLog state={createState("cycle-density", "FIGHTING")} />,
    );
    await screen.findByText("Riven Ash vs Astra Vale — FIGHT!");

    for (let hp = 54; hp >= 46; hp -= 1) {
      const next = createState("cycle-density", "FIGHTING");
      next.cycle.agent1!.hp = hp;
      rerender(<CombatLog state={next} />);
      await waitFor(() => {
        expect(
          container
            .querySelector("[data-total-events]")
            ?.getAttribute("data-total-events"),
        ).toBe(String(56 - hp));
      });
    }

    const log = container.querySelector("[data-total-events]");
    expect(log).toHaveAttribute("data-total-events", "10");
    expect(log).toHaveAttribute("data-visible-events", "7");
    expect(container.querySelectorAll("[data-event-kind]")).toHaveLength(7);
  });
});
