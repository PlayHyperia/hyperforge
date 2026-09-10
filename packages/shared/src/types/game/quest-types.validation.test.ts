import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateQuestDefinition } from "./quest-types";

function definition(): Record<string, unknown> {
  return {
    id: "receipt_quest",
    name: "Receipt Quest",
    description: "Validate exact completion rewards.",
    difficulty: "novice",
    questPoints: 1,
    replayable: false,
    requirements: { quests: [], skills: {}, items: [] },
    startNpc: "mentor",
    stages: [
      {
        id: "return_to_mentor",
        type: "dialogue",
        description: "Return to the mentor.",
      },
    ],
    onStart: { items: [{ itemId: "bronze_sword", quantity: 1 }] },
    rewards: {
      questPoints: 1,
      items: [{ itemId: "xp_lamp_100", quantity: 1 }],
      xp: { attack: 500, prayer: 100 },
    },
  };
}

describe("quest reward manifest validation", () => {
  it("accepts every current production quest reward shape", () => {
    const manifestPath = path.resolve(
      import.meta.dirname,
      "../../../../server/world/assets/manifests/quests.json",
    );
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    ) as Record<string, unknown>;
    for (const [questId, quest] of Object.entries(manifest)) {
      expect(validateQuestDefinition(questId, quest)).toEqual({
        valid: true,
        errors: [],
      });
    }
  });

  it("requires the two quest-point declarations to agree", () => {
    const quest = definition();
    (quest.rewards as Record<string, unknown>).questPoints = 2;
    expect(validateQuestDefinition("receipt_quest", quest)).toMatchObject({
      valid: false,
      errors: [expect.stringContaining("must match top-level 'questPoints'")],
    });
  });

  it("rejects unknown, zero, fractional, or oversized direct XP", () => {
    for (const xp of [
      { defence: 500 },
      { attack: 0 },
      { attack: 1.5 },
      { attack: 1_000_001 },
    ]) {
      const quest = definition();
      (quest.rewards as Record<string, unknown>).xp = xp;
      expect(validateQuestDefinition("receipt_quest", quest).valid).toBe(false);
    }
  });

  it("rejects duplicate, malformed, or impossible item reward entries", () => {
    for (const items of [
      [
        { itemId: "xp_lamp_100", quantity: 1 },
        { itemId: "xp_lamp_100", quantity: 1 },
      ],
      [{ itemId: "", quantity: 1 }],
      [{ itemId: "xp_lamp_100", quantity: 0 }],
      [{ itemId: "xp_lamp_100", quantity: 1.5 }],
    ]) {
      const quest = definition();
      (quest.rewards as Record<string, unknown>).items = items;
      expect(validateQuestDefinition("receipt_quest", quest).valid).toBe(false);
    }
  });
});
