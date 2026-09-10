/**
 * DeathStateManager
 *
 * Tracks active player deaths with dual persistence:
 * - In-memory cache for fast access (client & server)
 * - Database persistence for durability (server only)
 *
 * Database persistence prevents item duplication on server restart/crash.
 * If server restarts mid-death, the death lock in DB prevents re-spawning items.
 *
 * NOTE: This is just for tracking - gravestone/ground items are regular
 * world entities that persist via the entity system.
 */

import type { World } from "../../../core/World";
import type {
  DeathLock,
  ZoneType,
  TransactionContext,
} from "../../../types/death";
import type { InventoryItem } from "../../../types/core/core";
import type { EntityManager } from "..";
import { EventType } from "../../../types/events";
import { isExternalValueEnabled } from "./PreparationDeathCustodyPolicy";

const DEBUG_DEATH_STATE = false;
const isTruthyEnv = (value: string | undefined): boolean =>
  value != null && /^(1|true|yes|on)$/i.test(value.trim());
const DEATH_STATE_DEBUG_LOGS =
  DEBUG_DEATH_STATE || isTruthyEnv(process.env.DEATH_STATE_DEBUG);

function _debugLog(message: string, ...args: unknown[]): void {
  if (DEATH_STATE_DEBUG_LOGS) {
    console.log(message, ...args);
  }
}

interface DeathItemData {
  itemId: string;
  quantity: number;
}

interface DeathLockData {
  playerId: string;
  gravestoneId: string | undefined;
  groundItemIds: string[];
  position: { x: number; y: number; z: number };
  timestamp: number;
  zoneType: ZoneType;
  itemCount: number;
  items: DeathItemData[];
  keptItems?: DeathItemData[]; // classic MMORPG keep-3 items returned on respawn
  deathOperationId?: string;
  killedBy: string;
  recovered: boolean;
}

// Type for DatabaseSystem (only available on server)
type DatabaseSystem = {
  saveDeathLockAsync: (
    data: DeathLockData,
    tx?: TransactionContext,
  ) => Promise<void>;
  getDeathLockAsync: (playerId: string) => Promise<DeathLockData | null>;
  deleteDeathLockAsync: (playerId: string) => Promise<void>;
  updateGroundItemsAsync: (
    playerId: string,
    groundItemIds: string[],
  ) => Promise<void>;
  getAllActiveDeathsAsync: () => Promise<DeathLockData[]>;
  markDeathRecoveredAsync: (playerId: string) => Promise<void>;
  acquireDeathLockAsync: (
    data: DeathLockData,
    tx?: TransactionContext,
  ) => Promise<boolean>;
};

export type DeathRecoveryRequest = {
  playerId: string;
  /** Immutable custody operation that owns the recovered inventory. */
  deathOperationId: string | null;
  /** Reuse the durable world identity when one was already committed. */
  gravestoneId: string | null;
  position: { x: number; y: number; z: number };
  items: InventoryItem[];
  killedBy: string;
  zoneType: ZoneType;
};

export type DeathRecoveryHandler = (
  request: DeathRecoveryRequest,
) => Promise<void>;

/**
 * DeathStateManager - Manages player death state with dual persistence
 *
 * Key responsibilities:
 * - Track active player deaths in-memory for fast access
 * - Persist death locks to database for crash recovery (server only)
 * - Recover unfinished deaths after server restart
 * - Prevent duplicate death processing
 *
 * @example
 * ```typescript
 * const manager = new DeathStateManager(world);
 * await manager.init();
 *
 * // Track a player death
 * await manager.createDeathLock(playerId, {
 *   gravestoneId: 'gravestone_123',
 *   position: { x: 100, y: 10, z: 200 },
 *   zoneType: ZoneType.SAFE_AREA,
 *   itemCount: 5,
 * });
 *
 * // Check if player has active death
 * const hasActiveDeath = await manager.hasActiveDeathLock(playerId);
 *
 * // Clear after items recovered
 * await manager.clearDeathLock(playerId);
 * ```
 */
export class DeathStateManager {
  private entityManager: EntityManager | null = null;
  private databaseSystem: DatabaseSystem | null = null;
  private recoveryHandler: DeathRecoveryHandler | null = null;

  /** In-memory cache for fast death lock lookups (both client and server) */
  private activeDeaths = new Map<string, DeathLock>();

