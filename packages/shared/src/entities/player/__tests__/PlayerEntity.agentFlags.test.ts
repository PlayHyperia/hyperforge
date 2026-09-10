import { describe, expect, it } from "vitest";

import { PlayerEntity } from "../PlayerEntity";

const skill = { level: 1, xp: 0 };

function createPlayerData(overrides: Record<string, boolean | number> = {}) {
  return {
    id: "agent-player",
    type: "player",
    name: "Agent Player",
    playerId: "agent-player",
    playerName: "Agent Player",
    level: 1,
    health: 10,
    maxHealth: 10,
    stamina: 100,
    maxStamina: 100,
    combatStyle: "attack",
    equipment: {},
    inventory: [],
    skills: {
      attack: skill,
      strength: skill,
      defense: skill,
      constitution: { level: 10, xp: 0 },
      ranged: skill,
      magic: skill,
      prayer: skill,
      woodcutting: skill,
      mining: skill,
      fishing: skill,
      firemaking: skill,
      cooking: skill,
      smithing: skill,
      agility: skill,
      crafting: skill,
      fletching: skill,
      runecrafting: skill,
    },
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    ...overrides,
  };
}

function createWorld() {
  return {
    stage: { scene: { add() {} } },
    emit() {},
  };
}

describe("PlayerEntity agent identity", () => {
  it("retains AI identity on the instance and serialized entity data", () => {
    const player = new PlayerEntity(
      createWorld() as never,
      createPlayerData({ isAgent: true, isEmbeddedAgent: true }) as never,
    );

    expect(player.isAgent).toBe(true);
    expect(player.isEmbeddedAgent).toBe(true);
    expect(player.data.isAgent).toBe(true);
    expect(player.data.isEmbeddedAgent).toBe(true);
    expect(player.serialize()).toMatchObject({
      isAgent: true,
      isEmbeddedAgent: true,
    });
  });

  it("does not label ordinary human players as agents", () => {
    const player = new PlayerEntity(
      createWorld() as never,
      createPlayerData() as never,
    );

    expect(player.isAgent).toBe(false);
    expect(player.isEmbeddedAgent).toBe(false);
    expect(player.serialize()).not.toHaveProperty("isAgent");
    expect(player.serialize()).not.toHaveProperty("isEmbeddedAgent");
  });

  it("serializes versioned gathering-tool presentation for late viewers", () => {
    const player = new PlayerEntity(
      createWorld() as never,
      createPlayerData({ isAgent: true }) as never,
    );
    player.data.gatheringToolPresentation = {
      revision: 9,
      itemId: "small_fishing_net",
    };

    expect(player.serialize()).toMatchObject({
      gatheringToolPresentation: {
        revision: 9,
        itemId: "small_fishing_net",
      },
    });
  });

  it("serializes privacy-safe processing presentation for late viewers", () => {
    const player = new PlayerEntity(
      createWorld() as never,
      createPlayerData({ isAgent: true }) as never,
    );
    player.data.processingInteractionPresentation = {
      revision: 4,
      skill: "smelting",
      phase: "working",
      phaseStartedAtServerTimeMs: 5000,
      targetPosition: { x: 2, y: 0, z: -3 },
    };

    expect(player.serialize()).toMatchObject({
      processingInteractionPresentation: {
        revision: 4,
        skill: "smelting",
        phase: "working",
        phaseStartedAtServerTimeMs: 5000,
        targetPosition: { x: 2, y: 0, z: -3 },
      },
    });
  });

  it("updates current and maximum health atomically", () => {
    const player = new PlayerEntity(
      createWorld() as never,
      createPlayerData() as never,
    );

    player.setHealthAndMaxHealth(60, 60);

    expect(player.getHealth()).toBe(60);
    expect(player.getMaxHealth()).toBe(60);
    expect(player.data.health).toBe(60);
    expect(player.data.maxHealth).toBe(60);
    expect(player.getComponent("health")?.data).toMatchObject({
      current: 60,
      max: 60,
      isDead: false,
    });
  });

  it("hydrates an exact partially depleted persisted health pool", () => {
    const player = new PlayerEntity(
      createWorld() as never,
      createPlayerData({ health: 3 }) as never,
    );

    expect(player.getHealth()).toBe(3);
    expect(player.getMaxHealth()).toBe(10);
    expect(player.data.health).toBe(3);
    expect(player.data.maxHealth).toBe(10);
    expect(player.getComponent("health")?.data).toMatchObject({
      current: 3,
      max: 10,
      isDead: false,
    });
  });
});
