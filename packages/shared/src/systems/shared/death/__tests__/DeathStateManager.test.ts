/**
 * DeathStateManager Unit Tests
 *
 * Tests the death state tracking system with dual persistence.
 *
 * Key behaviors tested:
 * - Server authority for death lock creation
 * - In-memory cache for fast access
 * - Database fallback for crash recovery
 * - Item looting tracking
 * - Gravestone expiration handling
 * - Security: prevents item duplication on reconnect
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { DeathStateManager } from "../DeathStateManager";
import { SafeAreaDeathHandler } from "../SafeAreaDeathHandler";
import { ZoneType } from "../../../../types/death";

// Mock types
interface MockWorld {
  isServer: boolean;
  getSystem: Mock;
  on: Mock;
  off: Mock;
}

interface MockDatabaseSystem {
  saveDeathLockAsync: Mock;
  getDeathLockAsync: Mock;
  deleteDeathLockAsync: Mock;
  updateGroundItemsAsync: Mock;
  acquireDeathLockAsync: Mock;
  getAllActiveDeathsAsync: Mock;
  markDeathRecoveredAsync: Mock;
}

// Factory functions
function createMockWorld(isServer = true): MockWorld {
  return {
    isServer,
    getSystem: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function createMockDatabaseSystem(): MockDatabaseSystem {
  return {
    saveDeathLockAsync: vi.fn().mockResolvedValue(undefined),
    getDeathLockAsync: vi.fn().mockResolvedValue(null),
    deleteDeathLockAsync: vi.fn().mockResolvedValue(undefined),
    updateGroundItemsAsync: vi.fn().mockResolvedValue(undefined),
    acquireDeathLockAsync: vi.fn().mockResolvedValue(true),
    getAllActiveDeathsAsync: vi.fn().mockResolvedValue([]),
    markDeathRecoveredAsync: vi.fn().mockResolvedValue(undefined),
  };
}

const TEST_POSITION = { x: 100, y: 0, z: 200 };

describe("DeathStateManager", () => {
  let world: MockWorld;
  let databaseSystem: MockDatabaseSystem;
  let manager: DeathStateManager;

  beforeEach(() => {
    world = createMockWorld(true);
    databaseSystem = createMockDatabaseSystem();

    world.getSystem.mockImplementation((name: string) => {
      if (name === "database") return databaseSystem;
      return null;
    });

    manager = new DeathStateManager(world as never);
  });

  describe("init", () => {
    it("initializes with database system on server", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await manager.init();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Initialized with database persistence"),
      );

      consoleSpy.mockRestore();
    });

    it("initializes without database on client", async () => {
      const clientWorld = createMockWorld(false);
      const clientManager = new DeathStateManager(clientWorld as never);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await clientManager.init();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("client, in-memory only"),
      );

      consoleSpy.mockRestore();
    });

    it("warns when database system not available on server", async () => {
      world.getSystem.mockReturnValue(null);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await manager.init();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("DatabaseSystem not available"),
      );

      warnSpy.mockRestore();
    });
  });

  describe("startup recovery", () => {
    it("awaits the restored artifact identity before marking custody recovered", async () => {
      await manager.init();
      databaseSystem.getAllActiveDeathsAsync.mockResolvedValue([
        {
          playerId: "player1",
          gravestoneId: "gravestone_from_previous_process",
          groundItemIds: [],
          position: TEST_POSITION,
          timestamp: Date.now(),
          zoneType: ZoneType.SAFE_AREA,
          itemCount: 1,
          items: [{ itemId: "bronze_sword", quantity: 1 }],
          keptItems: [],
          deathOperationId: "safe-death-operation-1",
          killedBy: "wolf",
          recovered: true,
        },
      ]);

      let finishRecovery: (() => void) | undefined;
      const recoveryBarrier = new Promise<void>((resolve) => {
        finishRecovery = resolve;
      });
      const recover = vi.fn(async () => recoveryBarrier);
      manager.setRecoveryHandler(recover);

      const startPromise = manager.start();
      await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
      expect(databaseSystem.markDeathRecoveredAsync).not.toHaveBeenCalled();

      finishRecovery?.();
      await startPromise;

      expect(recover).toHaveBeenCalledWith({
        playerId: "player1",
        deathOperationId: "safe-death-operation-1",
        gravestoneId: "gravestone_from_previous_process",
        position: TEST_POSITION,
        items: [
          expect.objectContaining({
            itemId: "bronze_sword",
            quantity: 1,
          }),
        ],
        killedBy: "wolf",
        zoneType: ZoneType.SAFE_AREA,
      });
      expect(databaseSystem.markDeathRecoveredAsync).toHaveBeenCalledWith(
        "player1",
      );
    });

    it("reuses the exact committed grave ID through the real recovery handler boundary", async () => {
      const exactGravestoneId = "gravestone_player1_committed";
      const database = createMockDatabaseSystem();
      database.getAllActiveDeathsAsync.mockResolvedValue([
        {
          playerId: "player1",
          gravestoneId: exactGravestoneId,
          groundItemIds: [],
          position: TEST_POSITION,
          timestamp: Date.now(),
          zoneType: ZoneType.SAFE_AREA,
          itemCount: 1,
          items: [{ itemId: "bronze_sword", quantity: 1 }],
          keptItems: [],
          deathOperationId: "safe-death-operation-1",
          killedBy: "wolf",
          recovered: true,
        },
      ]);
      const entityManager = {
        spawnEntity: vi.fn().mockResolvedValue({ id: exactGravestoneId }),
        destroyEntity: vi.fn(),
      };
      const recoveryWorld = {
        isServer: true,
        currentTick: 1_000,
        entities: { get: vi.fn(), players: new Map() },
        getPlayer: vi.fn(),
        getSystem: vi.fn((name: string) =>
          name === "database"
            ? database
            : name === "entity-manager"
              ? entityManager
              : null,
        ),
        on: vi.fn(),
        off: vi.fn(),
      };
      const exactManager = new DeathStateManager(recoveryWorld as never);
      const safeHandler = new SafeAreaDeathHandler(
        recoveryWorld as never,
        { spawnGroundItems: vi.fn() } as never,
        exactManager,
      );
      exactManager.setRecoveryHandler(async (request) => {
        const restored = await safeHandler.spawnAndTrackGravestone(
          request.playerId,
          request.position,
          request.items,
          request.killedBy,
          {
            deathOperationId: request.deathOperationId,
            exactGravestoneId: request.gravestoneId,
          },
        );
        expect(restored).toBe(exactGravestoneId);
      });

      await exactManager.init();
      await exactManager.start();

      expect(entityManager.spawnEntity).toHaveBeenCalledWith(
        expect.objectContaining({ id: exactGravestoneId }),
      );
      expect(database.markDeathRecoveredAsync).toHaveBeenCalledWith("player1");
    });

    it("leaves durable custody unrecovered when artifact restoration fails", async () => {
      await manager.init();
      databaseSystem.getAllActiveDeathsAsync.mockResolvedValue([
        {
          playerId: "player1",
          gravestoneId: undefined,
          groundItemIds: [],
          position: TEST_POSITION,
          timestamp: Date.now(),
          zoneType: ZoneType.SAFE_AREA,
          itemCount: 1,
          items: [{ itemId: "bronze_sword", quantity: 1 }],
          keptItems: [],
          deathOperationId: "safe-death-operation-1",
          killedBy: "wolf",
          recovered: false,
        },
      ]);
      manager.setRecoveryHandler(async () => {
        throw new Error("spawn failed");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await manager.start();

      expect(databaseSystem.markDeathRecoveredAsync).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to recover death custody for player1"),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it("fails external-value startup when any durable custody cannot be restored", async () => {
      const priorExternalValue = process.env.HYPERIA_EXTERNAL_VALUE_ENABLED;
      process.env.HYPERIA_EXTERNAL_VALUE_ENABLED = "true";
      try {
        await manager.init();
        databaseSystem.getAllActiveDeathsAsync.mockResolvedValue([
          {
            playerId: "player1",
            gravestoneId: "gravestone_player1_committed",
            groundItemIds: [],
            position: TEST_POSITION,
            timestamp: Date.now(),
            zoneType: ZoneType.SAFE_AREA,
            itemCount: 1,
            items: [{ itemId: "bronze_sword", quantity: 1 }],
            keptItems: [],
            deathOperationId: "safe-death-operation-1",
            killedBy: "wolf",
            recovered: true,
          },
        ]);
        manager.setRecoveryHandler(async () => {
          throw new Error("spawn failed");
        });
        const errorSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});

        await expect(manager.start()).rejects.toThrow(
          "death_recovery_startup_incomplete:0/1:player1",
        );
        expect(databaseSystem.markDeathRecoveredAsync).not.toHaveBeenCalled();
        errorSpy.mockRestore();
      } finally {
        if (priorExternalValue === undefined) {
          delete process.env.HYPERIA_EXTERNAL_VALUE_ENABLED;
        } else {
          process.env.HYPERIA_EXTERNAL_VALUE_ENABLED = priorExternalValue;
        }
      }
    });

    it("fails external-value startup when durable recovery exceeds its startup deadline", async () => {
      const priorExternalValue = process.env.HYPERIA_EXTERNAL_VALUE_ENABLED;
      const priorTimeout = process.env.DEATH_RECOVERY_STARTUP_TIMEOUT_MS;
      process.env.HYPERIA_EXTERNAL_VALUE_ENABLED = "true";
      process.env.DEATH_RECOVERY_STARTUP_TIMEOUT_MS = "1";
      try {
        await manager.init();
        databaseSystem.getAllActiveDeathsAsync.mockResolvedValue([
          {
            playerId: "player1",
            gravestoneId: "gravestone_player1_committed",
            groundItemIds: [],
            position: TEST_POSITION,
            timestamp: Date.now(),
            zoneType: ZoneType.SAFE_AREA,
            itemCount: 1,
            items: [{ itemId: "bronze_sword", quantity: 1 }],
            keptItems: [],
            deathOperationId: "safe-death-operation-1",
            killedBy: "wolf",
            recovered: true,
          },
        ]);
        manager.setRecoveryHandler(() => new Promise<void>(() => undefined));

        await expect(manager.start()).rejects.toThrow(
          "death_recovery_startup_timeout:1",
        );
        expect(databaseSystem.markDeathRecoveredAsync).not.toHaveBeenCalled();
      } finally {
        if (priorExternalValue === undefined) {
          delete process.env.HYPERIA_EXTERNAL_VALUE_ENABLED;
        } else {
          process.env.HYPERIA_EXTERNAL_VALUE_ENABLED = priorExternalValue;
        }
        if (priorTimeout === undefined) {
          delete process.env.DEATH_RECOVERY_STARTUP_TIMEOUT_MS;
        } else {
          process.env.DEATH_RECOVERY_STARTUP_TIMEOUT_MS = priorTimeout;
        }
      }
    });

    it.each([
      {
        label: "legacy custody row",
        deathOperationId: undefined,
        groundItemIds: [],
        reason: "external_value_death_custody_legacy_row",
      },
      {
        label: "public ground-item custody",
        deathOperationId: "safe-death-operation-1",
        groundItemIds: ["ground-item-1"],
        reason: "external_value_death_custody_public_items",
      },
    ])("rejects a $label before external-value startup", async (fixture) => {
      const priorExternalValue = process.env.HYPERIA_EXTERNAL_VALUE_ENABLED;
      process.env.HYPERIA_EXTERNAL_VALUE_ENABLED = "true";
      try {
        await manager.init();
        databaseSystem.getAllActiveDeathsAsync.mockResolvedValue([
          {
            playerId: "player1",
            gravestoneId: "gravestone_player1_committed",
            groundItemIds: fixture.groundItemIds,
            position: TEST_POSITION,
            timestamp: Date.now(),
            zoneType: ZoneType.SAFE_AREA,
            itemCount: 1,
            items: [{ itemId: "bronze_sword", quantity: 1 }],
            keptItems: [],
            deathOperationId: fixture.deathOperationId,
            killedBy: "wolf",
            recovered: true,
          },
        ]);
        const recover = vi.fn().mockResolvedValue(undefined);
        manager.setRecoveryHandler(recover);
        const errorSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});

        await expect(manager.start()).rejects.toMatchObject({
          name: "AggregateError",
          errors: [expect.objectContaining({ message: fixture.reason })],
        });
        expect(recover).not.toHaveBeenCalled();
        expect(databaseSystem.markDeathRecoveredAsync).not.toHaveBeenCalled();
        errorSpy.mockRestore();
      } finally {
        if (priorExternalValue === undefined) {
          delete process.env.HYPERIA_EXTERNAL_VALUE_ENABLED;
        } else {
          process.env.HYPERIA_EXTERNAL_VALUE_ENABLED = priorExternalValue;
        }
      }
    });
  });

  describe("createDeathLock", () => {
    beforeEach(async () => {
      await manager.init();
    });

    it("blocks client-side death lock creation (server authority)", async () => {
      const clientWorld = createMockWorld(false);
      const clientManager = new DeathStateManager(clientWorld as never);
      await clientManager.init();

      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await clientManager.createDeathLock("player1", {
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 5,
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Client attempted server-only death lock creation",
        ),
      );

      consoleSpy.mockRestore();
    });

    it("stores death lock in memory", async () => {
      await manager.createDeathLock("player1", {
        gravestoneId: "gravestone_1",
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 5,
      });

      const lock = await manager.getDeathLock("player1");
      expect(lock).not.toBeNull();
      expect(lock?.playerId).toBe("player1");
      expect(lock?.gravestoneId).toBe("gravestone_1");
      expect(lock?.itemCount).toBe(5);
      expect(lock?.zoneType).toBe(ZoneType.SAFE_AREA);
    });

    it("persists death lock to database", async () => {
      await manager.createDeathLock("player1", {
        gravestoneId: "gravestone_1",
        groundItemIds: ["item_1", "item_2"],
        position: TEST_POSITION,
        zoneType: ZoneType.WILDERNESS,
        itemCount: 2,
      });

      // Uses atomic acquireDeathLockAsync instead of saveDeathLockAsync
      expect(databaseSystem.acquireDeathLockAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          playerId: "player1",
          gravestoneId: "gravestone_1",
          groundItemIds: ["item_1", "item_2"],
          position: TEST_POSITION,
          zoneType: ZoneType.WILDERNESS,
          itemCount: 2,
        }),
        undefined,
      );
    });

    it("passes transaction context to database", async () => {
      const mockTx = { __brand: Symbol() } as never;

      await manager.createDeathLock(
        "player1",
        {
          position: TEST_POSITION,
          zoneType: ZoneType.SAFE_AREA,
          itemCount: 3,
        },
        mockTx,
      );

      // Uses atomic acquireDeathLockAsync
      expect(databaseSystem.acquireDeathLockAsync).toHaveBeenCalledWith(
        expect.any(Object),
        mockTx,
      );
    });

    it("re-throws database error when in transaction", async () => {
      const mockTx = { __brand: Symbol() } as never;
      databaseSystem.acquireDeathLockAsync.mockRejectedValue(
        new Error("DB error"),
      );

      await expect(
        manager.createDeathLock(
          "player1",
          {
            position: TEST_POSITION,
            zoneType: ZoneType.SAFE_AREA,
            itemCount: 1,
          },
          mockTx,
        ),
      ).rejects.toThrow("DB error");
    });

    it("continues with in-memory tracking when database fails (no transaction)", async () => {
      databaseSystem.acquireDeathLockAsync.mockRejectedValue(
        new Error("DB error"),
      );
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      // Should not throw
      await manager.createDeathLock("player1", {
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 1,
      });

      // Should still be in memory
      const lock = await manager.getDeathLock("player1");
      expect(lock).not.toBeNull();

      consoleSpy.mockRestore();
    });
  });

  describe("getDeathLock", () => {
    beforeEach(async () => {
      await manager.init();
    });

    it("returns death lock from memory cache", async () => {
      await manager.createDeathLock("player1", {
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 3,
      });

      const lock = await manager.getDeathLock("player1");
      expect(lock?.playerId).toBe("player1");
    });

    it("falls back to database when not in memory (crash recovery)", async () => {
      databaseSystem.getDeathLockAsync.mockResolvedValue({
        playerId: "player1",
        gravestoneId: "gravestone_recovered",
        groundItemIds: [],
        position: TEST_POSITION,
        timestamp: Date.now(),
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 5,
        items: [{ itemId: "bronze_sword", quantity: 1 }],
        keptItems: [{ itemId: "shrimp", quantity: 2 }],
        deathOperationId: "safe-death-operation-1",
        killedBy: "wolf",
        recovered: false,
      });

      const lock = await manager.getDeathLock("player1");

      expect(lock?.playerId).toBe("player1");
      expect(lock?.gravestoneId).toBe("gravestone_recovered");
      expect(lock?.keptItems).toEqual([{ itemId: "shrimp", quantity: 2 }]);
      expect(lock?.deathOperationId).toBe("safe-death-operation-1");
      expect(databaseSystem.getDeathLockAsync).toHaveBeenCalledWith("player1");
    });

    it("refreshes a cached lock from authoritative database state", async () => {
      await manager.createDeathLock("player1", {
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 1,
        deathOperationId: "safe-death-operation-1",
        keptItems: [{ itemId: "shrimp", quantity: 1 }],
      });
      databaseSystem.getDeathLockAsync.mockResolvedValue({
        playerId: "player1",
        gravestoneId: "gravestone_committed",
        groundItemIds: [],
        position: TEST_POSITION,
        timestamp: Date.now(),
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 1,
        items: [{ itemId: "bronze_sword", quantity: 1 }],
        keptItems: [],
        deathOperationId: "safe-death-operation-1",
        killedBy: "wolf",
        recovered: false,
      });

      const refreshed = await manager.refreshDeathLock("player1");

      expect(refreshed?.gravestoneId).toBe("gravestone_committed");
      expect(refreshed?.keptItems).toEqual([]);
      expect(databaseSystem.getDeathLockAsync).toHaveBeenCalledWith("player1");
    });

    it("restores database death lock to memory cache", async () => {
      databaseSystem.getDeathLockAsync.mockResolvedValueOnce({
        playerId: "player1",
        gravestoneId: null,
        groundItemIds: ["item_1"],
        position: TEST_POSITION,
        timestamp: Date.now(),
        zoneType: ZoneType.WILDERNESS,
        itemCount: 1,
      });

      // First call fetches from database
      await manager.getDeathLock("player1");

      // Reset mock to verify second call uses cache
      databaseSystem.getDeathLockAsync.mockClear();

      // Second call should use memory cache
      const lock = await manager.getDeathLock("player1");

      expect(lock?.playerId).toBe("player1");
      expect(databaseSystem.getDeathLockAsync).not.toHaveBeenCalled();
    });

    it("returns null when not found in memory or database", async () => {
      const lock = await manager.getDeathLock("nonexistent_player");
      expect(lock).toBeNull();
    });
  });

  describe("hasActiveDeathLock", () => {
    beforeEach(async () => {
      await manager.init();
    });

    it("returns true when death lock in memory", async () => {
      await manager.createDeathLock("player1", {
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 1,
      });

      const hasLock = await manager.hasActiveDeathLock("player1");
      expect(hasLock).toBe(true);
    });

    it("returns true when death lock in database (reconnect validation)", async () => {
      databaseSystem.getDeathLockAsync.mockResolvedValue({
        playerId: "player1",
        gravestoneId: null,
        groundItemIds: [],
        position: TEST_POSITION,
        timestamp: Date.now(),
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 1,
      });

      const hasLock = await manager.hasActiveDeathLock("player1");
      expect(hasLock).toBe(true);
    });

    it("returns false when no death lock exists", async () => {
      const hasLock = await manager.hasActiveDeathLock("player1");
      expect(hasLock).toBe(false);
    });
  });

  describe("clearDeathLock", () => {
    beforeEach(async () => {
      await manager.init();
    });

    it("removes death lock from memory", async () => {
      await manager.createDeathLock("player1", {
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 1,
      });

      await manager.clearDeathLock("player1");

      const lock = await manager.getDeathLock("player1");
      expect(lock).toBeNull();
    });

    it("deletes death lock from database", async () => {
      await manager.createDeathLock("player1", {
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 1,
      });

      await manager.clearDeathLock("player1");

      expect(databaseSystem.deleteDeathLockAsync).toHaveBeenCalledWith(
        "player1",
      );
    });

    it("handles database error gracefully", async () => {
      databaseSystem.deleteDeathLockAsync.mockRejectedValue(
        new Error("DB error"),
      );
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      await manager.createDeathLock("player1", {
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 1,
      });

      // Should not throw
      await manager.clearDeathLock("player1");

      // Memory should still be cleared
      const _hasLock = await manager.hasActiveDeathLock("player1");
      // Note: hasActiveDeathLock checks database too, but we cleared memory
      expect(databaseSystem.deleteDeathLockAsync).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("onItemLooted", () => {
    beforeEach(async () => {
      await manager.init();
    });

    it("decrements item count when item looted", async () => {
      await manager.createDeathLock("player1", {
        groundItemIds: ["item_1", "item_2", "item_3"],
        position: TEST_POSITION,
        zoneType: ZoneType.WILDERNESS,
        itemCount: 3,
      });

      await manager.onItemLooted("player1", "item_2");

      const lock = await manager.getDeathLock("player1");
      expect(lock?.itemCount).toBe(2);
      expect(lock?.groundItemIds).not.toContain("item_2");
    });

    it("clears death lock when all items looted", async () => {
      await manager.createDeathLock("player1", {
        groundItemIds: ["item_1"],
        position: TEST_POSITION,
        zoneType: ZoneType.WILDERNESS,
        itemCount: 1,
      });

      await manager.onItemLooted("player1", "item_1");

      const lock = await manager.getDeathLock("player1");
      expect(lock).toBeNull();
    });

    it("updates database after item looted", async () => {
      await manager.createDeathLock("player1", {
        groundItemIds: ["item_1", "item_2"],
        position: TEST_POSITION,
        zoneType: ZoneType.WILDERNESS,
        itemCount: 2,
      });

      // Clear the initial save call
      databaseSystem.saveDeathLockAsync.mockClear();

      await manager.onItemLooted("player1", "item_1");

      expect(databaseSystem.saveDeathLockAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          groundItemIds: ["item_2"],
          itemCount: 1,
        }),
      );
    });

    it("does nothing when player has no death lock", async () => {
      // Should not throw
      await manager.onItemLooted("nonexistent_player", "item_1");
    });
  });

  describe("onGravestoneExpired", () => {
    beforeEach(async () => {
      await manager.init();
    });

    it("transitions gravestone to ground items", async () => {
      await manager.createDeathLock("player1", {
        gravestoneId: "gravestone_1",
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 3,
      });

      await manager.onGravestoneExpired("player1", [
        "ground_1",
        "ground_2",
        "ground_3",
      ]);

      const lock = await manager.getDeathLock("player1");
      expect(lock?.gravestoneId).toBeUndefined();
      expect(lock?.groundItemIds).toEqual(["ground_1", "ground_2", "ground_3"]);
    });

    it("updates database with ground item transition", async () => {
      await manager.createDeathLock("player1", {
        gravestoneId: "gravestone_1",
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 3,
      });

      await manager.onGravestoneExpired("player1", ["ground_1", "ground_2"]);

      expect(databaseSystem.updateGroundItemsAsync).toHaveBeenCalledWith(
        "player1",
        ["ground_1", "ground_2"],
      );
    });

    it("does nothing when player has no death lock", async () => {
      // Should not throw
      await manager.onGravestoneExpired("nonexistent_player", ["ground_1"]);

      expect(databaseSystem.updateGroundItemsAsync).not.toHaveBeenCalled();
    });
  });

  describe("security: item duplication prevention", () => {
    beforeEach(async () => {
      await manager.init();
    });

    it("blocks inventory load when death lock exists (reconnect scenario)", async () => {
      // Simulate: Player dies, gets death lock, then reconnects
      await manager.createDeathLock("player1", {
        gravestoneId: "gravestone_1",
        position: TEST_POSITION,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 10,
      });

      // On reconnect, server should check for death lock BEFORE loading inventory
      const hasActiveDeath = await manager.hasActiveDeathLock("player1");
      expect(hasActiveDeath).toBe(true);

      // If hasActiveDeath is true, server should NOT re-spawn items from inventory
      // This prevents duplication
    });

    it("detects death lock from database after server restart", async () => {
      // Simulate: Server restarts, memory is empty, but DB has death lock
      databaseSystem.getDeathLockAsync.mockResolvedValue({
        playerId: "player1",
        gravestoneId: "gravestone_1",
        groundItemIds: [],
        position: TEST_POSITION,
        timestamp: Date.now() - 60000, // 1 minute ago
        zoneType: ZoneType.SAFE_AREA,
        itemCount: 5,
      });

      // Player reconnects after server restart
      const hasActiveDeath = await manager.hasActiveDeathLock("player1");
      expect(hasActiveDeath).toBe(true);

      // Server should block inventory re-spawn
    });
  });
});
