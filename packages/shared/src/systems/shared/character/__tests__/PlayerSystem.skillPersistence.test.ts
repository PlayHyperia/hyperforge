import { describe, expect, it, vi } from "vitest";

import type { Skills } from "../../../../types/core/core";
import type { PlayerRow } from "../../../../types/network/database";
import type { DatabaseSystem } from "../../../../types/systems/system-interfaces";
import { EventBus } from "../../infrastructure/EventBus";
import { PlayerSystem } from "../PlayerSystem";

function skills(): Skills {
  const base = (xp = 0) => ({ level: 1, xp });
  return {
    attack: base(),
    strength: base(),
    defense: base(),
    constitution: { level: 10, xp: 1_154 },
    ranged: base(),
    magic: base(),
    prayer: base(),
    woodcutting: base(17.5),
    mining: base(18),
    fishing: base(37.5),
    firemaking: base(157.5),
    cooking: base(30),
    smithing: base(12.5),
    agility: base(),
    crafting: base(13.8),
    fletching: base(16.5),
    runecrafting: base(5),
  };
}

describe("PlayerSystem complete skill persistence", () => {
  it("persists every processing skill without discarding manifest fractions", () => {
    const savePlayer = vi.fn();
    const database = { savePlayer } as unknown as DatabaseSystem;
    const system = new PlayerSystem({
      isServer: true,
      $eventBus: new EventBus(),
      entities: new Map(),
      getSystem: vi.fn(() => undefined),
    } as never);
    const playerSkills = skills();
    const internal = system as unknown as {
      databaseSystem: DatabaseSystem;
      players: Map<string, { skills: Skills; combat: { combatLevel: number } }>;
      saveSkillsToDatabase(playerId: string): void;
    };
    internal.databaseSystem = database;
    internal.players.set("skill-save-agent", {
      skills: playerSkills,
      combat: { combatLevel: 3 },
    });

    internal.saveSkillsToDatabase("skill-save-agent");

    expect(savePlayer).toHaveBeenCalledOnce();
    const update = savePlayer.mock.calls[0][1] as Partial<PlayerRow>;
    expect(update).toEqual(
      expect.objectContaining({
        firemakingLevel: 1,
        cookingLevel: 1,
        smithingLevel: 1,
        craftingLevel: 1,
        fletchingLevel: 1,
        runecraftingLevel: 1,
        firemakingXp: 157.5,
        cookingXp: 30,
        smithingXp: 12.5,
        craftingXp: 13.8,
        fletchingXp: 16.5,
        runecraftingXp: 5,
      }),
    );
  });

  it("does not re-save a skill snapshot that an atomic receipt already committed", () => {
    const system = new PlayerSystem({
      isServer: true,
      $eventBus: new EventBus(),
      entities: new Map(),
      getSystem: vi.fn(() => undefined),
    } as never);
    const internal = system as unknown as {
      players: Map<string, { skills: Skills; combat: { combatLevel: number } }>;
      handleSkillsUpdate(data: {
        playerId: string;
        skills: Skills;
        persistence?: "already_committed";
      }): void;
      scheduleSaveSkills(playerId: string): void;
      emitPlayerUpdate(playerId: string): void;
      syncCombatLevelToEntity(playerId: string, combatLevel: number): void;
    };
    internal.players.set("skill-save-agent", {
      skills: skills(),
      combat: { combatLevel: 3 },
    });
    const schedule = vi
      .spyOn(internal, "scheduleSaveSkills")
      .mockImplementation(() => undefined);
    vi.spyOn(internal, "emitPlayerUpdate").mockImplementation(() => undefined);
    vi.spyOn(internal, "syncCombatLevelToEntity").mockImplementation(
      () => undefined,
    );

    internal.handleSkillsUpdate({
      playerId: "skill-save-agent",
      skills: skills(),
      persistence: "already_committed",
    });
    expect(schedule).not.toHaveBeenCalled();

    internal.handleSkillsUpdate({
      playerId: "skill-save-agent",
      skills: skills(),
    });
    expect(schedule).toHaveBeenCalledOnce();
    system.destroy();
  });
});
