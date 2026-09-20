import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentStatsDisplay,
  getStreamingItemFallbackIcon,
  resolveStreamingItemIconMap,
  resolveStreamingItemIconPath,
} from "../../../../src/components/streaming/AgentStatsDisplay";
import type { AgentInfo } from "../../../../src/screens/StreamingMode";

const armorIds = (body: string | null) => ({
  helmet: null,
  body,
  legs: null,
  boots: null,
  gloves: null,
  cape: null,
  amulet: null,
  ring: null,
});

const agent: AgentInfo = {
  id: "agent-a",
  name: "Riven Ash",
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
  loadoutFingerprint: "0123456789abcdef",
  availableCombatStyles: ["melee", "ranged", "mage"],
  combatLoadouts: {
    melee: {
      role: "melee",
      weaponId: "bronze_longsword",
      arrowsId: null,
      shieldId: "wooden_shield",
      spellId: null,
      armorIds: armorIds("bronze_platebody"),
    },
    ranged: {
      role: "ranged",
      weaponId: "shortbow",
      arrowsId: "iron_arrow",
      shieldId: null,
      spellId: null,
      armorIds: armorIds("leather_body"),
    },
    mage: {
      role: "mage",
      weaponId: "air_staff",
      arrowsId: null,
      shieldId: null,
      spellId: "wind_strike",
      armorIds: armorIds("wizard_robe_top"),
    },
  },
  loadoutFrozen: true,
  strategySummary: {
    schemaVersion: 1,
    approach: "balanced",
    tacticalMacro: "orbit",
    attackStyle: "accurate",
    prayer: "hawk_eye",
    preferredCombatRole: null,
    foodThreshold: 40,
    switchDefensiveAt: 30,
    source: "model",
    policyVersion: "duel-preparation-role-v3",
  },
  prayerPointUnits: 12_345_678,
  prayerPoints: 13,
  prayerMaxPoints: 40,
  rank: 1,
  headToHeadWins: 2,
  headToHeadLosses: 1,
};

afterEach(cleanup);