  private readonly handlePlayerUnregistered = (event: unknown): void => {
    // Type guard: validate payload structure
    if (!event || typeof event !== "object" || !("id" in event)) {
      console.warn(
        "[DeathStateManager] Invalid PLAYER_UNREGISTERED payload:",
        event,
      );
      return;
    }
    const data = event as { id: string };
    void this.handlePlayerDisconnect(data.id);
  };

  constructor(private world: World) {}

  /**
   * Installs the server-owned artifact restorer used during startup recovery.
   * Recovery is awaited before durable rows are marked recovered, so a player
   * can never reconnect between an uncommitted spawn and its database identity.
   */
  setRecoveryHandler(handler: DeathRecoveryHandler): void {
    this.recoveryHandler = handler;
  }

  /**
   * Initialize - get entity manager and database system references
   * Note: Death recovery is deferred to start() to ensure DatabaseSystem is fully initialized
   */
  async init(): Promise<void> {
    this.entityManager = this.world.getSystem(
      "entity-manager",
    ) as EntityManager | null;

    // Get database system (server only)
    if (this.world.isServer) {
      this.databaseSystem = this.world.getSystem(
        "database",
      ) as unknown as DatabaseSystem | null;
      if (this.databaseSystem) {
        console.log(
          "[DeathStateManager] ✓ Initialized with database persistence (server)",
        );
      } else {
        console.warn(
          "[DeathStateManager] ⚠️ DatabaseSystem not available - running without persistence!",
        );
      }
      this.world.on(
        EventType.PLAYER_UNREGISTERED,
        this.handlePlayerUnregistered,
      );
    } else {
      console.log("[DeathStateManager] ✓ Initialized (client, in-memory only)");
    }
  }

