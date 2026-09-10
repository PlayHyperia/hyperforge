/**
 * CoinPouchSystem - Manages player coin balances (classic MMORPG-style Money Pouch)
 *
 * Server-authoritative system that handles all coin operations:
 * - Adding coins (loot, store sales, trades)
 * - Removing coins (purchases, trades)
 * - Querying coin balances
 * - Persisting to database
 *
 * Coins are stored separately from inventory (like classic MMORPG money pouch):
 * - Protected on death (coins stay with player)
 * - No slot usage
 * - Unlimited stacking
 *
 * @see {@link InventorySystem} for item management
 * @see {@link StoreSystem} for purchases
 * @see {@link BankingSystem} for deposits
 */

import { SystemBase } from "../infrastructure/SystemBase";
import type { World } from "../../../core/World";
import { EventType } from "../../../types/events";
import { Logger } from "../../../utils/Logger";
import {
  createPlayerID,
  isValidPlayerID,
  toPlayerID,
} from "../../../utils/IdentifierUtils";
import type { PlayerID } from "../../../types/core/identifiers";
import type { DatabaseSystem } from "../../../types/systems/system-interfaces";

/** Default starting coins for new players */
const DEFAULT_STARTING_COINS = 100;

/** Maximum coins a player can hold (prevent overflow) */
const MAX_COINS = 2147483647; // Max 32-bit signed integer (classic MMORPG cap)

/**
 * CoinPouchSystem - Manages player coin balances
 *
 * Single Responsibility: Only handles coin state and operations.
 * Does NOT handle items, equipment, or other inventory concerns.
 */
export class CoinPouchSystem extends SystemBase {
  /** Coin balances per player */
  private coinBalances = new Map<PlayerID, number>();

  /** Players currently loading from database (prevents race conditions) */
  private loadingPlayers = new Set<string>();

  /** Players whose coins have been initialized */
  private initializedPlayers = new Set<string>();

  /**
   * Per-player write-through queues. Currency mutations can overlap at async
   * call sites; serializing their database writes prevents an older balance
   * from committing after a newer one.
   */
  private persistenceQueues = new Map<PlayerID, Promise<void>>();

  /** Balance verification interval handle */
  private verificationInterval?: NodeJS.Timeout;

  /** Balance verification interval in ms (5 minutes) */
  private readonly VERIFICATION_INTERVAL = 300000;

