/**
 * CombatAnimationManager Unit Tests
 *
 * Tests for combat animation and emote management:
 * - Combat emote setting for players and mobs
 * - Tick-aligned emote reset scheduling
 * - Pending reset cancellation
 * - Weapon-based emote selection
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import {
  CombatAnimationManager,
  getCombatEmoteResetDelayTicks,
} from "../CombatAnimationManager";

/**
 * Mock player entity interface
 */
interface MockPlayer {
  id: string;
  emote: string;
  data: { e: string };
  combat: { combatTarget: string | null };
  markNetworkDirty: Mock;
}

/**
 * Mock mob entity interface
 */
interface MockMob {
  id: string;
  setServerEmote: Mock;
}

/**
 * Mock equipment system interface
 */
interface MockEquipmentSystem {
  getPlayerEquipment: Mock<
    [string],
    { weapon?: { item?: { weaponType?: string; id?: string } } }
  >;
}

/**
 * Mock network interface
 */
interface MockNetwork {
  send: Mock;
}

/**
 * Mock world interface
 */
interface MockWorld {
  isServer: boolean;
  entities: Map<string, MockMob>;
  network: MockNetwork;
  getPlayer: (id: string) => MockPlayer | undefined;
  getSystem: (name: string) => MockEquipmentSystem | undefined;
}

// Mock World
function createMockWorld(
  options: {
    players?: Map<string, MockPlayer>;
    entities?: Map<string, MockMob>;
    isServer?: boolean;
    network?: MockNetwork;
    equipmentSystem?: MockEquipmentSystem;
  } = {},
): MockWorld {
  const players = options.players || new Map<string, MockPlayer>();
  const entities = options.entities || new Map<string, MockMob>();

  return {
    isServer: options.isServer ?? true,
    entities,
    network: options.network || {
      send: vi.fn(),
    },
    getPlayer: (id: string) => players.get(id),
    getSystem: (name: string) => {
      if (name === "equipment") {
        return options.equipmentSystem;
      }
      return undefined;
    },
  };
}

// Mock player entity
function createMockPlayer(
  id: string,
  overrides: Partial<MockPlayer> = {},
): MockPlayer {
  return {
    id,
    emote: "idle",
    data: { e: "idle" },
    combat: { combatTarget: null },
    markNetworkDirty: vi.fn(),
    ...overrides,
  };
}

// Mock mob entity
function createMockMob(id: string, overrides: Partial<MockMob> = {}): MockMob {
  return {
    id,
    setServerEmote: vi.fn(),
    ...overrides,
  };
}

