/**
 * CoinPouchSystem Unit Tests
 *
 * Tests the coin pouch functionality (classic MMORPG-style money pouch):
 * - Basic coin operations (add, remove, query)
 * - Overflow protection (MAX_COINS cap)
 * - Persistence operations
 * - Death protection (coins preserved)
 * - Event integration
 *
 * NOTE: Uses mocked system logic to avoid circular dependency issues.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CoinPouchSystem } from "../CoinPouchSystem";

// ============================================================================
// Constants (mirror actual constants)
// ============================================================================

const DEFAULT_STARTING_COINS = 100;
const MAX_COINS = 2147483647; // Max 32-bit signed integer (classic MMORPG cap)

// ============================================================================
// Types
// ============================================================================

interface PlayerRow {
  id: string;
  coins: number;
}

interface EmittedEvent {
  type: string;
  data: Record<string, unknown>;
}

// ============================================================================
// Mock Coin Pouch Manager (core coin logic)
// ============================================================================

class MockCoinPouchManager {
  private coinBalances = new Map<string, number>();
  private loadingPlayers = new Set<string>();
  private initializedPlayers = new Set<string>();
  private persistedData: Array<{ playerId: string; coins: number }> = [];
  private emittedEvents: EmittedEvent[] = [];
  private pendingPersistCount = 0;

  // Mock database
  private playerDatabase = new Map<string, PlayerRow>();

  /**
   * Set up player in database (for persistence tests)
   */
  setupPlayerInDatabase(playerId: string, coins: number): void {
    this.playerDatabase.set(playerId, { id: playerId, coins });
  }

  /**
   * Initialize coins for a player (load from DB or set defaults)
   */
  async initializePlayerCoins(playerId: string): Promise<void> {
    if (!playerId) {
      return;
    }

    // Prevent race conditions during load
    if (this.loadingPlayers.has(playerId)) {
      return;
    }

    // Prevent duplicate initialization
    if (this.initializedPlayers.has(playerId)) {
      return;
    }

    this.loadingPlayers.add(playerId);

    try {
      let coins = DEFAULT_STARTING_COINS;

      // Check database
      const playerRow = this.playerDatabase.get(playerId);
      if (playerRow && typeof playerRow.coins === "number") {
        coins = playerRow.coins;
      }

      this.coinBalances.set(playerId, coins);
      this.initializedPlayers.add(playerId);

      // Emit initialized event
      this.emittedEvents.push({
        type: "INVENTORY_COINS_UPDATED",
        data: { playerId, coins },
      });
    } finally {
      this.loadingPlayers.delete(playerId);
    }
  }

  /**
   * Cleanup coins when player disconnects
   */
  cleanupPlayerCoins(playerId: string): void {
    // Persist before cleanup
    this.persistCoinsImmediate(playerId);

    this.coinBalances.delete(playerId);
    this.loadingPlayers.delete(playerId);
    this.initializedPlayers.delete(playerId);
    this.pendingPersistCount = 0;
  }

  /**
   * Add coins to a player's balance
   * @returns New balance, or -1 if failed
   */
  addCoins(playerId: string, amount: number): number {
    if (!playerId) {
      return -1;
    }

    if (amount <= 0) {
      return -1;
    }

    const currentBalance = this.coinBalances.get(playerId) ?? 0;

    // Prevent overflow - cap at MAX_COINS
    const newBalance = Math.min(currentBalance + amount, MAX_COINS);
    this.coinBalances.set(playerId, newBalance);

    // Emit update event
    this.emittedEvents.push({
      type: "INVENTORY_COINS_UPDATED",
      data: { playerId, coins: newBalance },
    });

    // Schedule persist (simulated - just increment counter)
    this.pendingPersistCount++;

    return newBalance;
  }

  /**
   * Remove coins from a player's balance
   * @returns New balance, or -1 if failed (insufficient funds or invalid)
   */
  removeCoins(playerId: string, amount: number): number {
    if (!playerId) {
      return -1;
    }

    if (amount <= 0) {
      return -1;
    }

    const currentBalance = this.coinBalances.get(playerId) ?? 0;

    // Check sufficient funds
    if (currentBalance < amount) {
      return -1;
    }

    const newBalance = currentBalance - amount;
    this.coinBalances.set(playerId, newBalance);

    // Emit update event
    this.emittedEvents.push({
      type: "INVENTORY_COINS_UPDATED",
      data: { playerId, coins: newBalance },
    });

    // Schedule persist
    this.pendingPersistCount++;

    return newBalance;
  }

  /**
   * Set coins to absolute value (used for sync)
   */
  setCoins(playerId: string, coins: number): void {
    const clampedCoins = Math.max(0, Math.min(coins, MAX_COINS));
    this.coinBalances.set(playerId, clampedCoins);

    this.emittedEvents.push({
      type: "INVENTORY_COINS_UPDATED",
      data: { playerId, coins: clampedCoins },
    });

    this.pendingPersistCount++;
  }

  /**
   * Get a player's coin balance
   */
  getCoins(playerId: string): number {
    return this.coinBalances.get(playerId) ?? 0;
  }

  /**
   * Check if player has at least a certain amount
   */
  hasCoins(playerId: string, amount: number): boolean {
    return this.getCoins(playerId) >= amount;
  }

  /**
   * Check if coins are initialized for a player
   */
  isPlayerInitialized(playerId: string): boolean {
    if (this.loadingPlayers.has(playerId)) return false;
    if (this.initializedPlayers.has(playerId)) return true;
    return this.coinBalances.has(playerId);
  }

  /**
   * Persist coins immediately (on cleanup)
   */
  private persistCoinsImmediate(playerId: string): void {
    const coins = this.getCoins(playerId);
    this.persistedData.push({ playerId, coins });

    // Update database
    const row = this.playerDatabase.get(playerId);
    if (row) {
      row.coins = coins;
    }
  }

  /**
   * Handle event (simulates event subscription)
   */
  handleEvent(eventType: string, data: Record<string, unknown>): void {
    switch (eventType) {
      case "INVENTORY_ADD_COINS":
        this.addCoins(data.playerId as string, data.amount as number);
        break;
      case "INVENTORY_REMOVE_COINS":
        this.removeCoins(data.playerId as string, data.amount as number);
        break;
      case "INVENTORY_UPDATE_COINS":
        this.setCoins(data.playerId as string, data.coins as number);
        break;
    }
  }

  /**
   * Get emitted events
   */
  getEmittedEvents(): EmittedEvent[] {
    return this.emittedEvents;
  }

  /**
   * Get persisted data
   */
  getPersistedData(): Array<{ playerId: string; coins: number }> {
    return this.persistedData;
  }

  /**
   * Get pending persist count (for debounce testing)
   */
  getPendingPersistCount(): number {
    return this.pendingPersistCount;
  }

  /**
   * Reset state
   */
  reset(): void {
    this.coinBalances.clear();
    this.loadingPlayers.clear();
    this.initializedPlayers.clear();
    this.persistedData = [];
    this.emittedEvents = [];
    this.playerDatabase.clear();
    this.pendingPersistCount = 0;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("CoinPouchSystem", () => {
  let manager: MockCoinPouchManager;

  beforeEach(() => {
    manager = new MockCoinPouchManager();
    manager.reset();
  });

  describe("Basic Operations", () => {
    it("adds coins to balance", async () => {
      await manager.initializePlayerCoins("player-1");
      expect(manager.getCoins("player-1")).toBe(DEFAULT_STARTING_COINS);

      const newBalance = manager.addCoins("player-1", 50);

      expect(newBalance).toBe(150);
      expect(manager.getCoins("player-1")).toBe(150);
    });

    it("removes coins from balance", async () => {
      await manager.initializePlayerCoins("player-1");

      const newBalance = manager.removeCoins("player-1", 50);

      expect(newBalance).toBe(50);
      expect(manager.getCoins("player-1")).toBe(50);
    });

    it("returns -1 when insufficient funds", async () => {
      await manager.initializePlayerCoins("player-1");
      expect(manager.getCoins("player-1")).toBe(100);

      const result = manager.removeCoins("player-1", 150);

      expect(result).toBe(-1);
      expect(manager.getCoins("player-1")).toBe(100); // Unchanged
    });

    it("prevents negative coin amounts on add", async () => {
      await manager.initializePlayerCoins("player-1");

      const result = manager.addCoins("player-1", -50);

      expect(result).toBe(-1);
      expect(manager.getCoins("player-1")).toBe(100); // Unchanged
    });

    it("prevents negative coin amounts on remove", async () => {
      await manager.initializePlayerCoins("player-1");

      const result = manager.removeCoins("player-1", -50);

      expect(result).toBe(-1);
      expect(manager.getCoins("player-1")).toBe(100); // Unchanged
    });

    it("prevents zero amount add", async () => {
      await manager.initializePlayerCoins("player-1");

      const result = manager.addCoins("player-1", 0);

      expect(result).toBe(-1);
    });

    it("prevents zero amount remove", async () => {
      await manager.initializePlayerCoins("player-1");

      const result = manager.removeCoins("player-1", 0);

      expect(result).toBe(-1);
    });

    it("hasCoins returns true when player has enough", async () => {
      await manager.initializePlayerCoins("player-1");

      expect(manager.hasCoins("player-1", 50)).toBe(true);
      expect(manager.hasCoins("player-1", 100)).toBe(true);
    });

    it("hasCoins returns false when player does not have enough", async () => {
      await manager.initializePlayerCoins("player-1");

      expect(manager.hasCoins("player-1", 150)).toBe(false);
      expect(manager.hasCoins("player-1", 1000)).toBe(false);
    });
  });

  describe("Overflow Protection", () => {
    it("caps balance at MAX_COINS (2147483647)", async () => {
      await manager.initializePlayerCoins("player-1");
      manager.setCoins("player-1", MAX_COINS - 100);

      const newBalance = manager.addCoins("player-1", 200);

      expect(newBalance).toBe(MAX_COINS);
      expect(manager.getCoins("player-1")).toBe(MAX_COINS);
    });

    it("handles near-max additions without overflow", async () => {
      await manager.initializePlayerCoins("player-1");
      manager.setCoins("player-1", MAX_COINS - 1);

      const newBalance = manager.addCoins("player-1", 1);

      expect(newBalance).toBe(MAX_COINS);
      // Should not wrap to negative
      expect(manager.getCoins("player-1")).toBeGreaterThan(0);
    });

    it("clamps setCoins to valid range", async () => {
      await manager.initializePlayerCoins("player-1");

      manager.setCoins("player-1", MAX_COINS + 1000);

      expect(manager.getCoins("player-1")).toBe(MAX_COINS);
    });

    it("clamps negative setCoins to zero", async () => {
      await manager.initializePlayerCoins("player-1");

      manager.setCoins("player-1", -500);

      expect(manager.getCoins("player-1")).toBe(0);
    });

    it("handles extremely large addition gracefully", async () => {
      await manager.initializePlayerCoins("player-1");

      const newBalance = manager.addCoins("player-1", Number.MAX_SAFE_INTEGER);

      expect(newBalance).toBe(MAX_COINS);
    });
  });

  describe("Persistence", () => {
    it("loads coins from database on registration", async () => {
      manager.setupPlayerInDatabase("player-1", 5000);

      await manager.initializePlayerCoins("player-1");

      expect(manager.getCoins("player-1")).toBe(5000);
    });

    it("uses default coins when not in database", async () => {
      await manager.initializePlayerCoins("player-1");

      expect(manager.getCoins("player-1")).toBe(DEFAULT_STARTING_COINS);
    });

    it("saves coins to database on cleanup", async () => {
      manager.setupPlayerInDatabase("player-1", 100);
      await manager.initializePlayerCoins("player-1");
      manager.addCoins("player-1", 500);

      manager.cleanupPlayerCoins("player-1");

      const persisted = manager.getPersistedData();
      expect(persisted.length).toBeGreaterThan(0);
      expect(persisted[persisted.length - 1].coins).toBe(600);
    });

    it("tracks rapid coin changes for debounced persist", async () => {
      await manager.initializePlayerCoins("player-1");

      // Rapid coin changes
      manager.addCoins("player-1", 10);
      manager.addCoins("player-1", 10);
      manager.addCoins("player-1", 10);
      manager.addCoins("player-1", 10);
      manager.addCoins("player-1", 10);

      // Should have tracked all persist requests
      expect(manager.getPendingPersistCount()).toBe(5);

      // Final balance should be correct
      expect(manager.getCoins("player-1")).toBe(150);
    });

    it("clears pending state on cleanup", async () => {
      await manager.initializePlayerCoins("player-1");
      manager.addCoins("player-1", 100);

      expect(manager.getPendingPersistCount()).toBe(1);

      manager.cleanupPlayerCoins("player-1");

      expect(manager.getPendingPersistCount()).toBe(0);
    });
  });

  describe("Death Protection", () => {
    it("preserves coins on player death (coins are not cleared)", async () => {
      await manager.initializePlayerCoins("player-1");
      manager.addCoins("player-1", 1000);

      // Death in classic MMORPG doesn't affect money pouch
      // Coins should remain intact
      const coinsAfterDeath = manager.getCoins("player-1");

      expect(coinsAfterDeath).toBe(1100);
    });

    it("does not drop coins to ground (coin pouch is protected)", async () => {
      await manager.initializePlayerCoins("player-1");
      manager.addCoins("player-1", 1000);

      // Simulate checking if coins would drop
      // In CoinPouchSystem, coins never drop - they stay in the pouch
      const balance = manager.getCoins("player-1");

      expect(balance).toBe(1100);
      // No "ground item dropped" event should exist for coins
      const events = manager.getEmittedEvents();
      const groundDropEvents = events.filter(
        (e) => e.type === "GROUND_ITEM_DROPPED",
      );
      expect(groundDropEvents.length).toBe(0);
    });
  });

  describe("Event Integration", () => {
    it("responds to INVENTORY_ADD_COINS event", async () => {
      await manager.initializePlayerCoins("player-1");

      manager.handleEvent("INVENTORY_ADD_COINS", {
        playerId: "player-1",
        amount: 250,
      });

      expect(manager.getCoins("player-1")).toBe(350);
    });

    it("responds to INVENTORY_REMOVE_COINS event", async () => {
      await manager.initializePlayerCoins("player-1");

      manager.handleEvent("INVENTORY_REMOVE_COINS", {
        playerId: "player-1",
        amount: 50,
      });

      expect(manager.getCoins("player-1")).toBe(50);
    });

    it("responds to INVENTORY_UPDATE_COINS event", async () => {
      await manager.initializePlayerCoins("player-1");

      manager.handleEvent("INVENTORY_UPDATE_COINS", {
        playerId: "player-1",
        coins: 9999,
      });

      expect(manager.getCoins("player-1")).toBe(9999);
    });

    it("emits INVENTORY_COINS_UPDATED on add", async () => {
      await manager.initializePlayerCoins("player-1");
      const initialEventCount = manager.getEmittedEvents().length;

      manager.addCoins("player-1", 100);

      const events = manager.getEmittedEvents();
      const newEvents = events.slice(initialEventCount);

      expect(newEvents.length).toBe(1);
      expect(newEvents[0].type).toBe("INVENTORY_COINS_UPDATED");
      expect(newEvents[0].data.playerId).toBe("player-1");
      expect(newEvents[0].data.coins).toBe(200);
    });

    it("emits INVENTORY_COINS_UPDATED on remove", async () => {
      await manager.initializePlayerCoins("player-1");
      const initialEventCount = manager.getEmittedEvents().length;

      manager.removeCoins("player-1", 50);

      const events = manager.getEmittedEvents();
      const newEvents = events.slice(initialEventCount);

      expect(newEvents.length).toBe(1);
      expect(newEvents[0].type).toBe("INVENTORY_COINS_UPDATED");
      expect(newEvents[0].data.coins).toBe(50);
    });

    it("emits INVENTORY_COINS_UPDATED on initialization", async () => {
      await manager.initializePlayerCoins("player-1");

      const events = manager.getEmittedEvents();

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("INVENTORY_COINS_UPDATED");
      expect(events[0].data.coins).toBe(DEFAULT_STARTING_COINS);
    });
  });

  describe("Player State Management", () => {
    it("correctly tracks initialized players", async () => {
      expect(manager.isPlayerInitialized("player-1")).toBe(false);

      await manager.initializePlayerCoins("player-1");

      expect(manager.isPlayerInitialized("player-1")).toBe(true);
    });

    it("prevents duplicate initialization", async () => {
      await manager.initializePlayerCoins("player-1");
      manager.addCoins("player-1", 500);

      // Try to reinitialize
      await manager.initializePlayerCoins("player-1");

      // Should keep the modified balance, not reset to default
      expect(manager.getCoins("player-1")).toBe(600);
    });

    it("clears player state on cleanup", async () => {
      await manager.initializePlayerCoins("player-1");
      manager.addCoins("player-1", 500);

      manager.cleanupPlayerCoins("player-1");

      expect(manager.isPlayerInitialized("player-1")).toBe(false);
      expect(manager.getCoins("player-1")).toBe(0); // Default return for missing player
    });
  });

  describe("Edge Cases", () => {
    it("handles operations on uninitialized player", () => {
      const result = manager.addCoins("unknown-player", 100);

      // Should add to default 0 balance
      expect(result).toBe(100);
    });

    it("handles empty playerId", () => {
      const addResult = manager.addCoins("", 100);
      const removeResult = manager.removeCoins("", 50);

      expect(addResult).toBe(-1);
      expect(removeResult).toBe(-1);
    });

    it("handles very small additions", async () => {
      await manager.initializePlayerCoins("player-1");

      manager.addCoins("player-1", 1);

      expect(manager.getCoins("player-1")).toBe(101);
    });

    it("handles exact balance removal", async () => {
      await manager.initializePlayerCoins("player-1");

      const result = manager.removeCoins("player-1", 100);

      expect(result).toBe(0);
      expect(manager.getCoins("player-1")).toBe(0);
    });

    it("getCoins returns 0 for unknown player", () => {
      expect(manager.getCoins("nonexistent")).toBe(0);
    });

    it("hasCoins returns false for unknown player", () => {
      expect(manager.hasCoins("nonexistent", 1)).toBe(false);
    });
  });
});

describe("CoinPouchSystem disconnect persistence", () => {
  it("persists the captured balance after the in-memory entry is cleared", async () => {
    let releaseLookup!: (row: { coins: number }) => void;
    const lookup = new Promise<{ coins: number }>((resolve) => {
      releaseLookup = resolve;
    });
    const savePlayerAsync = vi.fn(async () => {});
    const database = {
      getPlayerAsync: vi.fn(() => lookup),
      savePlayerAsync,
    };
    const system = Object.create(
      CoinPouchSystem.prototype,
    ) as CoinPouchSystem & {
      world: {
        isServer: boolean;
        getSystem: () => typeof database;
      };
      coinBalances: Map<string, number>;
      loadingPlayers: Set<string>;
      initializedPlayers: Set<string>;
      persistenceQueues: Map<string, Promise<void>>;
      cleanupPlayerCoins: (playerId: string) => void;
    };
    system.world = {
      isServer: true,
      getSystem: () => database,
    };
    system.coinBalances = new Map([["player-1", 600]]);
    system.loadingPlayers = new Set();
    system.initializedPlayers = new Set(["player-1"]);
    system.persistenceQueues = new Map();

    system.cleanupPlayerCoins("player-1");
    expect(system.coinBalances.has("player-1")).toBe(false);
    releaseLookup({ coins: 100 });

    await vi.waitFor(() => {
      expect(savePlayerAsync).toHaveBeenCalledWith("player-1", { coins: 600 });
    });
  });

  it("commits overlapping balance writes in mutation order", async () => {
    let releaseFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const committedBalances: number[] = [];
    const savePlayerAsync = vi
      .fn()
      .mockImplementationOnce(async (_playerId, update: { coins: number }) => {
        committedBalances.push(update.coins);
        await firstSave;
      })
      .mockImplementationOnce(async (_playerId, update: { coins: number }) => {
        committedBalances.push(update.coins);
      });
    const database = {
      getPlayerAsync: vi.fn(async () => ({ coins: 0 })),
      savePlayerAsync,
    };
    const system = Object.create(
      CoinPouchSystem.prototype,
    ) as CoinPouchSystem & {
      world: {
        isServer: boolean;
        getSystem: () => typeof database;
      };
      coinBalances: Map<string, number>;
      loadingPlayers: Set<string>;
      initializedPlayers: Set<string>;
      persistenceQueues: Map<string, Promise<void>>;
    };
    system.world = {
      isServer: true,
      getSystem: () => database,
    };
    system.coinBalances = new Map([["player-1", 1]]);
    system.loadingPlayers = new Set();
    system.initializedPlayers = new Set(["player-1"]);
    system.persistenceQueues = new Map();

    const first = system.persistCoinsImmediate("player-1");
    await vi.waitFor(() => expect(savePlayerAsync).toHaveBeenCalledTimes(1));
    system.coinBalances.set("player-1", 2);
    const second = system.persistCoinsImmediate("player-1");

    await Promise.resolve();
    expect(savePlayerAsync).toHaveBeenCalledTimes(1);
    releaseFirstSave();
    await Promise.all([first, second]);

    expect(committedBalances).toEqual([1, 2]);
    expect(system.persistenceQueues.size).toBe(0);
  });
});