  /**
   * Start - called after all systems are initialized.
   * Recovers unfinished deaths from previous server session.
   */
  async start(): Promise<void> {
    _debugLog(
      `[DeathStateManager] start() called - isServer: ${this.world.isServer}, hasDB: ${!!this.databaseSystem}`,
    );
    if (this.world.isServer && this.databaseSystem) {
      if (isTruthyEnv(process.env.SKIP_DEATH_RECOVERY_ON_STARTUP)) {
        _debugLog(
          "[DeathStateManager] Skipping startup death recovery (SKIP_DEATH_RECOVERY_ON_STARTUP=true)",
        );
        return;
      }

      const configuredTimeoutMs = Number.parseInt(
        process.env.DEATH_RECOVERY_STARTUP_TIMEOUT_MS || "",
        10,
      );
      const recoveryTimeoutMs =
        Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
          ? configuredTimeoutMs
          : 10_000;

      const recoveryPromise = this.recoverUnfinishedDeaths();
      const completedWithinTimeout = await Promise.race([
        recoveryPromise.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), recoveryTimeoutMs),
        ),
      ]);

      if (!completedWithinTimeout) {
        if (isExternalValueEnabled()) {
          throw new Error(
            `death_recovery_startup_timeout:${recoveryTimeoutMs}`,
          );
        }
        console.warn(
          `[DeathStateManager] Startup death recovery exceeded ${recoveryTimeoutMs}ms; continuing startup while recovery finishes in background`,
        );
        void recoveryPromise.catch((error) => {
          console.error(
            "[DeathStateManager] Background death recovery failed:",
            error,
          );
        });
      }
    }
  }

  /**
   * Clean up death lock from memory when player disconnects.
   *
   * When a player disconnects mid-death, we keep the death lock in the database
   * but clear it from memory. This allows:
   * 1. The gravestone/ground items to persist for other players to see
   * 2. The player to recover their items when they reconnect
   * 3. Memory to be freed for disconnected players
   *
   * NOTE: We do NOT delete from database - the death lock ensures items
   * aren't duplicated if the player reconnects and tries to die again.
   */
  private async handlePlayerDisconnect(playerId: string): Promise<void> {
    const deathData = this.activeDeaths.get(playerId);
    if (!deathData) {
      return; // No active death for this player
    }

    // Clear from memory but keep in database for reconnect validation
    this.activeDeaths.delete(playerId);

    console.log(
      `[DeathStateManager] Cleared death lock from memory for disconnected player ${playerId} (preserved in database for reconnect)`,
    );
  }

  /**
   * Recover active death custody from database after server restart.
   *
   * CRITICAL: Prevents item loss when server crashes during death handling.
   *
   * Recovery logic:
   * 1. Query every active player_deaths row. Runtime entities do not survive a
   *    process restart, including rows already recovered by an earlier process.
   * 2. For each death, check if gravestone/ground items still exist
   * 3. If not, emit DEATH_RECOVERED event to recreate them
   * 4. Mark death as recovered in database
   */
  private async recoverUnfinishedDeaths(): Promise<void> {
    if (!this.databaseSystem) return;

    console.log(
      "[DeathStateManager] ========== CRASH RECOVERY START ==========",
    );
    console.log(
      "[DeathStateManager] Checking for unfinished deaths to recover...",
    );

    try {
      const activeDeaths = await this.databaseSystem.getAllActiveDeathsAsync();
      console.log(
        `[DeathStateManager] Database returned ${activeDeaths.length} active deaths`,
      );

      if (activeDeaths.length === 0) {
        console.log("[DeathStateManager] No active deaths to recover");
        return;
      }

      console.log(
        `[DeathStateManager] Found ${activeDeaths.length} active deaths to recover`,
      );

      let recoveredCount = 0;
      const recoveryFailures: Array<{ playerId: string; error: unknown }> = [];
      for (const death of activeDeaths) {
        try {
          await this.recoverSingleDeath(death);
          recoveredCount++;
        } catch (error) {
          recoveryFailures.push({ playerId: death.playerId, error });
          console.error(
            `[DeathStateManager] Failed to recover death custody for ${death.playerId}:`,
            error,
          );
        }
      }

      console.log(
        `[DeathStateManager] Recovery complete: ${recoveredCount}/${activeDeaths.length} deaths restored`,
      );
      if (recoveryFailures.length > 0 && isExternalValueEnabled()) {
        throw new AggregateError(
          recoveryFailures.map(({ error }) => error),
          `death_recovery_startup_incomplete:${recoveredCount}/${activeDeaths.length}:${recoveryFailures.map(({ playerId }) => playerId).join(",")}`,
        );
      }
    } catch (error) {
      console.error("[DeathStateManager] Death recovery failed:", error);
      if (isExternalValueEnabled()) {
        throw error;
      }
      // Diagnostic/non-value worlds may remain available for operator repair.
      // Items may be lost but server remains functional
    }
  }

  /**
   * Recover a single unfinished death
   *
   * Checks if entities still exist, recreates if necessary, marks as recovered.
   */
  private async recoverSingleDeath(death: DeathLockData): Promise<void> {
    const {
      playerId,
      gravestoneId,
      groundItemIds,
      position,
      zoneType,
      items,
      killedBy,
    } = death;

    console.log(
      `[DeathStateManager] -------- Recovering death for ${playerId} --------`,
    );
    console.log(
      `[DeathStateManager]   Items: ${items.length}, Zone: ${zoneType}, Killed by: ${killedBy}`,
    );
    console.log(
      `[DeathStateManager]   Position: (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`,
    );
    console.log(
      `[DeathStateManager]   Gravestone ID: ${gravestoneId || "(none)"}, Ground items: ${groundItemIds.length}`,
    );
    if (items.length > 0) {
      console.log(
        `[DeathStateManager]   Item details: ${items.map((i) => `${i.itemId}x${i.quantity}`).join(", ")}`,
      );
    }

    if (isExternalValueEnabled()) {
      if (!death.deathOperationId) {
        throw new Error("external_value_death_custody_legacy_row");
      }
      if (groundItemIds.length > 0) {
        throw new Error("external_value_death_custody_public_items");
      }
    }

    // Check if gravestone still exists
    let gravestoneExists = false;
    if (gravestoneId && this.entityManager) {
      const entity = this.world.entities?.get(gravestoneId);
      gravestoneExists = !!entity;
    }

    // Check if ground items still exist
    const existingGroundItems = groundItemIds.filter((id) => {
      return !!this.world.entities?.get(id);
    });

    // If items are already recovered (entities exist), just restore memory state
    if (gravestoneExists || existingGroundItems.length > 0) {
      console.log(
        `[DeathStateManager] Death for ${playerId} partially recovered - entities exist`,
      );

      // Restore to in-memory cache
      this.activeDeaths.set(playerId, {
        playerId,
        gravestoneId: gravestoneExists ? gravestoneId! : undefined,
        groundItemIds: existingGroundItems,
        position,
        timestamp: Date.now(),
        zoneType: zoneType as ZoneType,
        itemCount: items.length,
        items,
        keptItems: death.keptItems,
        deathOperationId: death.deathOperationId,
        killedBy,
        recovered: death.recovered,
      });
    } else if (items.length > 0) {
      // Items were stored but entities don't exist - recreate them
      console.log(
        `[DeathStateManager] Recreating items for ${playerId} death recovery (${items.length} items)`,
      );

      // Convert stored items back to InventoryItem format
      const inventoryItems: InventoryItem[] = items.map((item, index) => ({
        id: `recovery_${playerId}_${Date.now()}_${index}`,
        itemId: item.itemId,
        quantity: item.quantity,
        slot: -1,
        metadata: null,
      }));

      // CRITICAL: Restore to in-memory cache for player reconnect flow
      // This ensures onPlayerReconnect() can find the death lock with items
      this.activeDeaths.set(playerId, {
        playerId,
        // Preserve the committed identity even though this process has not
        // restored the entity yet. The recovery handler binds its spawn to it.
        gravestoneId: gravestoneId ?? undefined,
        groundItemIds: [],
        position,
        timestamp: Date.now(),
        zoneType: zoneType as ZoneType,
        itemCount: items.length,
        items: items,
        keptItems: death.keptItems,
        deathOperationId: death.deathOperationId,
        killedBy,
        recovered: false, // Will be marked true after reconnect
      });

      if (!this.recoveryHandler) {
        throw new Error("death_recovery_handler_unavailable");
      }

      // The artifact spawn and its durable identity update are one awaited
      // recovery step. Do not mark the row recovered before this completes.
      await this.recoveryHandler({
        playerId,
        deathOperationId: death.deathOperationId ?? null,
        gravestoneId: gravestoneId ?? null,
        position,
        items: inventoryItems,
        killedBy,
        zoneType: zoneType as ZoneType,
      });
    }

    // Mark death as recovered in database
    await this.databaseSystem!.markDeathRecoveredAsync(playerId);
    const recovered = this.activeDeaths.get(playerId);
    if (recovered) {
      this.activeDeaths.set(playerId, { ...recovered, recovered: true });
    }

    console.log(`[DeathStateManager] ✓ Death recovered for ${playerId}`);
  }

  /**
   * Track a player death (for cleanup purposes)
   * Database-first write order - stores in database BEFORE memory
   * Uses atomic acquisition to prevent race conditions
   *
   * @param playerId - The player who died
   * @param options - Death lock options (gravestone ID, ground items, position, etc.)
   * @param tx - Optional transaction context for atomic operations (server only)
   * @returns true if death lock was created, false if player already has one
   */
  async createDeathLock(
    playerId: string,
    options: {
      gravestoneId?: string;
      groundItemIds?: string[];
      position: { x: number; y: number; z: number };
      zoneType: ZoneType;
      itemCount: number;
      // Crash recovery fields
      items?: Array<{ itemId: string; quantity: number }>;
      keptItems?: Array<{ itemId: string; quantity: number }>;
      deathOperationId?: string;
      killedBy?: string;
    },
    tx?: TransactionContext,
  ): Promise<boolean> {
    // CRITICAL: Server authority check - prevent client from creating fake death locks
    if (!this.world.isServer) {
      console.error(
        `[DeathStateManager] ⚠️  Client attempted server-only death lock creation for ${playerId} - BLOCKED`,
      );
      return false;
    }

    // Fast path - check memory first to avoid DB round-trip
    if (this.activeDeaths.has(playerId)) {
      console.warn(
        `[DeathStateManager] Death lock already exists in memory for ${playerId} - rejecting duplicate`,
      );
      return false;
    }

    const timestamp = Date.now();

    const deathLockData: DeathLockData = {
      playerId,
      gravestoneId: options.gravestoneId || undefined,
      groundItemIds: options.groundItemIds || [],
      position: options.position,
      timestamp,
      zoneType: options.zoneType,
      itemCount: options.itemCount,
      // Crash recovery fields
      items: options.items || [],
      keptItems: options.keptItems,
      deathOperationId: options.deathOperationId,
      killedBy: options.killedBy || "unknown",
      recovered: false, // New deaths are not yet recovered
    };

    // Use ATOMIC acquisition to prevent race conditions
    // This uses INSERT ... ON CONFLICT DO NOTHING with RETURNING
    // If another request already inserted a death lock, this returns false
    if (this.databaseSystem) {
      try {
        const acquired = await this.databaseSystem.acquireDeathLockAsync(
          deathLockData,
          tx,
        );

        if (!acquired) {
          // Another request already created a death lock for this player
          console.warn(
            `[DeathStateManager] Death lock already exists in database for ${playerId} - atomic acquisition failed`,
          );
          // Restore to memory for faster future checks
          const existingLock =
            await this.databaseSystem.getDeathLockAsync(playerId);
          if (existingLock) {
            this.activeDeaths.set(playerId, existingLock);
          }
          return false;
        }

        console.log(
          `[DeathStateManager] ✓ Atomically acquired death lock in database for ${playerId}${tx ? " (in transaction)" : ""}`,
        );
      } catch (error) {
        console.error(
          `[DeathStateManager] ❌ Failed to acquire death lock for ${playerId}:`,
          error,
        );
        // If in transaction, re-throw to trigger rollback
        if (tx) {
          throw error;
        }
        // If DB write fails and not in transaction, still update memory
        // but log warning that crash recovery won't work
        console.warn(
          `[DeathStateManager] ⚠️ Death lock for ${playerId} only in memory - crash recovery won't work!`,
        );
      }
    }

    // Update memory AFTER successful database write (or if no DB system)
    // Include crash recovery fields for proper item tracking
    const deathData: DeathLock = {
      playerId,
      gravestoneId: options.gravestoneId,
      groundItemIds: options.groundItemIds,
      position: options.position,
      timestamp,
      zoneType: options.zoneType,
      itemCount: options.itemCount,
      // Crash recovery fields - track items for database sync
      items: options.items,
      keptItems: options.keptItems,
      deathOperationId: options.deathOperationId,
      killedBy: options.killedBy,
      recovered: false,
    };
    this.activeDeaths.set(playerId, deathData);

    console.log(
      `[DeathStateManager] ✓ Tracking death for ${playerId}: ${options.itemCount} items, zone: ${options.zoneType}, items saved: ${options.items?.length || 0}`,
    );

    return true;
  }

  /**
   * Update the gravestone ID for an existing death lock.
   * Used when a gravestone is spawned after the death lock was already created
   * (e.g., post-respawn gravestone spawning, crash recovery).
   */
  async updateGravestoneId(
    playerId: string,
    gravestoneId: string,
  ): Promise<void> {
    // Update the database before the cache. Loot must not be enabled against a
    // gravestone identity that durable custody does not recognize.
    if (this.world.isServer && this.databaseSystem) {
      try {
        const dbData = await this.databaseSystem.getDeathLockAsync(playerId);
        if (!dbData) {
          throw new Error("death_lock_missing");
        }
        dbData.gravestoneId = gravestoneId;
        await this.databaseSystem.saveDeathLockAsync(dbData);
        this.activeDeaths.set(playerId, {
          ...dbData,
          gravestoneId,
          deathOperationId: dbData.deathOperationId ?? undefined,
        });
        console.log(
          `[DeathStateManager] ✓ Updated gravestone ID for ${playerId}: ${gravestoneId}`,
        );
      } catch (error) {
        console.error(
          `[DeathStateManager] ❌ Failed to update gravestone ID for ${playerId}:`,
          error,
        );
        throw error;
      }
      return;
    }

    const deathData = this.activeDeaths.get(playerId);
    if (deathData) {
      deathData.gravestoneId = gravestoneId;
      this.activeDeaths.set(playerId, deathData);
    }
  }

  /**
   * Clear death tracking (items have been looted or despawned)
   * Removes from memory AND database (server only)
   */
  async clearDeathLock(playerId: string): Promise<void> {
    // Delete from database FIRST (server only) to prevent recovery of stale locks on restart
    if (this.world.isServer && this.databaseSystem) {
      try {
        await this.databaseSystem.deleteDeathLockAsync(playerId);
        console.log(
          `[DeathStateManager] ✓ Deleted death lock from database for ${playerId}`,
        );
      } catch (error) {
        console.error(
          `[DeathStateManager] ❌ Failed to delete death lock for ${playerId}, keeping in-memory state consistent:`,
          error,
        );
        // Do NOT clear in-memory — keeps state consistent with DB for retry
        return;
      }
    }

    // Only clear in-memory after DB delete succeeds (or if no DB)
    this.activeDeaths.delete(playerId);
    console.log(`[DeathStateManager] ✓ Cleared death tracking for ${playerId}`);
  }

  /**
   * Get active death data
   * Checks in-memory cache first, then database (server only) as fallback
   */
  async getDeathLock(playerId: string): Promise<DeathLock | null> {
    // Check in-memory cache first (fast path)
    const cached = this.activeDeaths.get(playerId);
    if (cached) {
      return cached;
    }

    // Fallback to database (server only) - critical for reconnect validation
    if (this.world.isServer && this.databaseSystem) {
      try {
        const dbData = await this.databaseSystem.getDeathLockAsync(playerId);
        if (dbData) {
          // Reconstruct DeathLock from database data INCLUDING crash recovery fields
          const deathLock: DeathLock = {
            playerId: dbData.playerId,
            gravestoneId: dbData.gravestoneId || undefined,
            groundItemIds: dbData.groundItemIds,
            position: dbData.position,
            timestamp: dbData.timestamp,
            zoneType: dbData.zoneType as ZoneType,
            itemCount: dbData.itemCount,
            // CRITICAL: Include crash recovery fields for gravestone recreation
            items: dbData.items,
            keptItems: dbData.keptItems,
            deathOperationId: dbData.deathOperationId ?? undefined,
            killedBy: dbData.killedBy,
            recovered: dbData.recovered,
          };

          // Restore to in-memory cache
          this.activeDeaths.set(playerId, deathLock);
          console.log(
            `[DeathStateManager] ✓ Restored death lock from database for ${playerId} (${dbData.items?.length || 0} items)`,
          );
          return deathLock;
        }
      } catch (error) {
        console.error(
          `[DeathStateManager] ❌ Failed to fetch death lock from database for ${playerId}:`,
          error,
        );
        // Fall through to return null
      }
    }

    return null;
  }

  /**
   * Refresh an active death lock from the authoritative database.
   * Used after database-native custody operations mutate the lock outside this cache.
   */
  async refreshDeathLock(playerId: string): Promise<DeathLock | null> {
    this.activeDeaths.delete(playerId);
    return this.getDeathLock(playerId);
  }

  /**
   * Check if player has active death
   * Checks in-memory cache first, then database (server only) for reconnect validation
   */
  async hasActiveDeathLock(playerId: string): Promise<boolean> {
    // Check in-memory cache first (fast path)
    if (this.activeDeaths.has(playerId)) {
      return true;
    }

    // Fallback to database (server only) - CRITICAL for reconnect validation
    // Prevents duplicate deaths when player reconnects after server restart
    if (this.world.isServer && this.databaseSystem) {
      try {
        const dbData = await this.databaseSystem.getDeathLockAsync(playerId);
        if (dbData) {
          // Death lock exists in database - restore to memory
          const deathLock: DeathLock = {
            playerId: dbData.playerId,
            gravestoneId: dbData.gravestoneId || undefined,
            groundItemIds: dbData.groundItemIds,
            position: dbData.position,
            timestamp: dbData.timestamp,
            zoneType: dbData.zoneType as ZoneType,
            itemCount: dbData.itemCount,
            items: dbData.items,
            keptItems: dbData.keptItems,
            deathOperationId: dbData.deathOperationId ?? undefined,
            killedBy: dbData.killedBy,
            recovered: dbData.recovered,
          };
          this.activeDeaths.set(playerId, deathLock);
          console.log(
            `[DeathStateManager] ✓ Restored death lock from database for ${playerId} (hasActiveDeathLock check)`,
          );
          return true;
        }
      } catch (error) {
        console.error(
          `[DeathStateManager] ❌ Failed to check death lock in database for ${playerId}:`,
          error,
        );
        // Fall through to return false
      }
    }

    return false;
  }

  /**
   * Handle item looted from gravestone/ground
   * Updates in-memory AND database (server only)
   *
   * @param playerId - The player whose items are being looted
   * @param itemId - The item ID that was looted (item manifest ID, not entity ID)
   * @param quantity - How many were looted (default 1)
   */
  async onItemLooted(
    playerId: string,
    itemId: string,
    quantity: number = 1,
  ): Promise<void> {
    const deathData = this.activeDeaths.get(playerId);
    if (!deathData) return;

    let itemRemoved = false;

    // Remove item from ground item list (entity IDs)
    if (deathData.groundItemIds) {
      const index = deathData.groundItemIds.indexOf(itemId);
      if (index !== -1) {
        deathData.groundItemIds.splice(index, 1);
        itemRemoved = true;
      }
    }

    // Remove item from items array (crash recovery tracking)
    // Only decrement itemCount when item is fully removed, not on partial loot
    if (deathData.items && deathData.items.length > 0) {
      const itemIndex = deathData.items.findIndex((i) => i.itemId === itemId);
      if (itemIndex !== -1) {
        const item = deathData.items[itemIndex];
        if (item.quantity <= quantity) {
          // Remove entire item and decrement count
          deathData.items.splice(itemIndex, 1);
          deathData.itemCount = Math.max(0, deathData.itemCount - 1);
        } else {
          // Reduce quantity but keep item in array (don't decrement itemCount)
          item.quantity -= quantity;
        }
      }
    } else if (itemRemoved) {
      // No items array but we removed from groundItemIds - decrement itemCount
      deathData.itemCount = Math.max(0, deathData.itemCount - 1);
    }

    // If all items looted, clear death tracking
    if (deathData.itemCount === 0) {
      await this.clearDeathLock(playerId);
      console.log(
        `[DeathStateManager] ✓ All items looted for ${playerId}, cleared tracking`,
      );
    } else {
      // Update in-memory record
      this.activeDeaths.set(playerId, deathData);

      // Update database (server only)
      if (this.world.isServer && this.databaseSystem) {
        try {
          await this.databaseSystem.saveDeathLockAsync({
            playerId,
            gravestoneId: deathData.gravestoneId || undefined,
            groundItemIds: deathData.groundItemIds || [],
            position: deathData.position,
            timestamp: deathData.timestamp,
            zoneType: deathData.zoneType,
            itemCount: deathData.itemCount,
            // Crash recovery: now properly synced with in-memory items array
            items: deathData.items || [],
            keptItems: deathData.keptItems || [],
            deathOperationId: deathData.deathOperationId,
            killedBy: deathData.killedBy || "unknown",
            recovered: deathData.recovered || false,
          });
        } catch (error) {
          console.error(
            `[DeathStateManager] ❌ Failed to update death lock after item looted:`,
            error,
          );
        }
      }
    }
  }

  /**
   * Handle gravestone expired (transitioned to ground items)
   * Updates in-memory AND database (server only)
   */
  async onGravestoneExpired(
    playerId: string,
    groundItemIds: string[],
  ): Promise<void> {
    const deathData = this.activeDeaths.get(playerId);
    if (!deathData) return;

    // Update tracking: gravestone → ground items
    deathData.gravestoneId = undefined;
    deathData.groundItemIds = groundItemIds;
    this.activeDeaths.set(playerId, deathData);

    // Update database (server only)
    if (this.world.isServer && this.databaseSystem) {
      try {
        await this.databaseSystem.updateGroundItemsAsync(
          playerId,
          groundItemIds,
        );
        console.log(
          `[DeathStateManager] ✓ Updated database: gravestone → ground items for ${playerId}`,
        );
      } catch (error) {
        console.error(
          `[DeathStateManager] ❌ Failed to update database after gravestone expired:`,
          error,
        );
      }
    }

    console.log(
      `[DeathStateManager] ✓ Gravestone expired for ${playerId}, transitioned to ${groundItemIds.length} ground items`,
    );
  }

  /**
   * Clean up event listeners and clear memory
   * Unsubscribe from player disconnect events
   */
  destroy(): void {
    // Unsubscribe from player disconnect events
    this.world.off(
      EventType.PLAYER_UNREGISTERED,
      this.handlePlayerUnregistered,
    );

    // Clear in-memory cache
    this.activeDeaths.clear();

    console.log("[DeathStateManager] Destroyed");
  }
}