describe("CombatAnimationManager", () => {
  let animationManager: CombatAnimationManager;
  let mockWorld: MockWorld;
  let mockPlayers: Map<string, MockPlayer>;
  let mockEntities: Map<string, MockMob>;

  beforeEach(() => {
    mockPlayers = new Map();
    mockEntities = new Map();
    mockWorld = createMockWorld({
      players: mockPlayers,
      entities: mockEntities,
    });
    animationManager = new CombatAnimationManager(mockWorld);
  });

  describe("setCombatEmote", () => {
    it("sets combat emote for player entity", () => {
      const player = createMockPlayer("player1");
      mockPlayers.set("player1", player);

      animationManager.setCombatEmote("player1", "player", 100);

      expect(player.emote).toBe("combat");
      expect(player.data.e).toBe("combat");
      expect(player.markNetworkDirty).toHaveBeenCalled();
    });

    it("sets sword_swing emote when player has sword equipped", () => {
      const player = createMockPlayer("player1");
      mockPlayers.set("player1", player);

      const equipmentSystem = {
        getPlayerEquipment: vi.fn().mockReturnValue({
          weapon: { item: { weaponType: "SWORD", id: "bronze_shortsword" } },
        }),
      };
      mockWorld = createMockWorld({
        players: mockPlayers,
        entities: mockEntities,
        equipmentSystem,
      });
      animationManager = new CombatAnimationManager(mockWorld);

      animationManager.setCombatEmote("player1", "player", 100);

      expect(player.emote).toBe("sword_swing");
      expect(player.data.e).toBe("sword_swing");
    });

    it("sets combat emote for mob entity via setServerEmote", () => {
      const mob = createMockMob("mob1");
      mockEntities.set("mob1", mob);

      animationManager.setCombatEmote("mob1", "mob", 100);

      // Emotes.COMBAT is the asset path with layer parameter
      expect(mob.setServerEmote).toHaveBeenCalledWith(
        "asset://emotes/emote-punching.glb?l=0",
      );
    });

    it("resets a one-second melee clip instead of clamping until cooldown", () => {
      const player = createMockPlayer("player1");
      mockPlayers.set("player1", player);

      animationManager.setCombatEmote("player1", "player", 100);

      const resetTicks = animationManager.getEmoteResetTicks();
      expect(resetTicks.has("player1")).toBe(true);
      expect(resetTicks.get("player1")?.tick).toBe(102);
      expect(resetTicks.get("player1")?.entityType).toBe("player");
    });

    it("does not stretch a melee clip to match a slower weapon cooldown", () => {
      const player = createMockPlayer("player1");
      mockPlayers.set("player1", player);

      animationManager.setCombatEmote("player1", "player", 100, 5);

      const resetTicks = animationManager.getEmoteResetTicks();
      expect(resetTicks.has("player1")).toBe(true);
      expect(resetTicks.get("player1")?.tick).toBe(102);
    });

    it("allows the longer spell clip more time while resetting before cooldown", () => {
      expect(getCombatEmoteResetDelayTicks("spell_cast", 4)).toBe(3);
      expect(getCombatEmoteResetDelayTicks("spell_cast", 2)).toBe(2);
    });

    it("enforces minimum 2 tick reset for very fast attacks", () => {
      const player = createMockPlayer("player1");
      mockPlayers.set("player1", player);

      // With 2-tick attack speed, reset at Math.max(2, 2-1) = 2 ticks after
      animationManager.setCombatEmote("player1", "player", 100, 2);

      const resetTicks = animationManager.getEmoteResetTicks();
      expect(resetTicks.get("player1")?.tick).toBe(102); // Minimum 2 ticks
    });

    it("handles missing player gracefully", () => {
      // Player not in map - should not throw
      expect(() => {
        animationManager.setCombatEmote("nonexistent", "player", 100);
      }).not.toThrow();
    });
  });

  describe("processEmoteResets", () => {
    it("resets emote when tick reaches scheduled reset tick", () => {
      const player = createMockPlayer("player1", { emote: "combat" });
      mockPlayers.set("player1", player);

      // Schedule a reset for tick 102
      animationManager.setEmoteResetData("player1", {
        tick: 102,
        entityType: "player",
      });

      // Process at tick 101 - should not reset
      animationManager.processEmoteResets(101);
      expect(player.emote).toBe("combat");

      // Process at tick 102 - should reset
      animationManager.processEmoteResets(102);
      expect(player.emote).toBe("idle");
      expect(player.data.e).toBe("idle");
    });

    it("removes reset data after processing", () => {
      const player = createMockPlayer("player1");
      mockPlayers.set("player1", player);

      animationManager.setEmoteResetData("player1", {
        tick: 100,
        entityType: "player",
      });

      animationManager.processEmoteResets(100);

      expect(animationManager.getEmoteResetTicks().has("player1")).toBe(false);
    });

    it("processes multiple resets in same tick", () => {
      const player1 = createMockPlayer("player1", { emote: "combat" });
      const player2 = createMockPlayer("player2", { emote: "combat" });
      mockPlayers.set("player1", player1);
      mockPlayers.set("player2", player2);

      animationManager.setEmoteResetData("player1", {
        tick: 100,
        entityType: "player",
      });
      animationManager.setEmoteResetData("player2", {
        tick: 100,
        entityType: "player",
      });

      animationManager.processEmoteResets(100);

      expect(player1.emote).toBe("idle");
      expect(player2.emote).toBe("idle");
    });
  });

  describe("cancelEmoteReset", () => {
    it("removes pending reset for entity", () => {
      animationManager.setEmoteResetData("player1", {
        tick: 100,
        entityType: "player",
      });

      expect(animationManager.getEmoteResetTicks().has("player1")).toBe(true);

      animationManager.cancelEmoteReset("player1");

      expect(animationManager.getEmoteResetTicks().has("player1")).toBe(false);
    });

    it("does nothing for entity with no pending reset", () => {
      expect(() => {
        animationManager.cancelEmoteReset("nonexistent");
      }).not.toThrow();
    });
  });

  describe("resetEmote", () => {
    it("resets player emote to idle", () => {
      const player = createMockPlayer("player1", { emote: "combat" });
      mockPlayers.set("player1", player);

      animationManager.resetEmote("player1", "player");

      expect(player.emote).toBe("idle");
      expect(player.data.e).toBe("idle");
      expect(player.markNetworkDirty).toHaveBeenCalled();
    });

    it("does not reset mob emotes (handled by client AI)", () => {
      const mob = createMockMob("mob1");
      mockEntities.set("mob1", mob);

      // Should not throw or call anything
      animationManager.resetEmote("mob1", "mob");

      // Mob's setServerEmote should NOT be called for reset
      // (mobs return to AI-state-based animation automatically)
    });

    it("handles missing player gracefully", () => {
      expect(() => {
        animationManager.resetEmote("nonexistent", "player");
      }).not.toThrow();
    });
  });

  describe("destroy", () => {
    it("clears all pending resets", () => {
      animationManager.setEmoteResetData("player1", {
        tick: 100,
        entityType: "player",
      });
      animationManager.setEmoteResetData("player2", {
        tick: 101,
        entityType: "player",
      });

      expect(animationManager.getEmoteResetTicks().size).toBe(2);

      animationManager.destroy();

      expect(animationManager.getEmoteResetTicks().size).toBe(0);
    });
  });

  describe("network updates", () => {
    it("sends entityModified event when setting combat emote on server", () => {
      const player = createMockPlayer("player1");
      mockPlayers.set("player1", player);

      animationManager.setCombatEmote("player1", "player", 100);

      expect(mockWorld.network.send).toHaveBeenCalledWith(
        "entityModified",
        expect.objectContaining({
          id: "player1",
          e: "combat",
          c: true,
        }),
      );
    });

    it("sends entityModified event when resetting emote", () => {
      const player = createMockPlayer("player1", { emote: "combat" });
      mockPlayers.set("player1", player);

      animationManager.resetEmote("player1", "player");

      expect(mockWorld.network.send).toHaveBeenCalledWith(
        "entityModified",
        expect.objectContaining({
          id: "player1",
          e: "idle",
        }),
      );
    });
  });
});
