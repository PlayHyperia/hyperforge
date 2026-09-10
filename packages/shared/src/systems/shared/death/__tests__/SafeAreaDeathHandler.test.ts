/**
 * SafeAreaDeathHandler Unit Tests
 *
 * Tests the safe area death handling system (classic fantasy MMORPG-style gravestones).
 *
 * Key behaviors tested:
 * - Server authority: Client cannot spawn gravestones
 * - Gravestone spawning with items
 * - Tick-based gravestone expiration
 * - Transition from gravestone to ground items
 * - Death lock creation for item security
 * - Edge cases: empty items, missing systems
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { SafeAreaDeathHandler } from "../SafeAreaDeathHandler";
import { ZoneType } from "../../../../types/death";
import { COMBAT_CONSTANTS } from "../../../../constants/CombatConstants";

// Mock types
interface MockWorld {
  isServer: boolean;
  currentTick: number;
  getSystem: Mock;
  entities: {
    players: Map<string, { playerName?: string; name?: string }>;
    get: Mock;
  };
}

interface MockGroundItemSystem {
  spawnGroundItems: Mock;
}

interface MockDeathStateManager {
  createDeathLock: Mock;
  getDeathLock: Mock;
  onItemLooted: Mock;
  onGravestoneExpired: Mock;
}

interface MockEntityManager {
  spawnEntity: Mock;
  destroyEntity: Mock;
}

// Factory functions for mocks
function createMockWorld(isServer = true, currentTick = 1000): MockWorld {
  return {
    isServer,
    currentTick,
    getSystem: vi.fn(),
    entities: {
      players: new Map<string, { playerName?: string; name?: string }>(),
      get: vi.fn(),
    },
  };
}

function createMockGroundItemSystem(): MockGroundItemSystem {
  return {
    spawnGroundItems: vi
      .fn()
      .mockResolvedValue(["ground_item_1", "ground_item_2"]),
  };
}

function createMockDeathStateManager(): MockDeathStateManager {
  return {
    createDeathLock: vi.fn().mockResolvedValue(undefined),
    getDeathLock: vi.fn().mockResolvedValue(null),
    onItemLooted: vi.fn().mockResolvedValue(undefined),
    onGravestoneExpired: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockEntityManager(): MockEntityManager {
  return {
    spawnEntity: vi.fn().mockResolvedValue({ id: "gravestone_test" }),
    destroyEntity: vi.fn(),
  };
}

function createTestItems() {
  return [
    {
      id: "item_1",
      itemId: "bronze_shortsword",
      quantity: 1,
      slot: 0,
      metadata: null,
    },
    { id: "item_2", itemId: "coins", quantity: 100, slot: 1, metadata: null },
    { id: "item_3", itemId: "lobster", quantity: 5, slot: 2, metadata: null },
  ];
}

const TEST_POSITION = { x: 100, y: 0, z: 200 };

describe("SafeAreaDeathHandler", () => {
  let world: MockWorld;
  let groundItemSystem: MockGroundItemSystem;
  let deathStateManager: MockDeathStateManager;
  let entityManager: MockEntityManager;
  let handler: SafeAreaDeathHandler;

  beforeEach(() => {
    world = createMockWorld(true, 1000);
    groundItemSystem = createMockGroundItemSystem();
    deathStateManager = createMockDeathStateManager();
    entityManager = createMockEntityManager();

    // Setup getSystem to return entityManager
    world.getSystem.mockImplementation((systemName: string) => {
      if (systemName === "entity-manager") return entityManager;
      return null;
    });

    handler = new SafeAreaDeathHandler(
      world as never,
      groundItemSystem as never,
      deathStateManager as never,
    );
  });

  describe("handleDeath", () => {
    it("blocks client-side death handling (server authority)", async () => {
      const clientWorld = createMockWorld(false);
      clientWorld.getSystem.mockReturnValue(entityManager);

      const clientHandler = new SafeAreaDeathHandler(
        clientWorld as never,
        groundItemSystem as never,
        deathStateManager as never,
      );

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await clientHandler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Client attempted server-only"),
      );
      expect(entityManager.spawnEntity).not.toHaveBeenCalled();
      expect(deathStateManager.createDeathLock).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("skips gravestone spawn when no items to drop", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await handler.handleDeath("player1", TEST_POSITION, [], "goblin");

      expect(entityManager.spawnEntity).not.toHaveBeenCalled();
      expect(deathStateManager.createDeathLock).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No items to drop"),
      );

      consoleSpy.mockRestore();
    });

    it("spawns gravestone entity with correct configuration", async () => {
      const items = createTestItems();

      await handler.handleDeath("player1", TEST_POSITION, items, "goblin");

      expect(entityManager.spawnEntity).toHaveBeenCalledTimes(1);

      const spawnCall = entityManager.spawnEntity.mock.calls[0][0];
      expect(spawnCall.id).toMatch(/^gravestone_player1_\d+$/);
      expect(spawnCall.name).toBe("player1's Gravestone");
      expect(spawnCall.position).toEqual(TEST_POSITION);
      expect(spawnCall.headstoneData.playerId).toBe("player1");
      expect(spawnCall.headstoneData.items).toEqual(items);
      expect(spawnCall.headstoneData.itemCount).toBe(3);
      expect(spawnCall.headstoneData.deathMessage).toBe("Slain by goblin");
    });

    it("creates death lock with correct zone type and item count", async () => {
      const items = createTestItems();

      await handler.handleDeath("player1", TEST_POSITION, items, "goblin");

      expect(deathStateManager.createDeathLock).toHaveBeenCalledWith(
        "player1",
        expect.objectContaining({
          gravestoneId: expect.stringMatching(/^gravestone_player1_\d+$/),
          position: TEST_POSITION,
          zoneType: ZoneType.SAFE_AREA,
          itemCount: 3,
        }),
        undefined, // no transaction
      );
    });

    it("passes transaction context through to death lock creation", async () => {
      const items = createTestItems();
      const mockTx = { __brand: Symbol() } as never;

      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        items,
        "goblin",
        mockTx,
      );

      expect(deathStateManager.createDeathLock).toHaveBeenCalledWith(
        "player1",
        expect.any(Object),
        mockTx,
      );
    });

    it("throws error in transaction when gravestone spawn fails", async () => {
      entityManager.spawnEntity.mockResolvedValue(null);
      const mockTx = { __brand: Symbol() } as never;

      await expect(
        handler.handleDeath(
          "player1",
          TEST_POSITION,
          createTestItems(),
          "goblin",
          mockTx,
        ),
      ).rejects.toThrow("Failed to spawn gravestone");
    });

    it("handles missing EntityManager gracefully", async () => {
      world.getSystem.mockReturnValue(null);

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("EntityManager not available"),
      );
      expect(deathStateManager.createDeathLock).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("tracks gravestone for tick-based expiration", async () => {
      const items = createTestItems();
      world.currentTick = 5000;

      await handler.handleDeath("player1", TEST_POSITION, items, "goblin");

      // Gravestone should expire at currentTick + GRAVESTONE_TICKS
      const _expectedExpirationTick = 5000 + COMBAT_CONSTANTS.GRAVESTONE_TICKS;
      const ticksUntilExpiration = handler.getTicksUntilExpiration(
        entityManager.spawnEntity.mock.calls[0][0].id,
        5000,
      );

      expect(ticksUntilExpiration).toBe(COMBAT_CONSTANTS.GRAVESTONE_TICKS);
    });
  });

  describe("processTick", () => {
    it("does not expire gravestone before expiration tick", async () => {
      world.currentTick = 1000;
      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );

      const _gravestoneId = entityManager.spawnEntity.mock.calls[0][0].id;

      // Process tick before expiration
      handler.processTick(1000 + COMBAT_CONSTANTS.GRAVESTONE_TICKS - 1);

      expect(entityManager.destroyEntity).not.toHaveBeenCalled();
      expect(groundItemSystem.spawnGroundItems).not.toHaveBeenCalled();
    });

    it("expires gravestone and spawns ground items at expiration tick", async () => {
      world.currentTick = 1000;
      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );

      const gravestoneId = entityManager.spawnEntity.mock.calls[0][0].id;
      const expirationTick = 1000 + COMBAT_CONSTANTS.GRAVESTONE_TICKS;

      // Process tick at expiration
      handler.processTick(expirationTick);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(entityManager.destroyEntity).toHaveBeenCalledWith(gravestoneId);
      expect(groundItemSystem.spawnGroundItems).toHaveBeenCalledWith(
        expect.any(Array),
        TEST_POSITION,
        expect.objectContaining({
          droppedBy: "player1",
          lootProtection: 0, // No protection after gravestone expires
          scatter: true,
          scatterRadius: 2.0,
        }),
        // 4th arg (throwOnFailure) is not passed as this is not in a transaction
      );
    });

    it("notifies death state manager when gravestone expires", async () => {
      world.currentTick = 1000;
      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );

      const expirationTick = 1000 + COMBAT_CONSTANTS.GRAVESTONE_TICKS;
      handler.processTick(expirationTick);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(deathStateManager.onGravestoneExpired).toHaveBeenCalledWith(
        "player1",
        ["ground_item_1", "ground_item_2"],
      );
    });

    it("handles multiple gravestones expiring on same tick", async () => {
      world.currentTick = 1000;

      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );
      await handler.handleDeath(
        "player2",
        { x: 200, y: 0, z: 300 },
        createTestItems(),
        "dragon",
      );

      const expirationTick = 1000 + COMBAT_CONSTANTS.GRAVESTONE_TICKS;
      handler.processTick(expirationTick);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(entityManager.destroyEntity).toHaveBeenCalledTimes(2);
      expect(groundItemSystem.spawnGroundItems).toHaveBeenCalledTimes(2);
    });

    it("removes gravestone from tracking after expiration", async () => {
      world.currentTick = 1000;
      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );

      const gravestoneId = entityManager.spawnEntity.mock.calls[0][0].id;
      const expirationTick = 1000 + COMBAT_CONSTANTS.GRAVESTONE_TICKS;

      handler.processTick(expirationTick);

      // Should return -1 after expiration (not found)
      expect(
        handler.getTicksUntilExpiration(gravestoneId, expirationTick + 1),
      ).toBe(-1);
    });

    it("renews a database-native gravestone instead of exposing ephemeral ground loot", async () => {
      world.currentTick = 1000;
      deathStateManager.getDeathLock.mockResolvedValue({
        playerId: "player1",
        deathOperationId: "safe-death-operation-1",
      });
      const gravestoneId = await handler.spawnAndTrackGravestone(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );
      const expirationTick = 1000 + COMBAT_CONSTANTS.GRAVESTONE_TICKS;

      handler.processTick(expirationTick);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(entityManager.destroyEntity).not.toHaveBeenCalled();
      expect(groundItemSystem.spawnGroundItems).not.toHaveBeenCalled();
      expect(
        handler.getTicksUntilExpiration(gravestoneId, expirationTick),
      ).toBeGreaterThan(COMBAT_CONSTANTS.GRAVESTONE_TICKS);
    });

    it("restores the exact durable gravestone identity across process replacement", async () => {
      const exactGravestoneId = "gravestone_player1_committed";
      deathStateManager.getDeathLock.mockResolvedValue({
        playerId: "player1",
        deathOperationId: "safe-death-operation-1",
        gravestoneId: exactGravestoneId,
      });

      const restored = await handler.spawnAndTrackGravestone(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
        {
          deathOperationId: "safe-death-operation-1",
          exactGravestoneId,
        },
      );

      expect(restored).toBe(exactGravestoneId);
      expect(entityManager.spawnEntity).toHaveBeenCalledWith(
        expect.objectContaining({ id: exactGravestoneId }),
      );
      expect(handler.getTicksUntilExpiration(exactGravestoneId, 1000)).toBe(
        Number.MAX_SAFE_INTEGER - 1000,
      );
    });

    it("rejects stale operation, altered identity, and occupied-identity recovery", async () => {
      const exactGravestoneId = "gravestone_player1_committed";
      deathStateManager.getDeathLock.mockResolvedValue({
        playerId: "player1",
        deathOperationId: "safe-death-operation-1",
        gravestoneId: exactGravestoneId,
      });

      await expect(
        handler.spawnAndTrackGravestone(
          "player1",
          TEST_POSITION,
          createTestItems(),
          "goblin",
          {
            deathOperationId: "stale-operation",
            exactGravestoneId,
          },
        ),
      ).rejects.toThrow("death_recovery_operation_mismatch");
      await expect(
        handler.spawnAndTrackGravestone(
          "player1",
          TEST_POSITION,
          createTestItems(),
          "goblin",
          {
            deathOperationId: "safe-death-operation-1",
            exactGravestoneId: "gravestone_other-player_committed",
          },
        ),
      ).rejects.toThrow("death_recovery_gravestone_identity_invalid");

      world.entities.get.mockReturnValue({
        getOwnerId: () => "player1",
        getLootItems: () => [
          {
            id: "wrong",
            itemId: "coins",
            quantity: 1,
            slot: 0,
            metadata: null,
          },
        ],
      });
      await expect(
        handler.spawnAndTrackGravestone(
          "player1",
          TEST_POSITION,
          createTestItems(),
          "goblin",
          {
            deathOperationId: "safe-death-operation-1",
            exactGravestoneId,
          },
        ),
      ).rejects.toThrow("death_recovery_gravestone_collision");
      expect(entityManager.spawnEntity).not.toHaveBeenCalled();
    });
  });

  describe("onItemLooted", () => {
    it("delegates to death state manager", async () => {
      await handler.onItemLooted("player1", "item_123");

      expect(deathStateManager.onItemLooted).toHaveBeenCalledWith(
        "player1",
        "item_123",
      );
    });
  });

  describe("cancelGravestoneTimer", () => {
    it("removes gravestone from tracking", async () => {
      world.currentTick = 1000;
      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );

      const gravestoneId = entityManager.spawnEntity.mock.calls[0][0].id;

      handler.cancelGravestoneTimer(gravestoneId);

      expect(handler.getTicksUntilExpiration(gravestoneId, 1000)).toBe(-1);
    });

    it("handles cancelling non-existent gravestone gracefully", () => {
      // Should not throw
      handler.cancelGravestoneTimer("nonexistent_gravestone");
    });
  });

  describe("getTicksUntilExpiration", () => {
    it("returns correct ticks until expiration", async () => {
      world.currentTick = 1000;
      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );

      const gravestoneId = entityManager.spawnEntity.mock.calls[0][0].id;

      expect(handler.getTicksUntilExpiration(gravestoneId, 1000)).toBe(
        COMBAT_CONSTANTS.GRAVESTONE_TICKS,
      );
      expect(handler.getTicksUntilExpiration(gravestoneId, 1100)).toBe(
        COMBAT_CONSTANTS.GRAVESTONE_TICKS - 100,
      );
    });

    it("returns 0 when at or past expiration", async () => {
      world.currentTick = 1000;
      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );

      const gravestoneId = entityManager.spawnEntity.mock.calls[0][0].id;
      const expirationTick = 1000 + COMBAT_CONSTANTS.GRAVESTONE_TICKS;

      expect(
        handler.getTicksUntilExpiration(gravestoneId, expirationTick),
      ).toBe(0);
      expect(
        handler.getTicksUntilExpiration(gravestoneId, expirationTick + 100),
      ).toBe(0);
    });

    it("returns -1 for unknown gravestone", () => {
      expect(handler.getTicksUntilExpiration("unknown_gravestone", 1000)).toBe(
        -1,
      );
    });
  });

  describe("destroy", () => {
    it("clears all gravestone tracking", async () => {
      world.currentTick = 1000;
      await handler.handleDeath(
        "player1",
        TEST_POSITION,
        createTestItems(),
        "goblin",
      );
      await handler.handleDeath(
        "player2",
        { x: 200, y: 0, z: 300 },
        createTestItems(),
        "dragon",
      );

      const gravestone1 = entityManager.spawnEntity.mock.calls[0][0].id;
      const gravestone2 = entityManager.spawnEntity.mock.calls[1][0].id;

      handler.destroy();

      expect(handler.getTicksUntilExpiration(gravestone1, 1000)).toBe(-1);
      expect(handler.getTicksUntilExpiration(gravestone2, 1000)).toBe(-1);
    });
  });
});