describe("streaming item icon fallback", () => {
  it("uses semantically correct fallbacks for launch loadout items", () => {
    expect(getStreamingItemFallbackIcon("bronze_longsword", 0)).toBe("🗡️");
    expect(getStreamingItemFallbackIcon("shortbow", 0)).toBe("🏹");
    expect(getStreamingItemFallbackIcon("iron_arrow", 0)).toBe("🏹");
  });

  it("is deterministic for unclassified items", () => {
    expect(getStreamingItemFallbackIcon("mystery_item", 7)).toBe(
      getStreamingItemFallbackIcon("mystery_item", 7),
    );
  });

  it("resolves server-provided asset paths against the runtime CDN", () => {
    for (const iconName of [
      "shortsword-bronze.svg",
      "longsword-bronze.svg",
      "scimitar-bronze.svg",
    ]) {
      const resolvedPath = resolveStreamingItemIconPath(
        `asset://icons/${iconName}`,
      );
      expect(resolvedPath).not.toContain("asset://");
      expect(resolvedPath).toMatch(
        new RegExp(`/game-assets/icons/${iconName.replace(".", "\\.")}$`),
      );
    }
  });

  it("treats an empty authoritative icon map as intentional", () => {
    const legacyManifestMap = {
      chaos_rune: "http://localhost/game-assets/icons/chaos-rune.png",
    };

    expect(resolveStreamingItemIconMap({}, legacyManifestMap)).toEqual({});
    expect(resolveStreamingItemIconMap(undefined, legacyManifestMap)).toBe(
      legacyManifestMap,
    );
  });

  it("binds every responsive safe-crop hook to the rendered fighter card", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStatsDisplay, { agent, side: "left" }),
    );

    for (const className of [
      "streaming-agent-stats",
      "streaming-agent-stats--left",
      "streaming-agent-heading",
      "streaming-agent-rank",
      "streaming-agent-name",
      "streaming-agent-records",
      "streaming-agent-loadout",
    ]) {
      expect(markup).toContain(className);
    }
  });

  it.each(["left", "right"] as const)(
    "limits %s equipment and inventory transitions to their changing border color",
    (side) => {
      const emptyAgent: AgentInfo = {
        ...agent,
        equipment: {},
        inventory: [],
        itemIconPaths: {},
      };
      const filledAgent: AgentInfo = {
        ...emptyAgent,
        equipment: {
          weapon: "bronze_longsword",
          shield: "wooden_shield",
          body: "bronze_platebody",
        },
        inventory: Array.from({ length: 28 }, () => ({
          itemId: "bronze_dagger",
          quantity: 1,
        })),
      };
      const { container, rerender } = render(
        React.createElement(AgentStatsDisplay, { agent: emptyAgent, side }),
      );

      for (const currentAgent of [emptyAgent, filledAgent, emptyAgent]) {
        rerender(
          React.createElement(AgentStatsDisplay, { agent: currentAgent, side }),
        );
        const divs = Array.from(container.querySelectorAll("div"));
        const cells = divs.filter((node) => node.style.aspectRatio === "1 / 1");
        expect(cells).toHaveLength(34);
        // This checks the actual rendered CSS contract, not native transition
        // timing. Visibility must not be animated by these item-color effects.
        for (const cell of cells) {
          expect(cell.style.transition).toBe("border-color 0.2s");
        }
        const equipped = cells.filter((node) => node.style.display === "flex");
        const inventory = cells.filter((node) => node.style.display !== "flex");
        expect(equipped).toHaveLength(6);
        expect(inventory).toHaveLength(28);
        expect(
          equipped.filter(
            (node) => node.style.borderColor === "rgba(100, 200, 255, 0.6)",
          ),
        ).toHaveLength(currentAgent === filledAgent ? 3 : 0);
        expect(
          inventory.filter(
            (node) => node.style.borderColor === "rgba(242, 208, 138, 0.5)",
          ),
        ).toHaveLength(currentAgent === filledAgent ? 28 : 0);
        expect(
          divs
            .filter((node) => !cells.includes(node) && node.style.transition)
            .map((node) => node.style.transition),
        ).toEqual([
          "background 0.15s, box-shadow 0.15s",
          "width 0.15s ease-out, background 0.2s",
        ]);
      }
    },
  );

  it("discloses every exact frozen role loadout while the market is open", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStatsDisplay, {
        agent,
        side: "left",
        showFrozenLoadouts: true,
      }),
    );

    expect(markup).toContain("Frozen loadouts");
    expect(markup).toContain("01234567");
    expect(markup).toContain("Bronze Longsword · Wooden Shield · 1 armor");
    expect(markup).toContain("Shortbow · Iron Arrow · 1 armor");
    expect(markup).toContain("Air Staff · Wind Strike · 1 armor");
    expect(markup).toContain("Ammunition: Iron Arrow");
    expect(markup).toContain("Shield: None");
    expect(markup).toContain("Spell: Wind Strike");
    expect(markup).toContain("Body: Wizard Robe Top");
  });

  it("never presents an unfrozen loadout as bettor-visible", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStatsDisplay, {
        agent: { ...agent, loadoutFrozen: false },
        side: "right",
        showFrozenLoadouts: true,
      }),
    );

    expect(markup).not.toContain("Frozen loadouts");
    expect(markup).not.toContain("data-loadout-fingerprint");
    expect(markup).not.toContain("Committed strategy");
  });

  it("discloses only the strict frozen strategy summary while the market is open", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStatsDisplay, {
        agent,
        side: "left",
        showFrozenLoadouts: true,
      }),
    );

    expect(markup).toContain("Committed strategy");
    expect(markup).toContain("Agent-planned");
    expect(markup).toContain("Balanced");
    expect(markup).toContain("Orbit");
    expect(markup).toContain("Accurate attacks");
    expect(markup).toContain("Adaptive roles");
    expect(markup).toContain("Hawk Eye");
    expect(markup).toContain("Recover 40%");
    expect(markup).toContain("Defend 30%");
    expect(markup).toContain('data-strategy-policy="duel-preparation-role-v3"');
    expect(markup).not.toContain("reasoning");
    expect(markup).not.toContain("agentPolicyFingerprint");
  });

  it("fails closed when an uncontrolled field is added to the strategy summary", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStatsDisplay, {
        agent: {
          ...agent,
          strategySummary: {
            ...agent.strategySummary!,
            reasoning: "private",
          } as never,
        },
        side: "right",
        showFrozenLoadouts: true,
      }),
    );

    expect(markup).not.toContain("Committed strategy");
    expect(markup).not.toContain("private");
  });

  it("shows the active role only when current equipment uniquely matches a frozen loadout", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStatsDisplay, {
        agent: {
          ...agent,
          equipment: { weapon: "shortbow", arrows: "iron_arrow" },
        },
        side: "right",
        showActiveCombatRole: true,
      }),
    );

    expect(markup).toContain('data-active-combat-role="ranged"');
    expect(markup).toContain("Riven Ash active combat style: Ranged");
  });

  it("does not speculate about an active role from an unfrozen loadout", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStatsDisplay, {
        agent: { ...agent, loadoutFrozen: false },
        side: "left",
        showActiveCombatRole: true,
      }),
    );

    expect(markup).not.toContain("data-active-combat-role");
  });

  it("shows the current exact prayer custody as a spectator resource", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentStatsDisplay, { agent, side: "left" }),
    );

    expect(markup).toContain("PRAYER 12.35/40");
    expect(markup).toContain('data-prayer-point-units="12345678"');
    expect(markup).toContain("Exact resource: 12345678 units");
  });

  it("does not present lifecycle HP restoration as an in-fight heal", () => {
    const terminalAgent = { ...agent, hp: 20, maxHp: 55 };
    const { queryByText, rerender } = render(
      React.createElement(AgentStatsDisplay, {
        agent: terminalAgent,
        side: "left",
        combatFeedbackEnabled: true,
      }),
    );

    rerender(
      React.createElement(AgentStatsDisplay, {
        agent: { ...terminalAgent, hp: 55 },
        side: "left",
        combatFeedbackEnabled: false,
      }),
    );

    expect(queryByText("+35")).not.toBeInTheDocument();
  });

  it("retains heal feedback for authoritative HP gains during combat", () => {
    const fightingAgent = { ...agent, hp: 20, maxHp: 55 };
    const { getByText, rerender } = render(
      React.createElement(AgentStatsDisplay, {
        agent: fightingAgent,
        side: "left",
        combatFeedbackEnabled: true,
      }),
    );

    rerender(
      React.createElement(AgentStatsDisplay, {
        agent: { ...fightingAgent, hp: 30, healsUsed: 1 },
        side: "left",
        combatFeedbackEnabled: true,
      }),
    );

    expect(getByText("+10")).toBeInTheDocument();
  });
});
