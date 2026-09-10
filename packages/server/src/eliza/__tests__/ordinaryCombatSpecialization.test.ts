import { describe, expect, it } from "vitest";

import { resolveOrdinaryCombatSpecialization } from "../ordinaryCombatSpecialization";

describe("ordinary combat specialization", () => {
  it("honors an explicit validated agent specialization", () => {
    expect(
      resolveOrdinaryCombatSpecialization({
        characterId: "agent-a",
        combatSpecialization: "ranged",
      }),
    ).toBe("ranged");
  });

  it("honors a validated ElizaOS profile setting", () => {
    expect(
      resolveOrdinaryCombatSpecialization({
        characterId: "agent-a",
        characterConfig: {
          name: "Agent A",
          settings: { combatSpecialization: "mage" },
        },
      }),
    ).toBe("mage");
  });

  it("falls back to a repeatable identity distribution", () => {
    const characterIds = [
      "agent-kael-20260824",
      "agent-lyra-20260824",
      "agent-riven-20260824",
      "agent-soren-20260824",
    ];
    expect(
      characterIds.map((characterId) =>
        resolveOrdinaryCombatSpecialization({ characterId }),
      ),
    ).toEqual(["mage", "ranged", "melee", "ranged"]);
    expect(
      characterIds.map((characterId) =>
        resolveOrdinaryCombatSpecialization({ characterId }),
      ),
    ).toEqual(["mage", "ranged", "melee", "ranged"]);
  });

  it("ignores malformed profile settings", () => {
    expect(
      resolveOrdinaryCombatSpecialization({
        characterId: "agent-riven-20260824",
        characterConfig: {
          name: "Riven",
          settings: { combatSpecialization: "unsupported" },
        },
      }),
    ).toBe("melee");
  });
});
