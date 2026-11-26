/**
 * InteractionSessionManager Combat Tests
 *
 * Tests the classic MMORPG-style behavior where being attacked closes bank/store/dialogue.
 * This is server-authoritative - the server sends close packets when combat starts.
 *
 * "If a player is attacked while banking, the bank window will close."
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { InteractionSessionManager } from "../../../../src/systems/ServerNetwork/InteractionSessionManager";
import { EventType } from "@hyperforge/shared";

// Mock World with EventEmitter behavior
function createMockWorld() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    isServer: true,
    entities: new Map(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    emit: vi.fn((event: string, data: unknown) => {
      listeners.get(event)?.forEach((handler) => handler(data));
    }),
    // Expose for testing
    _triggerEvent: (event: string, data: unknown) => {
      listeners.get(event)?.forEach((handler) => handler(data));
    },
  };
}

// Mock BroadcastManager
function createMockBroadcast() {
  return {
    getPlayerSocket: vi.fn().mockReturnValue({
      id: "socket-123",
      player: {
        position: { x: 0, y: 0, z: 0 },
      },
    }),
    sendToPlayer: vi.fn(),
  };
}

// Mock TickSystem
function createMockTickSystem() {
  return {
    onTick: vi.fn().mockReturnValue(() => {}),
  };
}

describe("InteractionSessionManager - Combat Closes Sessions", () => {
  let manager: InteractionSessionManager;
  let mockWorld: ReturnType<typeof createMockWorld>;
  let mockBroadcast: ReturnType<typeof createMockBroadcast>;
  let mockTickSystem: ReturnType<typeof createMockTickSystem>;

  beforeEach(() => {
    mockWorld = createMockWorld();
    mockBroadcast = createMockBroadcast();
    mockTickSystem = createMockTickSystem();

    manager = new InteractionSessionManager(
      mockWorld as unknown as Parameters<
        typeof InteractionSessionManager.prototype.initialize
      >[0] extends infer T
        ? T extends { onTick: unknown }
          ? never
          : Parameters<typeof InteractionSessionManager.prototype.initialize>[0]
        : never,
      mockBroadcast as unknown as Parameters<
        typeof InteractionSessionManager.prototype.initialize
      >[0] extends infer T
        ? T
        : never,
    );

    // @ts-expect-error - accessing private for testing
    manager.world = mockWorld;
    // @ts-expect-error - accessing private for testing
    manager.broadcast = mockBroadcast;

    manager.initialize(
      mockTickSystem as unknown as Parameters<typeof manager.initialize>[0],
    );
  });

  afterEach(() => {
    manager.destroy();
  });

  describe("combat damage closes active sessions", () => {
    it("should close bank session when player is attacked", () => {
      const playerId = "player-1";

      // Open a bank session
      manager.openSession({
        playerId,
        socketId: "socket-123",
        sessionType: "bank",
        targetEntityId: "bank-npc-1",
      });

      expect(manager.hasSession(playerId)).toBe(true);

      // Simulate combat damage event
      mockWorld._triggerEvent(EventType.COMBAT_DAMAGE_DEALT, {
        targetId: playerId,
        targetType: "player",
        attackerId: "mob-1",
        damage: 5,
      });

      // Session should be closed
      expect(manager.hasSession(playerId)).toBe(false);

      // Should have sent close packet
      expect(mockBroadcast.sendToPlayer).toHaveBeenCalledWith(
        playerId,
        "bankClose",
        expect.objectContaining({
          reason: "combat",
          sessionType: "bank",
        }),
      );
    });

    it("should close store session when player is attacked", () => {
      const playerId = "player-2";

      // Open a store session
      manager.openSession({
        playerId,
        socketId: "socket-123",
        sessionType: "store",
        targetEntityId: "shop-npc-1",
        targetStoreId: "general-store",
      });

      expect(manager.hasSession(playerId)).toBe(true);

      // Simulate combat damage event
      mockWorld._triggerEvent(EventType.COMBAT_DAMAGE_DEALT, {
        targetId: playerId,
        targetType: "player",
        attackerId: "mob-1",
        damage: 10,
      });

      // Session should be closed
      expect(manager.hasSession(playerId)).toBe(false);

      // Should have sent close packet
      expect(mockBroadcast.sendToPlayer).toHaveBeenCalledWith(
        playerId,
        "storeClose",
        expect.objectContaining({
          reason: "combat",
          sessionType: "store",
        }),
      );
    });

    it("should close dialogue session when player is attacked", () => {
      const playerId = "player-3";

      // Open a dialogue session
      manager.openSession({
        playerId,
        socketId: "socket-123",
        sessionType: "dialogue",
        targetEntityId: "npc-1",
      });

      expect(manager.hasSession(playerId)).toBe(true);

      // Simulate combat damage event
      mockWorld._triggerEvent(EventType.COMBAT_DAMAGE_DEALT, {
        targetId: playerId,
        targetType: "player",
        attackerId: "mob-1",
        damage: 0, // classic MMORPG: Even splash/miss (0 damage) interrupts
      });

      // Session should be closed
      expect(manager.hasSession(playerId)).toBe(false);

      // Should have sent close packet
      expect(mockBroadcast.sendToPlayer).toHaveBeenCalledWith(
        playerId,
        "dialogueClose",
        expect.objectContaining({
          reason: "combat",
          sessionType: "dialogue",
        }),
      );
    });

    it("should close session even with zero damage (rules-accurate)", () => {
      const playerId = "player-4";

      manager.openSession({
        playerId,
        socketId: "socket-123",
        sessionType: "bank",
        targetEntityId: "bank-npc-1",
      });

      // classic MMORPG: Splash attacks (0 damage) still interrupt banking
      mockWorld._triggerEvent(EventType.COMBAT_DAMAGE_DEALT, {
        targetId: playerId,
        targetType: "player",
        attackerId: "mob-1",
        damage: 0,
      });

      expect(manager.hasSession(playerId)).toBe(false);
    });
  });

  describe("combat damage does not affect other players", () => {
    it("should not close session for different player", () => {
      const player1 = "player-1";
      const player2 = "player-2";

      // Player 1 has bank open
      manager.openSession({
        playerId: player1,
        socketId: "socket-1",
        sessionType: "bank",
        targetEntityId: "bank-npc-1",
      });

      // Player 2 gets attacked
      mockWorld._triggerEvent(EventType.COMBAT_DAMAGE_DEALT, {
        targetId: player2,
        targetType: "player",
        attackerId: "mob-1",
        damage: 5,
      });

      // Player 1's session should still be open
      expect(manager.hasSession(player1)).toBe(true);
    });
  });

  describe("combat damage to mobs is ignored", () => {
    it("should not close session when mob is attacked", () => {
      const playerId = "player-1";

      manager.openSession({
        playerId,
        socketId: "socket-123",
        sessionType: "bank",
        targetEntityId: "bank-npc-1",
      });

      // Mob gets attacked (not player)
      mockWorld._triggerEvent(EventType.COMBAT_DAMAGE_DEALT, {
        targetId: "mob-1",
        targetType: "mob",
        attackerId: playerId,
        damage: 10,
      });

      // Session should still be open
      expect(manager.hasSession(playerId)).toBe(true);
    });
  });

  describe("defensive guards", () => {
    it("should handle malformed events gracefully (missing targetId)", () => {
      const playerId = "player-1";

      manager.openSession({
        playerId,
        socketId: "socket-123",
        sessionType: "bank",
        targetEntityId: "bank-npc-1",
      });

      // Malformed event - missing targetId
      mockWorld._triggerEvent(EventType.COMBAT_DAMAGE_DEALT, {
        targetType: "player",
        damage: 5,
      });

      // Session should still be open (event ignored)
      expect(manager.hasSession(playerId)).toBe(true);
    });

    it("should handle malformed events gracefully (missing targetType)", () => {
      const playerId = "player-1";

      manager.openSession({
        playerId,
        socketId: "socket-123",
        sessionType: "bank",
        targetEntityId: "bank-npc-1",
      });

      // Malformed event - missing targetType
      mockWorld._triggerEvent(EventType.COMBAT_DAMAGE_DEALT, {
        targetId: playerId,
        damage: 5,
      });

      // Session should still be open (event ignored due to missing targetType)
      expect(manager.hasSession(playerId)).toBe(true);
    });
  });

  describe("no session to close", () => {
    it("should handle combat damage when player has no active session", () => {
      const playerId = "player-1";

      // No session opened

      // Should not throw when combat damage occurs
      expect(() => {
        mockWorld._triggerEvent(EventType.COMBAT_DAMAGE_DEALT, {
          targetId: playerId,
          targetType: "player",
          attackerId: "mob-1",
          damage: 5,
        });
      }).not.toThrow();

      // No close packet should be sent
      expect(mockBroadcast.sendToPlayer).not.toHaveBeenCalled();
    });
  });

  describe("store identity provenance", () => {
    it("copies the spawned NPC's exact runtime store identity into the session", () => {
      mockWorld.entities.set("sword-store-npc", {
        data: { storeId: "sword_store" },
      });

      mockWorld._triggerEvent(EventType.STORE_OPEN_REQUEST, {
        playerId: "store-player",
        npcId: "torvin",
        npcEntityId: "sword-store-npc",
      });

      expect(manager.getSession("store-player")).toMatchObject({
        sessionType: "store",
        targetEntityId: "sword-store-npc",
        targetStoreId: "sword_store",
      });
    });
  });
});
