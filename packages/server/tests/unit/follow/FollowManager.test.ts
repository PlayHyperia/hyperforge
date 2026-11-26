/**
 * FollowManager Unit Tests
 *
 * Tests the rules-accurate player following system.
 *
 * Key behaviors tested:
 * - Starting and stopping follows
 * - 1-tick delay before following starts (rules-accurate)
 * - 1-tile trailing behavior using previousTile
 * - Re-pathing when target moves
 * - Cleanup on player disconnect
 * - Mutual following ("dancing" pattern)
 *
 * @see https://classic.wiki/w/Follow
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FollowManager } from "../../../src/systems/ServerNetwork/FollowManager";

// Mock entity with position
interface MockEntity {
  id: string;
  position: { x: number; y: number; z: number };
}

// Mock the World class
function createMockWorld() {
  const entities = new Map<string, MockEntity>();

  return {
    entities: {
      get: (id: string) => entities.get(id),
      set: (id: string, entity: MockEntity) => entities.set(id, entity),
      delete: (id: string) => entities.delete(id),
    },
    _entities: entities, // Exposed for test setup
    addPlayer: (id: string, x: number, y: number, z: number) => {
      entities.set(id, { id, position: { x, y, z } });
    },
    removePlayer: (id: string) => {
      entities.delete(id);
    },
    setPlayerPosition: (id: string, x: number, y: number, z: number) => {
      const entity = entities.get(id);
      if (entity) {
        entity.position = { x, y, z };
      }
    },
  };
}

// Mock TileMovementManager
function createMockTileMovementManager() {
  const movePlayerTowardFn = vi.fn();
  const previousTiles = new Map<string, { x: number; z: number }>();

  return {
    movePlayerToward: movePlayerTowardFn,
    getPreviousTile: (playerId: string) => {
      return previousTiles.get(playerId) ?? { x: 0, z: 0 };
    },
    setPreviousTile: (playerId: string, x: number, z: number) => {
      previousTiles.set(playerId, { x, z });
    },
    _movePlayerToward: movePlayerTowardFn, // Exposed for assertions
    _previousTiles: previousTiles, // Exposed for test setup
  };
}

describe("FollowManager", () => {
  let world: ReturnType<typeof createMockWorld>;
  let tileMovementManager: ReturnType<typeof createMockTileMovementManager>;
  let manager: FollowManager;

  beforeEach(() => {
    world = createMockWorld();
    tileMovementManager = createMockTileMovementManager();
    manager = new FollowManager(
      world as never, // Type assertion for mock
      tileMovementManager as never,
    );
  });

  describe("startFollowing", () => {
    it("should not allow self-follow", () => {
      world.addPlayer("player1", 0, 0, 0);

      manager.startFollowing("player1", "player1");

      expect(manager.isFollowing("player1")).toBe(false);
    });

    it("should cancel existing follow when starting new one", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      world.addPlayer("player3", 10, 0, 10);
      tileMovementManager.setPreviousTile("player2", 4, 4);
      tileMovementManager.setPreviousTile("player3", 9, 9);

      // Start following player2
      manager.startFollowing("player1", "player2");
      expect(manager.getFollowTarget("player1")).toBe("player2");

      // Start following player3 - should cancel player2 follow
      manager.startFollowing("player1", "player3");
      expect(manager.getFollowTarget("player1")).toBe("player3");
    });

    it("should not start follow if target does not exist", () => {
      world.addPlayer("player1", 0, 0, 0);
      // player2 does not exist

      manager.startFollowing("player1", "player2");

      expect(manager.isFollowing("player1")).toBe(false);
    });

    it("should store follow state with current tick number", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      tileMovementManager.setPreviousTile("player2", 4, 4);

      // Start following at tick 10
      manager.processTick(10);
      manager.startFollowing("player1", "player2");

      expect(manager.isFollowing("player1")).toBe(true);
      expect(manager.getFollowTarget("player1")).toBe("player2");
    });

    it("should NOT immediately move follower (deferred to processTick)", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      tileMovementManager.setPreviousTile("player2", 4, 4);

      manager.startFollowing("player1", "player2");

      // movePlayerToward should NOT have been called yet
      expect(tileMovementManager._movePlayerToward).not.toHaveBeenCalled();
    });
  });

  describe("processTick - 1-tick delay", () => {
    it("should NOT move follower on the SAME tick as startFollowing", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      tileMovementManager.setPreviousTile("player2", 4, 4);

      // Tick 10: Start following
      manager.processTick(10);
      manager.startFollowing("player1", "player2");

      // Tick 10: Process (same tick) - should NOT move
      manager.processTick(10);

      expect(tileMovementManager._movePlayerToward).not.toHaveBeenCalled();
    });

    it("should move follower on the NEXT tick after startFollowing", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      tileMovementManager.setPreviousTile("player2", 4, 4);

      // Tick 10: Start following
      manager.processTick(10);
      manager.startFollowing("player1", "player2");

      // Tick 11: Process (next tick) - should move
      manager.processTick(11);

      expect(tileMovementManager._movePlayerToward).toHaveBeenCalledWith(
        "player1",
        expect.objectContaining({
          x: expect.any(Number),
          z: expect.any(Number),
        }),
        true, // running
        0, // meleeRange for non-combat
      );
    });

    it("should enforce 1-tick delay even with multiple followers", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      world.addPlayer("player3", 10, 0, 10);
      tileMovementManager.setPreviousTile("player2", 4, 4);
      tileMovementManager.setPreviousTile("player3", 9, 9);

      // Tick 10: Both start following
      manager.processTick(10);
      manager.startFollowing("player1", "player2");
      manager.startFollowing("player3", "player2");

      // Tick 10: Process same tick - neither should move
      manager.processTick(10);
      expect(tileMovementManager._movePlayerToward).not.toHaveBeenCalled();

      // Tick 11: Both should now move
      manager.processTick(11);
      expect(tileMovementManager._movePlayerToward).toHaveBeenCalledTimes(2);
    });
  });

  describe("processTick - trailing behavior", () => {
    it("should path to target's previousTile (1 tile behind)", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5.5, 0, 5.5); // At tile (5, 5)
      tileMovementManager.setPreviousTile("player2", 4, 5); // Previous tile is (4, 5)

      // Start following at tick 10
      manager.processTick(10);
      manager.startFollowing("player1", "player2");

      // Process at tick 11 - should path to previousTile
      manager.processTick(11);

      expect(tileMovementManager._movePlayerToward).toHaveBeenCalledWith(
        "player1",
        expect.objectContaining({
          x: expect.any(Number),
          y: 0,
          z: expect.any(Number),
        }),
        true,
        0,
      );
    });

    it("should stop when follower is at target's previousTile", () => {
      // Player1 is already at player2's previous tile
      world.addPlayer("player1", 4.5, 0, 5.5); // At tile (4, 5)
      world.addPlayer("player2", 5.5, 0, 5.5); // At tile (5, 5)
      tileMovementManager.setPreviousTile("player2", 4, 5); // Previous tile is (4, 5)

      // Start following at tick 10
      manager.processTick(10);
      manager.startFollowing("player1", "player2");

      // Process at tick 11 - should NOT move (already at previousTile)
      manager.processTick(11);

      expect(tileMovementManager._movePlayerToward).not.toHaveBeenCalled();
    });

    it("should re-path when target moves (previousTile changes)", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5.5, 0, 5.5);
      tileMovementManager.setPreviousTile("player2", 4, 5);

      // Start following at tick 10
      manager.processTick(10);
      manager.startFollowing("player1", "player2");

      // Process at tick 11 - path to (4, 5)
      manager.processTick(11);
      expect(tileMovementManager._movePlayerToward).toHaveBeenCalledTimes(1);

      // Target moves - previousTile changes
      tileMovementManager.setPreviousTile("player2", 5, 5);
      world.setPlayerPosition("player2", 6.5, 0, 5.5);

      // Process at tick 12 - should re-path to new previousTile
      manager.processTick(12);
      expect(tileMovementManager._movePlayerToward).toHaveBeenCalledTimes(2);
    });

    it("should NOT re-path when target is stationary (previousTile unchanged)", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5.5, 0, 5.5);
      tileMovementManager.setPreviousTile("player2", 4, 5);

      // Start following at tick 10
      manager.processTick(10);
      manager.startFollowing("player1", "player2");

      // Process at tick 11 - path to (4, 5)
      manager.processTick(11);
      expect(tileMovementManager._movePlayerToward).toHaveBeenCalledTimes(1);

      // Target does NOT move - previousTile stays the same

      // Process at tick 12 - should NOT re-path
      manager.processTick(12);
      expect(tileMovementManager._movePlayerToward).toHaveBeenCalledTimes(1);
    });
  });

  describe("stopFollowing", () => {
    it("should remove follow state", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      tileMovementManager.setPreviousTile("player2", 4, 4);

      manager.startFollowing("player1", "player2");
      expect(manager.isFollowing("player1")).toBe(true);

      manager.stopFollowing("player1");
      expect(manager.isFollowing("player1")).toBe(false);
      expect(manager.getFollowTarget("player1")).toBe(null);
    });

    it("should do nothing if player is not following anyone", () => {
      // Should not throw
      expect(() => manager.stopFollowing("nonexistent")).not.toThrow();
    });
  });

  describe("onPlayerDisconnect", () => {
    it("should stop player from following anyone", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      tileMovementManager.setPreviousTile("player2", 4, 4);

      manager.startFollowing("player1", "player2");
      expect(manager.isFollowing("player1")).toBe(true);

      manager.onPlayerDisconnect("player1");
      expect(manager.isFollowing("player1")).toBe(false);
    });

    it("should stop anyone following the disconnected player", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      world.addPlayer("player3", 10, 0, 10);
      tileMovementManager.setPreviousTile("player1", 0, 0);

      // player2 and player3 both follow player1
      manager.startFollowing("player2", "player1");
      manager.startFollowing("player3", "player1");
      expect(manager.isFollowing("player2")).toBe(true);
      expect(manager.isFollowing("player3")).toBe(true);

      // player1 disconnects
      manager.onPlayerDisconnect("player1");

      // Both followers should stop
      expect(manager.isFollowing("player2")).toBe(false);
      expect(manager.isFollowing("player3")).toBe(false);
    });

    it("should handle case where disconnected player was following someone", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      tileMovementManager.setPreviousTile("player2", 4, 4);

      // player1 follows player2
      manager.startFollowing("player1", "player2");

      // player1 disconnects (the follower)
      manager.onPlayerDisconnect("player1");
      expect(manager.isFollowing("player1")).toBe(false);

      // player2 should still be in world (not following anyone)
      expect(manager.isFollowing("player2")).toBe(false);
    });
  });

  describe("processTick - target/follower removal", () => {
    it("should stop following if target disconnects mid-follow", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      tileMovementManager.setPreviousTile("player2", 4, 4);

      // Start following at tick 10
      manager.processTick(10);
      manager.startFollowing("player1", "player2");

      // Remove target from world
      world.removePlayer("player2");

      // Process at tick 11 - should detect target gone and stop
      manager.processTick(11);

      expect(manager.isFollowing("player1")).toBe(false);
      expect(tileMovementManager._movePlayerToward).not.toHaveBeenCalled();
    });

    it("should clean up if follower entity no longer exists", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      tileMovementManager.setPreviousTile("player2", 4, 4);

      // Start following at tick 10
      manager.processTick(10);
      manager.startFollowing("player1", "player2");

      // Remove follower from world (unusual case)
      world.removePlayer("player1");

      // Process at tick 11 - should clean up
      manager.processTick(11);

      expect(manager.isFollowing("player1")).toBe(false);
    });
  });

  describe("mutual following (dancing)", () => {
    it("should allow two players to follow each other", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 2.5, 0, 0); // 2 tiles apart
      tileMovementManager.setPreviousTile("player1", -1, 0);
      tileMovementManager.setPreviousTile("player2", 1, 0);

      // Both start following each other at same tick
      manager.processTick(10);
      manager.startFollowing("player1", "player2");
      manager.startFollowing("player2", "player1");

      expect(manager.isFollowing("player1")).toBe(true);
      expect(manager.isFollowing("player2")).toBe(true);
      expect(manager.getFollowTarget("player1")).toBe("player2");
      expect(manager.getFollowTarget("player2")).toBe("player1");

      // Process tick 11 - both should attempt to move
      manager.processTick(11);
      expect(tileMovementManager._movePlayerToward).toHaveBeenCalledTimes(2);
    });
  });

  describe("size and destroy", () => {
    it("should report correct follow count", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      world.addPlayer("player3", 10, 0, 10);
      tileMovementManager.setPreviousTile("player2", 4, 4);
      tileMovementManager.setPreviousTile("player3", 9, 9);

      expect(manager.size).toBe(0);

      manager.startFollowing("player1", "player2");
      expect(manager.size).toBe(1);

      manager.startFollowing("player3", "player2");
      expect(manager.size).toBe(2);

      manager.stopFollowing("player1");
      expect(manager.size).toBe(1);
    });

    it("should clear all follows on destroy", () => {
      world.addPlayer("player1", 0, 0, 0);
      world.addPlayer("player2", 5, 0, 5);
      world.addPlayer("player3", 10, 0, 10);
      tileMovementManager.setPreviousTile("player2", 4, 4);

      manager.startFollowing("player1", "player2");
      manager.startFollowing("player3", "player2");
      expect(manager.size).toBe(2);

      manager.destroy();
      expect(manager.size).toBe(0);
    });
  });
});