  constructor(world: World) {
    super(world, {
      name: "coin-pouch",
      dependencies: {
        required: [],
        optional: ["database"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // Subscribe to player lifecycle events
    this.subscribe(
      EventType.PLAYER_REGISTERED,
      async (data: { playerId: string }) => {
        await this.initializePlayerCoins(data.playerId);
      },
    );

    this.subscribe(EventType.PLAYER_CLEANUP, (data: { playerId: string }) => {
      this.cleanupPlayerCoins(data.playerId);
    });

    // Subscribe to coin operation events
    this.subscribe<{ playerId: string; amount: number }>(
      EventType.INVENTORY_ADD_COINS,
      async (data) => {
        await this.addCoins(data.playerId, data.amount);
      },
    );

    this.subscribe(EventType.INVENTORY_REMOVE_COINS, async (data) => {
      await this.removeCoins(data.playerId, data.amount);
    });

    this.subscribe(
      EventType.INVENTORY_UPDATE_COINS,
      async (data: { playerId: string; coins: number }) => {
        // Update coins sets absolute value (used for sync)
        await this.setCoins(data.playerId, data.coins);
      },
    );

    Logger.system("CoinPouchSystem", "Initialized");
  }

  start(): void {
    // Start periodic balance verification on server only
    // Write-through persistence: no auto-save needed, all mutations persist immediately
    if (this.world.isServer) {
      this.startVerification();
    }
  }

  /**
   * Initialize coins for a player (load from DB or set defaults)
   */
  private async initializePlayerCoins(playerId: string): Promise<void> {
    if (!isValidPlayerID(playerId)) {
      Logger.systemError(
        "CoinPouchSystem",
        `Invalid player ID: "${playerId}"`,
        new Error(`Invalid player ID: "${playerId}"`),
      );
      return;
    }

    // Prevent race conditions during load
    if (this.loadingPlayers.has(playerId)) {
      return;
    }

    this.loadingPlayers.add(playerId);

    try {
      const db = this.getDatabase();
      let coins = DEFAULT_STARTING_COINS;

      if (db) {
        const playerRow = await db.getPlayerAsync(playerId);
        if (playerRow && typeof playerRow.coins === "number") {
          coins = playerRow.coins;
        }
      }

      const playerIdKey = createPlayerID(playerId);
      this.coinBalances.set(playerIdKey, coins);
      this.initializedPlayers.add(playerId);

      // Emit initialized event
      this.emitTypedEvent(EventType.INVENTORY_COINS_UPDATED, {
        playerId,
        coins,
      });

      Logger.system(
        "CoinPouchSystem",
        `Initialized coins for ${playerId}: ${coins}`,
      );
    } finally {
      this.loadingPlayers.delete(playerId);
    }
  }

  /**
   * Cleanup coins when player disconnects
   */
  private cleanupPlayerCoins(playerId: string): void {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return;

    // Capture the authoritative balance before clearing memory. Persistence
    // performs an asynchronous existence check; reading from the map after
    // that await would observe the cleared entry as zero and destroy earned
    // currency during disconnect or graceful shutdown.
    const coins = this.coinBalances.get(playerIdKey);
    if (this.world.isServer && coins !== undefined) {
      void this.enqueueCoinBalancePersistence(playerId, playerIdKey, coins);
    }

    this.coinBalances.delete(playerIdKey);
    this.loadingPlayers.delete(playerId);
    this.initializedPlayers.delete(playerId);
  }

  /**
   * Add coins to a player's balance
   *
   * @param playerId - Player to add coins to
   * @param amount - Amount to add (must be positive)
   * @returns New balance, or -1 if failed
   */
  async addCoins(
    playerId: string,
    amount: number,
    skipPersist: boolean = false,
  ): Promise<number> {
    if (!isValidPlayerID(playerId)) {
      Logger.systemError(
        "CoinPouchSystem",
        `Cannot add coins: invalid player ID "${playerId}"`,
        new Error(`Invalid player ID: ${playerId}`),
      );
      return -1;
    }

    if (amount <= 0) {
      Logger.systemError(
        "CoinPouchSystem",
        `Cannot add coins: amount must be positive (got ${amount})`,
        new Error(`Invalid amount: ${amount}`),
      );
      return -1;
    }

    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return -1;

    const currentBalance = this.coinBalances.get(playerIdKey) ?? 0;

    // Prevent overflow
    const newBalance = Math.min(currentBalance + amount, MAX_COINS);
    this.coinBalances.set(playerIdKey, newBalance);

    // Emit update event
    this.emitTypedEvent(EventType.INVENTORY_COINS_UPDATED, {
      playerId,
      coins: newBalance,
    });

    if (!skipPersist) {
      // Write-through: persist immediately before returning
      await this.persistCoinsImmediate(playerId);
    }

    Logger.system(
      "CoinPouchSystem",
      `Added ${amount} coins to ${playerId}: ${currentBalance} → ${newBalance}`,
    );

    return newBalance;
  }

  /**
   * Remove coins from a player's balance
   *
   * @param playerId - Player to remove coins from
   * @param amount - Amount to remove (must be positive)
   * @returns New balance, or -1 if failed (insufficient funds or invalid)
   */
  async removeCoins(playerId: string, amount: number): Promise<number> {
    if (!isValidPlayerID(playerId)) {
      Logger.systemError(
        "CoinPouchSystem",
        `Cannot remove coins: invalid player ID "${playerId}"`,
        new Error(`Invalid player ID: ${playerId}`),
      );
      return -1;
    }

    if (amount <= 0) {
      Logger.systemError(
        "CoinPouchSystem",
        `Cannot remove coins: amount must be positive (got ${amount})`,
        new Error(`Invalid amount: ${amount}`),
      );
      return -1;
    }

    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return -1;

    const currentBalance = this.coinBalances.get(playerIdKey) ?? 0;

    // Check sufficient funds
    if (currentBalance < amount) {
      Logger.system(
        "CoinPouchSystem",
        `Insufficient funds for ${playerId}: has ${currentBalance}, needs ${amount}`,
      );
      return -1;
    }

    const newBalance = currentBalance - amount;
    this.coinBalances.set(playerIdKey, newBalance);

    // Emit update event
    this.emitTypedEvent(EventType.INVENTORY_COINS_UPDATED, {
      playerId,
      coins: newBalance,
    });

    // Write-through: persist immediately before returning
    await this.persistCoinsImmediate(playerId);

    Logger.system(
      "CoinPouchSystem",
      `Removed ${amount} coins from ${playerId}: ${currentBalance} → ${newBalance}`,
    );

    return newBalance;
  }

  /**
   * Set coins to an absolute value (used for sync/initialization)
   */
  private async setCoins(playerId: string, coins: number): Promise<void> {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return;

    const clampedCoins = Math.max(0, Math.min(coins, MAX_COINS));
    this.coinBalances.set(playerIdKey, clampedCoins);

    this.emitTypedEvent(EventType.INVENTORY_COINS_UPDATED, {
      playerId,
      coins: clampedCoins,
    });

    // Write-through: persist immediately before returning
    await this.persistCoinsImmediate(playerId);
  }

  /**
   * Converge the live money-pouch cache to a balance already committed by an
   * atomic database transaction. This method never persists independently;
   * doing so could split the receipt-fenced item and coin transition.
   */
  applyCommittedBalance(playerId: string, coins: number): boolean {
    const playerIdKey = toPlayerID(playerId);
    if (
      !playerIdKey ||
      !Number.isSafeInteger(coins) ||
      coins < 0 ||
      coins > MAX_COINS
    ) {
      return false;
    }

    this.coinBalances.set(playerIdKey, coins);
    this.initializedPlayers.add(playerId);
    this.emitTypedEvent(EventType.INVENTORY_COINS_UPDATED, {
      playerId,
      coins,
    });
    return true;
  }

  /**
   * Get a player's coin balance
   *
   * @param playerId - Player to check
   * @returns Coin balance, or 0 if not found
   */
  getCoins(playerId: string): number {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return 0;
    return this.coinBalances.get(playerIdKey) ?? 0;
  }

  /**
   * Check if a player has at least a certain amount of coins
   *
   * @param playerId - Player to check
   * @param amount - Amount required
   * @returns true if player has sufficient coins
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
    const playerIdKey = toPlayerID(playerId);
    return playerIdKey ? this.coinBalances.has(playerIdKey) : false;
  }

  // === Database Persistence ===

  private getDatabase(): DatabaseSystem | null {
    return this.world.getSystem<DatabaseSystem>("database") || null;
  }

  async persistCoinsImmediate(playerId: string): Promise<void> {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) return;
    const coins = this.coinBalances.get(playerIdKey);
    if (coins === undefined) return;
    await this.enqueueCoinBalancePersistence(playerId, playerIdKey, coins);
  }

  /**
   * Persist the current balance without swallowing unavailable/missing-player
   * or database errors. Ground-item custody uses this before removing coins
   * from the world, so success must mean the destination is durable.
   */
  async persistCoinsImmediateStrict(playerId: string): Promise<void> {
    const playerIdKey = toPlayerID(playerId);
    if (!playerIdKey) throw new Error("coin_persistence_player_invalid");
    const coins = this.coinBalances.get(playerIdKey);
    if (coins === undefined) {
      throw new Error("coin_persistence_balance_unavailable");
    }
    const database = this.getDatabase();
    if (!database) throw new Error("coin_persistence_database_unavailable");

    const previous = this.persistenceQueues.get(playerIdKey);
    const queued = (previous ?? Promise.resolve()).then(async () => {
      const row = await database.getPlayerAsync(playerId);
      if (!row) throw new Error("coin_persistence_player_missing");
      await database.savePlayerAsync(playerId, { coins });
    });
    this.persistenceQueues.set(playerIdKey, queued);
    try {
      await queued;
    } finally {
      if (this.persistenceQueues.get(playerIdKey) === queued) {
        this.persistenceQueues.delete(playerIdKey);
      }
    }
  }

  private async enqueueCoinBalancePersistence(
    playerId: string,
    playerIdKey: PlayerID,
    coins: number,
  ): Promise<void> {
    const previous = this.persistenceQueues.get(playerIdKey);
    const queued = (previous ?? Promise.resolve()).then(() =>
      this.persistCoinBalanceImmediate(playerId, coins),
    );
    this.persistenceQueues.set(playerIdKey, queued);

    try {
      await queued;
    } finally {
      if (this.persistenceQueues.get(playerIdKey) === queued) {
        this.persistenceQueues.delete(playerIdKey);
      }
    }
  }

  private async persistCoinBalanceImmediate(
    playerId: string,
    coins: number,
  ): Promise<void> {
    const db = this.getDatabase();
    if (!db) return;

    try {
      const row = await db.getPlayerAsync(playerId);
      if (row) {
        await db.savePlayerAsync(playerId, { coins });
      }
    } catch (error) {
      Logger.systemError(
        "CoinPouchSystem",
        `Failed to persist coins for ${playerId}`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  // === Balance Verification ===

  /**
   * Start periodic balance verification to detect and correct drift
   */
  private startVerification(): void {
    this.verificationInterval = setInterval(() => {
      this.verifyAllBalances();
    }, this.VERIFICATION_INTERVAL);
  }

  /**
   * Verify all player coin balances against database.
   * Auto-corrects any mismatches using database as source of truth.
   */
  private async verifyAllBalances(): Promise<void> {
    const db = this.getDatabase();
    if (!db) return;

    let verified = 0;
    let corrected = 0;

    for (const [playerIdKey, memoryBalance] of this.coinBalances) {
      try {
        const playerId = playerIdKey as string;
        const playerRow = await db.getPlayerAsync(playerId);
        if (!playerRow) continue;

        const dbBalance = playerRow.coins ?? 0;

        if (memoryBalance !== dbBalance) {
          Logger.system(
            "CoinPouchSystem",
            `Balance mismatch for ${playerId}: memory=${memoryBalance}, db=${dbBalance}. Using DB value.`,
          );

          // Correct memory balance to match database
          this.coinBalances.set(playerIdKey, dbBalance);
          corrected++;

          // Notify player of correction
          this.emitTypedEvent(EventType.INVENTORY_COINS_UPDATED, {
            playerId,
            coins: dbBalance,
          });
        }
        verified++;
      } catch {
        // Continue with other players
      }
    }

    if (corrected > 0) {
      Logger.system(
        "CoinPouchSystem",
        `Verification complete: ${verified} verified, ${corrected} corrected`,
      );
    }
  }

  // === Cleanup ===

  /**
   * Async destroy - properly awaits all database saves before cleanup.
   * Call this for graceful shutdown to prevent data loss.
   */
  async destroyAsync(): Promise<void> {
    // Stop verification interval
    if (this.verificationInterval) {
      clearInterval(this.verificationInterval);
      this.verificationInterval = undefined;
    }

    // Final save pass for all connected players before shutdown. Enqueueing
    // behind existing writes preserves mutation order and also drains any
    // disconnect persistence already in flight.
    if (this.world.isServer) {
      const savePromises = [...this.coinBalances.entries()].map(
        ([playerIdKey, coins]) =>
          this.enqueueCoinBalancePersistence(playerIdKey, playerIdKey, coins),
      );

      const results = await Promise.allSettled(savePromises);
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        Logger.systemError(
          "CoinPouchSystem",
          `${failures.length} coin saves failed during shutdown`,
          new Error("Partial save failure on shutdown"),
        );
      }
    }

    this.coinBalances.clear();
    this.loadingPlayers.clear();
    this.initializedPlayers.clear();
    this.persistenceQueues.clear();

    super.destroy();
  }

  destroy(): void {
    // Fire-and-forget async cleanup (best effort for non-async callers)
    this.destroyAsync().catch((err) => {
      Logger.systemError(
        "CoinPouchSystem",
        "Error during async destroy",
        err instanceof Error ? err : new Error(String(err)),
      );
    });
  }
}
