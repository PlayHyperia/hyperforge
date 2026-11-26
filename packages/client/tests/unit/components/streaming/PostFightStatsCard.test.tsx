import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PostFightStatsCard } from "../../../../src/components/streaming/PostFightStatsCard";
import type { AgentInfo } from "../../../../src/screens/StreamingMode";

function createAgent(id: string, name: string): AgentInfo {
  return {
    id,
    name,
    provider: "embedded",
    model: "planner-v1",
    hp: 0,
    maxHp: 55,
    combatLevel: 68,
    wins: 3,
    losses: 1,
    damageDealtThisFight: id === "agent-a" ? 128 : 96,
    highestHit: id === "agent-a" ? 19 : 14,
    attacksLanded: id === "agent-a" ? 11 : 9,
    healsUsed: id === "agent-a" ? 2 : 3,
    equipment: { weapon: "bronze_longsword" },
    inventory: [],
    loadoutFingerprint: `${id}-frozen-loadout`,
    availableCombatStyles: ["melee", "ranged", "mage"],
    combatLoadouts: {},
    loadoutFrozen: true,
    rank: id === "agent-a" ? 1 : 2,
    headToHeadWins: 2,
    headToHeadLosses: 1,
  };
}

describe("PostFightStatsCard", () => {
  it("preserves both complete contestant identities in side-specific result columns", () => {
    const markup = renderToStaticMarkup(
      <PostFightStatsCard
        agent1={createAgent("agent-a", "Riven Ash the Unbroken")}
        agent2={createAgent("agent-b", "Astra Vale the Relentless")}
        winnerId="agent-a"
        winReason="kill"
      />,
    );

    expect(markup).toContain("Riven Ash the Unbroken");
    expect(markup).toContain("Astra Vale the Relentless");
    expect(markup).toContain("streaming-post-fight-agent-name");
    expect(markup).toContain("streaming-post-fight-agent--left");
    expect(markup).toContain("streaming-post-fight-agent--right");
    expect(markup).toContain("Knockout");
  });
});
