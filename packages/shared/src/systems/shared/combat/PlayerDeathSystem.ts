import { SystemBase } from "../infrastructure/SystemBase";
import type { World } from "../../../core/World";
import { EventType } from "../../../types/events";
import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";
import { ticksToMs } from "../../../utils/game/CombatCalculations";
import type {
  InventoryItem,
  DeathLocationData,
} from "../../../types/core/core";
import { calculateDistance } from "../../../utils/game/EntityUtils";
import { DeathState } from "../../../types/entities";
import type { EntityManager } from "..";
import { ZoneDetectionSystem } from "../death/ZoneDetectionSystem";
import type { GroundItemSystem } from "../economy/GroundItemSystem";
import { DeathStateManager } from "../death/DeathStateManager";
import type { DeathRecoveryRequest } from "../death/DeathStateManager";
import { SafeAreaDeathHandler } from "../death/SafeAreaDeathHandler";
import { WildernessDeathHandler } from "../death/WildernessDeathHandler";
import { ZoneType, type TransactionContext } from "../../../types/death";
import type { InventorySystem } from "../character/InventorySystem";
import { getEntityPosition } from "../../../utils/game/EntityPositionUtils";
import { STARTER_TOWNS } from "../../../data/world-areas";
import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import { isPositionInsideDuelArenaZone } from "../../../data/duel-manifest";
import {
  isExternalValueEnabled,
  requirePreparationDeathCustodyPolicy,
} from "../death/PreparationDeathCustodyPolicy";
import { generateTransactionId } from "../../../utils/IdGenerator";
import type {
  GroundItemDeathCommitReceipt,
  GroundItemDeathCommitRequest,
} from "../../../types/network/database";
import { serializeGroundItemDeathCommitFingerprint } from "../../../utils/game/GroundItemDeathRegistration";
import { generateGroundItemDeathOperationId } from "../../../utils/game/GroundItemSourceIdentity";
import type {
  PlayerSystemLike,
  DatabaseSystemLike,
  EquipmentSystemLike,
  TerrainSystemLike,
  NetworkLike,
  TickSystemLike,
  PlayerEntityLike,
  DeathLocationDataWithHeadstone,
} from "./DeathTypes";
import {
  sanitizeKilledBy,
  ITEMS_KEPT_ON_DEATH,
  GRAVESTONE_ID_PREFIX,
  splitItemsForSafeDeath,
  validatePosition,
  isPositionInBounds,
} from "./DeathUtils";

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("web_crypto_unavailable");
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isDefinitiveDeathCustodyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith("safe_death_") ||
    message.startsWith("ground_item_death_") ||
    message.startsWith("ground_item_source_")
  );
}

function isAmbiguousDeathCustodyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("death_custody_commit_unknown:");
}

/**
 * Orchestrates player death via modular handlers (zone detection, safe area, wilderness).
 * Safe zones: gravestone (5min) → ground (2min). Wilderness: ground immediately (2min).
 */
export class PlayerDeathSystem extends SystemBase {
  private deathLocations = new Map<string, DeathLocationData>();
  private respawnTimers = new Map<string, NodeJS.Timeout>();
  private playerPositions = new Map<
    string,
    { x: number; y: number; z: number }
  >();
  private playerInventories = new Map<
    string,
    { items: InventoryItem[]; coins: number }
  >();
  private pendingGravestones = new Map<
    string,
    {
      position: { x: number; y: number; z: number };
      items: InventoryItem[];
      killedBy: string;
      zoneType: ZoneType;
    }
  >();

  // classic MMORPG-style: Items kept on death (top 3 most valuable) — returned on respawn.
  // In-memory for fast access; also persisted in death lock (keptItems field) for
  // crash recovery. On respawn, in-memory is preferred; on reconnect after crash,
  // DeathStateManager loads keptItems from DB.
  private itemsKeptOnDeath = new Map<string, InventoryItem[]>();

  // Guard: prevents respawn race while death transaction is in progress
  private deathProcessingInProgress = new Set<string>();

  // A respawn can await gravestone custody, database reloads, and kept-item
  // restoration. Keep one exact completion boundary per player so event, tick,
  // reconnect, and embedded-agent requests cannot run that work concurrently.
  private respawnInProgress = new Set<string>();

  // Single-retry queue for post-transaction DB persist failures.
  // Bounded to MAX_PERSIST_RETRIES to prevent unbounded growth if DB is persistently unavailable.
  private static readonly MAX_PERSIST_RETRIES = 100;
  private pendingPersistRetries: Array<{
    playerId: string;
    type: "equipment" | "inventory";
  }> = [];
  // Tracks players with in-flight persist retries to prevent races with reconnect/new death
  private persistRetryInFlight = new Set<string>();

  private lastDeathTime = new Map<string, number>();
  private readonly DEATH_COOLDOWN = ticksToMs(
    COMBAT_CONSTANTS.DEATH.COOLDOWN_TICKS,
  );

  // Tick-based respawn system (AAA quality - deterministic timing)
  private tickSystem: TickSystemLike | null = null;
  private tickUnsubscribe: (() => void) | null = null;

  private zoneDetection!: ZoneDetectionSystem;
  private groundItemSystem!: GroundItemSystem;
  private deathStateManager!: DeathStateManager;
  private safeAreaHandler!: SafeAreaDeathHandler;
  private wildernessHandler!: WildernessDeathHandler;

  constructor(world: World) {
    super(world, {
      name: "player-death",
      dependencies: {
        required: ["ground-items"], // Depends on shared GroundItemSystem
        optional: ["inventory", "entity-manager", "database"], // database for death persistence (server only)
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    this.zoneDetection = new ZoneDetectionSystem(this.world);
    await this.zoneDetection.init();

    this.groundItemSystem = this.world.getSystem("ground-items")!;
    if (!this.groundItemSystem) {
      this.logger.error("GroundItemSystem not found");
    }

    this.deathStateManager = new DeathStateManager(this.world);
    await this.deathStateManager.init();

    // Register for tick-based respawn processing (AAA quality - deterministic timing)
    // TickSystem is only available on server
    if (this.world.isServer) {
      const tickSystemRaw = this.world.getSystem("tick");
      if (
        tickSystemRaw &&
        "getCurrentTick" in tickSystemRaw &&
        "onTick" in tickSystemRaw
      ) {
        this.tickSystem = tickSystemRaw as unknown as TickSystemLike;
        // Priority 3 = AI priority, runs after combat
        this.tickUnsubscribe = this.tickSystem.onTick(
          (tickNumber) => this.processPendingRespawns(tickNumber),
          3,
        );
      }
    }

    this.safeAreaHandler = new SafeAreaDeathHandler(
      this.world,
      this.groundItemSystem,
      this.deathStateManager,
    );
    this.deathStateManager.setRecoveryHandler((request) =>
      this.restoreDeathCustody(request),
    );

    this.wildernessHandler = new WildernessDeathHandler(
      this.world,
      this.groundItemSystem,
      this.deathStateManager,
    );

    this.subscribe(
      EventType.ENTITY_DEATH,
      (data: {
        entityId: string;
        killedBy: string;
        entityType: "player" | "mob";
        combatProgressCommitted?: boolean;
      }) => this.handlePlayerDeath(data),
    );
    this.subscribe(
      EventType.PLAYER_RESPAWN_REQUEST,
      (data: { playerId: string }) => this.handleRespawnRequest(data),
    );
    this.subscribe(EventType.DEATH_LOOT_COLLECT, (data: { playerId: string }) =>
      this.handleLootCollection(data),
    );
    this.subscribe(EventType.PLAYER_UNREGISTERED, (data: { id: string }) => {
      this.cleanupPlayerDeath(data);
      this.playerInventories.delete(data.id);
      this.itemsKeptOnDeath.delete(data.id);
    });
    this.subscribe(
      EventType.DEATH_HEADSTONE_EXPIRED,
      (data: { headstoneId: string; playerId: string }) =>
        this.handleHeadstoneExpired(data),
    );
    this.subscribe(
      EventType.CORPSE_EMPTY,
      (data: { corpseId: string; playerId: string }) =>
        this.handleCorpseEmpty(data),
    );
    this.subscribe(EventType.PLAYER_JOINED, (data: { playerId: string }) =>
      this.handlePlayerReconnect(data),
    );

    this.subscribe(
      EventType.PLAYER_POSITION_UPDATED,
      (data: {
        playerId: string;
        position: { x: number; y: number; z: number };
      }) => {
        this.playerPositions.set(data.playerId, data.position);
      },
    );

    this.subscribe(
      EventType.INVENTORY_UPDATED,
      (data: { playerId: string; items: InventoryItem[]; coins: number }) => {
        const inventory = this.playerInventories.get(data.playerId) || {
          items: [],
          coins: 0,
        };
        inventory.items = data.items;
        this.playerInventories.set(data.playerId, inventory);
      },
    );

    this.subscribe(
      EventType.INVENTORY_COINS_UPDATED,
      (data: { playerId: string; newAmount: number }) => {
        const inventory = this.playerInventories.get(data.playerId) || {
          items: [],
          coins: 0,
        };
        inventory.coins = data.newAmount;
        this.playerInventories.set(data.playerId, inventory);
      },
    );
  }

  /**
   * Start - called after all systems are initialized
   * Delegates to DeathStateManager to recover unfinished deaths
   */
  async start(): Promise<void> {
    await this.deathStateManager.start();
  }

  destroy(): void {
    // Unsubscribe from tick system
    if (this.tickUnsubscribe) {
      this.tickUnsubscribe();
      this.tickUnsubscribe = null;
    }

    // Clean up modular death system components
    if (this.safeAreaHandler) {
      this.safeAreaHandler.destroy();
    }
    if (this.wildernessHandler) {
      this.wildernessHandler.destroy();
    }
    for (const timer of this.respawnTimers.values()) {
      clearTimeout(timer);
    }

    // Clean up all Maps to prevent memory leaks
    this.respawnTimers.clear();
    this.deathLocations.clear();
    this.playerPositions.clear();
    this.playerInventories.clear();
    this.pendingGravestones.clear();
    this.lastDeathTime.clear();
    this.itemsKeptOnDeath.clear();
    this.deathProcessingInProgress.clear();
    this.pendingPersistRetries.length = 0;
    this.persistRetryInFlight.clear();
  }

  private async handlePlayerDeath(data: {
    entityId: string;
    killedBy: string;
    entityType: "player" | "mob";
    deathPosition?: { x: number; y: number; z: number };
    combatProgressCommitted?: boolean;
  }): Promise<void> {
    // Skip gravestone entity destruction events — not player deaths.
    // This is a performance optimization (avoids entering processPlayerDeath for
    // non-player entities). The real security boundary is the isServer check in
    // _processPlayerDeathInner which prevents client-triggered death processing.
    // Gravestone IDs are server-generated (SafeAreaDeathHandler.spawnGravestone).
    if (data.entityId?.startsWith(GRAVESTONE_ID_PREFIX)) {
      return;
    }

    // Guard: if this player's death is already being processed (e.g., two ENTITY_DEATH
    // events fired in rapid succession), skip the duplicate. processPlayerDeath also
    // adds to this set, but checking here avoids unnecessary work before that point.
    if (this.deathProcessingInProgress.has(data.entityId)) {
      return;
    }

    // Only handle player deaths - mob deaths are handled by MobDeathSystem
    if (data.entityType !== "player") {
      // Fallback: Check if entityId looks like a player (fixes rare bug if entityType missing)
      const entityId = data.entityId || "";
      if (
        !entityId.includes("player_") &&
        !entityId.includes("user_") &&
        !entityId.startsWith("player-") &&
        !entityId.startsWith("user-")
      ) {
        return; // Definitely not a player
      }
    }

    const playerId = data.entityId;

    // CRITICAL: Use position from event first (captured at exact moment of death)
    // Fall back to cache only if event doesn't include position
    let deathPosition = data.deathPosition;
    if (!deathPosition) {
      deathPosition = this.playerPositions.get(playerId);
    }
    if (!deathPosition) {
      const playerEntity = this.world.entities?.get?.(playerId);
      if (playerEntity) {
        const entityPos = getEntityPosition(playerEntity);
        if (entityPos) {
          deathPosition = { x: entityPos.x, y: entityPos.y, z: entityPos.z };
        }
      }
    }

    // Check if player is in an active duel - DuelSystem handles duel deaths.
    // Also honor streaming-duel flags to suppress normal respawn/death-lock flow.
    // No gravestone or item drops should occur during duel-owned deaths.
    const duelSystem = this.world.getSystem?.("duel") as {
      isPlayerInActiveDuel?: (playerId: string) => boolean;
    } | null;
    const deadPlayerEntity = this.world.entities?.get?.(playerId) as
      | {
          data?: {
            inStreamingDuel?: boolean;
            preventRespawn?: boolean;
          };
        }
      | undefined;
    const inStreamingDuel =
      deadPlayerEntity?.data?.inStreamingDuel === true ||
      deadPlayerEntity?.data?.preventRespawn === true;

    if (duelSystem?.isPlayerInActiveDuel?.(playerId) || inStreamingDuel) {
      // CRITICAL: Cancel any scheduled emote resets BEFORE emitting death event
      // This prevents race conditions where a scheduled "idle" reset overwrites death animation
      const combatSystem = this.world.getSystem?.("combat") as {
        animationManager?: { cancelEmoteReset?: (entityId: string) => void };
      } | null;
      if (combatSystem?.animationManager?.cancelEmoteReset) {
        combatSystem.animationManager.cancelEmoteReset(playerId);
        this.logger.info("Cancelled scheduled emote reset for duel death", {
          playerId,
        });
      }

      // Still emit death state and play animation for duel deaths
      // DuelSystem handles stakes/respawn, but we need the visual feedback
      // CRITICAL: Include deathPosition so clients can properly position the death animation
      this.emitTypedEvent(EventType.PLAYER_SET_DEAD, {
        playerId,
        isDead: true,
        deathPosition: deathPosition
          ? [deathPosition.x, deathPosition.y, deathPosition.z]
          : undefined,
      });

      // Set death animation on entity
      if (deadPlayerEntity && "data" in deadPlayerEntity) {
        const typedPlayerEntity = deadPlayerEntity as PlayerEntityLike;
        if (typedPlayerEntity.emote !== undefined) {
          typedPlayerEntity.emote = "death";
        }
        if (typedPlayerEntity.data) {
          typedPlayerEntity.data.e = "death";
          typedPlayerEntity.data.deathState = DeathState.DYING;
          this.logger.info("Set death animation for duel death", {
            playerId,
            emote: typedPlayerEntity.data.e,
          });
        }
        if ("markNetworkDirty" in deadPlayerEntity) {
          (
            deadPlayerEntity as { markNetworkDirty: () => void }
          ).markNetworkDirty();
        }
      } else {
        this.logger.warn("Could not find entity to set death animation", {
          playerId,
        });
      }

      // Competitive persistent duels co-commit kill XP with their lethal hit.
      // Database-free/noncompetitive duels retain the existing transient path.
      if (data.combatProgressCommitted !== true) {
        this.emitCombatKillForPvP(playerId, data.killedBy);
      }

      return;
    }

    // Use the deathPosition already captured at the top of this function
    // (from event data first, then fallbacks)
    let position = deathPosition;

    if (!position) {
      // Fallback 2: Try to get from player system
      const playerSystem = this.world.getSystem?.(
        "player",
      ) as unknown as PlayerSystemLike | null;
      if (playerSystem) {
        const player = playerSystem.players?.get?.(playerId);
        if (player?.position) {
          position = { ...player.position };
        }
      }
    }

    if (!position) {
      // Ultimate fallback: Use spawn location
      this.logger.warn(
        "Could not find position for player, using default spawn",
        {
          playerId,
        },
      );
      position = { x: 0, y: 10, z: 0 };
    }

    try {
      await this.processPlayerDeath(playerId, position, data.killedBy);
    } catch (error) {
      if (isAmbiguousDeathCustodyError(error)) {
        this.logger.error(
          "Death custody remains ambiguous after exact retries; retaining dead-state fence",
          error instanceof Error ? error : undefined,
          { playerId },
        );
        this.emitTypedEvent(EventType.AUDIT_LOG, {
          action: "DEATH_CUSTODY_COMMIT_UNKNOWN",
          playerId,
          actorId: playerId,
          success: false,
          transactionId:
            error instanceof Error
              ? error.message.slice("death_custody_commit_unknown:".length)
              : undefined,
          timestamp: Date.now(),
        });
        return;
      }
      this.logger.error(
        "Death processing failed, resetting to alive",
        error instanceof Error ? error : undefined,
        { playerId },
      );
      // Reset player to alive state so they aren't stuck dead
      const playerEntity = this.world.entities?.get?.(playerId);
      if (playerEntity && "data" in playerEntity) {
        const typedPlayerEntity = playerEntity as PlayerEntityLike;
        if (typedPlayerEntity.data) {
          typedPlayerEntity.data.deathState = DeathState.ALIVE;
          typedPlayerEntity.data.deathPosition = undefined;
          typedPlayerEntity.data.respawnTick = undefined;
        }
        if ("setHealth" in playerEntity && "getMaxHealth" in playerEntity) {
          const maxHealth =
            (playerEntity as PlayerEntityLike).getMaxHealth?.() ?? 100;
          (playerEntity as PlayerEntityLike).setHealth?.(maxHealth);
        }
        if ("markNetworkDirty" in playerEntity) {
          (playerEntity as { markNetworkDirty: () => void }).markNetworkDirty();
        }
      }
      this.emitTypedEvent(EventType.PLAYER_SET_DEAD, {
        playerId,
        isDead: false,
      });
      // Emit PLAYER_RESPAWNED so PlayerSystem restores player.alive and health.
      // Uses deathPosition (not spawn town) intentionally — on tx failure we revive
      // the player in-place rather than teleporting them, which is less disruptive.
      this.emitTypedEvent(EventType.PLAYER_RESPAWNED, {
        playerId,
        spawnPosition: deathPosition,
      });
      this.lastDeathTime.delete(playerId);
    }
  }

  private async processPlayerDeath(
    playerId: string,
    deathPosition: { x: number; y: number; z: number },
    killedByRaw: string,
  ): Promise<void> {
    // Guard: mark player as processing to prevent respawn race.
    // NOTE: This method intentionally does NOT catch errors — they propagate to
    // handlePlayerDeath's catch block which resets the player to alive state.
    this.deathProcessingInProgress.add(playerId);
    try {
      await this._processPlayerDeathInner(playerId, deathPosition, killedByRaw);
    } finally {
      this.deathProcessingInProgress.delete(playerId);
    }
  }

  private async commitDeathCustodyWithExactRetry<T>(
    operationId: string,
    commit: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        return await commit();
      } catch (error) {
        if (isDefinitiveDeathCustodyError(error)) throw error;
        lastError = error;
        if (attempt < 8) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 5_000));
          });
        }
      }
    }
    const unknown = new Error(`death_custody_commit_unknown:${operationId}`, {
      cause: lastError,
    });
    throw unknown;
  }

  private async _processPlayerDeathInner(
    playerId: string,
    deathPosition: { x: number; y: number; z: number },
    killedByRaw: string,
  ): Promise<void> {
    // Sanitize killedBy input to prevent injection attacks
    const killedBy = sanitizeKilledBy(killedByRaw);
    // Server-only - prevent client from triggering death events
    if (!this.world.isServer) {
      this.logger.warn(
        "Client attempted server-only death processing — blocked",
        {
          playerId,
        },
      );
      return;
    }

    // Validate death position using extracted helper
    let validatedPosition = validatePosition(deathPosition);

    if (!validatedPosition) {
      this.logger.error(
        "Invalid death position, using player entity position",
        undefined,
        {
          playerId,
          position: {
            x: deathPosition.x,
            y: deathPosition.y,
            z: deathPosition.z,
          },
        },
      );
      // Try to get player's actual position as fallback
      const playerEntity = this.world.entities.get(playerId);
      if (playerEntity?.position) {
        validatedPosition = validatePosition(playerEntity.position);
      }
      if (!validatedPosition) {
        this.logger.warn(
          "All position fallbacks exhausted, dropping death event",
          {
            playerId,
          },
        );
        return;
      }
    }

    // Check bounds and log warning if clamped
    if (!isPositionInBounds(deathPosition)) {
      this.logger.warn("Death position out of bounds, clamped", {
        playerId,
        position: {
          x: deathPosition.x,
          y: deathPosition.y,
          z: deathPosition.z,
        },
      });
    }

    // Use validated position from here on
    deathPosition = validatedPosition;

    // Cache Date.now() to avoid multiple system calls
    const now = Date.now();

    const lastDeath = this.lastDeathTime.get(playerId) || 0;
    if (now - lastDeath < this.DEATH_COOLDOWN) {
      this.logger.debug("Death ignored — within cooldown window", {
        playerId,
        elapsed: now - lastDeath,
      });
      return;
    }

    // Update last death time (use cached timestamp)
    this.lastDeathTime.set(playerId, now);

    // Death state (deathState = DYING) is already set by PlayerSystem.handleDeath
    // which fires before this method. No need to set it again here.
    const playerEntity = this.world.entities?.get?.(playerId);
    // Duel arena deaths should not generate gravestones, ground items, or other loot clutter.
    // Keep normal death animation + respawn timing, but preserve inventory/equipment.
    const inDuelArenaZone = isPositionInsideDuelArenaZone(
      deathPosition.x,
      deathPosition.z,
    );
    if (inDuelArenaZone) {
      this.postDeathCleanup(playerId, deathPosition, [], killedBy);
      return;
    }

    // Resolve preparation custody before any optional-system fallback. Ordinary
    // offline play may preserve in-memory items when persistence is absent, but
    // a preparation area explicitly promises atomic private-grave custody. It
    // must never silently degrade into no-loss respawn or the wilderness path.
    const zoneType = this.zoneDetection.getZoneType(deathPosition);
    let usesProtectedCustody = zoneType === ZoneType.SAFE_AREA;
    let isPreparationCustody = false;
    if (!usesProtectedCustody) {
      const zoneProperties = this.zoneDetection.getZoneProperties?.({
        x: deathPosition.x,
        z: deathPosition.z,
      });
      const area = zoneProperties?.id
        ? ALL_WORLD_AREAS[zoneProperties.id]
        : undefined;
      if (area?.agentPreparationArea === true) {
        requirePreparationDeathCustodyPolicy(area);
        usesProtectedCustody = true;
        isPreparationCustody = true;
      }
    }

    // Real-value operation must never convert an unknown, wilderness, or PvP
    // classification into an implicit public item drop. Reject before looking
    // up the database/inventory/equipment systems and before any custody,
    // ground-item, death-lock, or live inventory mutation can occur.
    if (isExternalValueEnabled() && !usesProtectedCustody) {
      throw new Error(
        `external_value_death_custody_unapproved:${String(zoneType)}`,
      );
    }

    // PLAYER_SET_DEAD is emitted once in postDeathCleanup after the transaction
    // succeeds. The deathState = DYING set above blocks loot during the transaction.

    // Get database system for transaction support
    const databaseSystem = this.world.getSystem(
      "database",
    ) as unknown as DatabaseSystemLike | null;
    if (!databaseSystem || !databaseSystem.executeInTransaction) {
      if (isPreparationCustody) {
        throw new Error("preparation_death_custody_database_unavailable");
      }
      // No DB: death animation + respawn only, no item drops. Items stay in memory
      // (player keeps them). This is safe because without DB, nothing to desync.
      this.postDeathCleanup(playerId, deathPosition, [], killedBy);
      return;
    }

    // Get inventory system
    const inventorySystem = this.world.getSystem<InventorySystem>("inventory");
    if (!inventorySystem) {
      if (isPreparationCustody) {
        throw new Error("preparation_death_custody_inventory_unavailable");
      }
      // No inventory system: same as no-DB — respawn without item drops.
      this.postDeathCleanup(playerId, deathPosition, [], killedBy);
      return;
    }

    // Get equipment system
    const equipmentSystem = this.world.getSystem(
      "equipment",
    ) as unknown as EquipmentSystemLike | null;

    if (
      isPreparationCustody &&
      !databaseSystem.commitSafeAreaDeathOperationAsync
    ) {
      throw new Error("preparation_death_custody_commit_unavailable");
    }
    const existingDeathLock =
      await this.deathStateManager.getDeathLock(playerId);

    if (
      usesProtectedCustody &&
      databaseSystem.commitSafeAreaDeathOperationAsync
    ) {
      // A second death must never destroy unresolved custody from the first.
      // Agents are expected to recover their own grave before resuming combat.
      if (existingDeathLock) {
        throw new Error("safe_death_active_lock_exists");
      }
      if (equipmentSystem && !equipmentSystem.reloadFromDatabase) {
        throw new Error("safe_death_equipment_reload_unavailable");
      }
      if (!inventorySystem.reloadFromDatabase) {
        throw new Error("safe_death_inventory_reload_unavailable");
      }

      const operationId = `safe-death:${generateTransactionId()}`;
      const deathRequest = {
        operationId,
        playerId,
        deathTimestamp: now,
        position: deathPosition,
        killedBy,
      };
      const receipt = await this.commitDeathCustodyWithExactRetry(
        operationId,
        () => databaseSystem.commitSafeAreaDeathOperationAsync!(deathRequest),
      );
      const toInventoryItems = (
        prefix: string,
        items: Array<{ itemId: string; quantity: number }>,
      ): InventoryItem[] =>
        items.map((item, index) => ({
          id: `${prefix}_${receipt.operationId}_${index}`,
          itemId: item.itemId,
          quantity: item.quantity,
          slot: -1,
          metadata: null,
        }));
      const itemsToDrop = toInventoryItems("death", receipt.dropped);
      const itemsKept = toInventoryItems("kept", receipt.kept);

      // Database custody is already committed. Strictly replace live state from
      // that snapshot rather than performing a second write. A transient reload
      // failure is safe while the player remains dead: respawn retries both
      // authoritative reloads before making the player alive.
      let liveMirrorFailed = false;
      try {
        await equipmentSystem?.reloadFromDatabase?.(playerId);
      } catch (error) {
        liveMirrorFailed = true;
        this.logger.error(
          "Safe death equipment reload failed; retaining dead-state fence",
          error instanceof Error ? error : undefined,
          { playerId, operationId: receipt.operationId },
        );
      }
      try {
        await inventorySystem.reloadFromDatabase(playerId);
      } catch (error) {
        liveMirrorFailed = true;
        this.logger.error(
          "Safe death inventory reload failed; retaining dead-state fence",
          error instanceof Error ? error : undefined,
          { playerId, operationId: receipt.operationId },
        );
      }
      try {
        await this.deathStateManager.refreshDeathLock(playerId);
      } catch (error) {
        liveMirrorFailed = true;
        this.logger.error(
          "Safe death lock refresh failed; durable custody remains authoritative",
          error instanceof Error ? error : undefined,
          { playerId, operationId: receipt.operationId },
        );
      }

      if (liveMirrorFailed) {
        this.emitTypedEvent(EventType.AUDIT_LOG, {
          action: "SAFE_DEATH_LIVE_RELOAD_DEFERRED",
          playerId,
          actorId: playerId,
          success: false,
          transactionId: receipt.operationId,
          timestamp: Date.now(),
        });
      }

      if (itemsToDrop.length > 0) {
        this.pendingGravestones.set(playerId, {
          position: deathPosition,
          items: itemsToDrop,
          killedBy,
          zoneType: ZoneType.SAFE_AREA,
        });
      }
      this.postDeathCleanup(
        playerId,
        deathPosition,
        itemsToDrop,
        killedBy,
        itemsKept,
      );
      return;
    }

    if (
      (zoneType === ZoneType.WILDERNESS || zoneType === ZoneType.PVP_ZONE) &&
      databaseSystem.commitGroundItemDeathOperationAsync
    ) {
      if (existingDeathLock) {
        throw new Error("ground_item_death_active_lock_exists");
      }
      if (!inventorySystem.reloadFromDatabase) {
        throw new Error("ground_item_death_inventory_reload_unavailable");
      }
      if (equipmentSystem && !equipmentSystem.reloadFromDatabase) {
        throw new Error("ground_item_death_equipment_reload_unavailable");
      }

      const inventory = inventorySystem.getInventory(playerId);
      const inventoryItems =
        inventory?.items.map((item, index) => ({
          id: `death_inventory_${playerId}_${index}`,
          itemId: item.itemId,
          quantity: item.quantity,
          slot: item.slot,
          metadata: null,
        })) ?? [];
      const equipment = equipmentSystem?.getPlayerEquipment(playerId);
      const equipmentItems = equipment
        ? Object.values(equipment).flatMap((entry, index) => {
            const itemId = entry?.item?.id;
            if (!itemId) return [];
            return [
              {
                id: `death_equipment_${playerId}_${index}`,
                itemId,
                quantity: entry.item?.quantity ?? 1,
                slot: -1,
                metadata: null,
              } satisfies InventoryItem,
            ];
          })
        : [];
      const plannedItems = [...inventoryItems, ...equipmentItems];
      const sourceRequests =
        await this.groundItemSystem.prepareDurableSourceBatchRegistration(
          plannedItems,
          deathPosition,
          {
            despawnTime: ticksToMs(COMBAT_CONSTANTS.GROUND_ITEM_DESPAWN_TICKS),
            droppedBy: playerId,
            lootProtection: ticksToMs(COMBAT_CONSTANTS.LOOT_PROTECTION_TICKS),
            scatter: true,
            scatterRadius: 3,
          },
        );
      if (!sourceRequests) {
        throw new Error("ground_item_death_source_plan_unavailable");
      }

      const operationId = generateGroundItemDeathOperationId();
      const fingerprintInput: Omit<
        GroundItemDeathCommitRequest,
        "requestFingerprint"
      > = {
        operationId,
        playerId,
        deathTimestamp: now,
        position: deathPosition,
        killedBy,
        zoneType,
        sources: sourceRequests,
      };
      const request: GroundItemDeathCommitRequest = {
        ...fingerprintInput,
        requestFingerprint: await sha256Hex(
          serializeGroundItemDeathCommitFingerprint(fingerprintInput),
        ),
      };
      const receipt: GroundItemDeathCommitReceipt =
        await this.commitDeathCustodyWithExactRetry(operationId, () =>
          databaseSystem.commitGroundItemDeathOperationAsync!(request),
        );
      const itemsToDrop = receipt.dropped.map((item, index) => ({
        id: `death_${receipt.operationId}_${index}`,
        itemId: item.itemId,
        quantity: item.quantity,
        slot: -1,
        metadata: null,
      }));

      let liveMirrorFailed = false;
      try {
        await equipmentSystem?.reloadFromDatabase?.(playerId);
      } catch (error) {
        liveMirrorFailed = true;
        this.logger.error(
          "Public death equipment reload failed; retaining dead-state fence",
          error instanceof Error ? error : undefined,
          { playerId, operationId },
        );
      }
      try {
        await inventorySystem.reloadFromDatabase(playerId);
      } catch (error) {
        liveMirrorFailed = true;
        this.logger.error(
          "Public death inventory reload failed; retaining dead-state fence",
          error instanceof Error ? error : undefined,
          { playerId, operationId },
        );
      }
      try {
        await this.deathStateManager.refreshDeathLock(playerId);
      } catch (error) {
        liveMirrorFailed = true;
        this.logger.error(
          "Public death lock refresh failed; durable custody remains authoritative",
          error instanceof Error ? error : undefined,
          { playerId, operationId },
        );
      }

      const finalSources = new Map<
        string,
        GroundItemDeathCommitReceipt["sources"][number]
      >();
      for (const source of receipt.sources) {
        const current = finalSources.get(source.sourceId);
        if (!current || source.version > current.version) {
          finalSources.set(source.sourceId, source);
        }
      }
      for (const source of finalSources.values()) {
        try {
          const exposed =
            await this.groundItemSystem.exposeCommittedDurableSource(source);
          if (!exposed) {
            liveMirrorFailed = true;
            this.logger.warn(
              "Public death source presentation deferred; durable custody remains authoritative",
              { playerId, operationId, sourceId: source.sourceId },
            );
          }
        } catch (error) {
          liveMirrorFailed = true;
          this.logger.error(
            "Public death source presentation deferred; durable custody remains authoritative",
            error instanceof Error ? error : undefined,
            { playerId, operationId, sourceId: source.sourceId },
          );
        }
      }
      if (liveMirrorFailed) {
        this.emitTypedEvent(EventType.AUDIT_LOG, {
          action: "GROUND_DEATH_LIVE_RELOAD_DEFERRED",
          playerId,
          actorId: playerId,
          success: false,
          transactionId: operationId,
          timestamp: Date.now(),
        });
      }

      this.postDeathCleanup(playerId, deathPosition, itemsToDrop, killedBy);
      return;
    }

    // Legacy/wilderness path only. Safe-area production custody above rejects a
    // second death rather than deleting unresolved items.
    if (existingDeathLock) {
      await this.deathStateManager.clearDeathLock(playerId);
    }

    let itemsToDrop: InventoryItem[] = [];
    let itemsKept: InventoryItem[] = [];

    await databaseSystem.executeInTransaction(
      async (tx: TransactionContext) => {
        const inventory = inventorySystem.getInventory(playerId);
        if (!inventory) {
          this.logger.info("No inventory data for dying player", { playerId });
        }

        const inventoryItems =
          inventory?.items.map((item, index) => ({
            id: `death_${playerId}_${Date.now()}_${index}`,
            itemId: item.itemId,
            quantity: item.quantity,
            slot: item.slot,
            metadata: null,
          })) || [];

        // clearEquipmentAndReturn is always available on EquipmentSystem — the old
        // fallback to getPlayerEquipment + manual conversion only covered 6/11 slots
        // and was removed as dead code. If equipment system exists but lacks this
        // method, equipped items are intentionally ignored (no partial drop).
        let equipmentItems: InventoryItem[] = [];
        if (equipmentSystem?.clearEquipmentAndReturn) {
          const clearedEquipment =
            await equipmentSystem.clearEquipmentAndReturn(playerId, tx);
          equipmentItems = clearedEquipment.map((item, index) => ({
            id: `death_equip_${playerId}_${Date.now()}_${index}`,
            itemId: item.itemId,
            quantity: item.quantity,
            slot: -1,
            metadata: null,
          }));
        }

        const allItems = [...inventoryItems, ...equipmentItems];
        // classic MMORPG-style: In safe zones, keep 3 most valuable items
        if (zoneType === ZoneType.SAFE_AREA) {
          const split = splitItemsForSafeDeath(allItems, ITEMS_KEPT_ON_DEATH);
          itemsToDrop = split.dropped;
          itemsKept = split.kept;

          this.pendingGravestones.set(playerId, {
            position: deathPosition,
            items: itemsToDrop,
            killedBy,
            zoneType,
          });

          await this.deathStateManager.createDeathLock(
            playerId,
            {
              gravestoneId: "",
              position: deathPosition,
              zoneType: ZoneType.SAFE_AREA,
              itemCount: itemsToDrop.length,
              items: itemsToDrop.map((item) => ({
                itemId: item.itemId,
                quantity: item.quantity,
              })),
              keptItems: itemsKept.map((item) => ({
                itemId: item.itemId,
                quantity: item.quantity,
              })),
              killedBy,
            },
            tx,
          );
        } else {
          // Wilderness: drop everything
          itemsToDrop = allItems;
          itemsKept = [];
          await this.wildernessHandler.handleDeath(
            playerId,
            deathPosition,
            itemsToDrop,
            killedBy,
            zoneType,
            tx,
          );
        }

        // Clear all inventory in memory (kept items will be re-added after respawn)
        // skipPersist=true: we're inside a DB transaction — independent persist
        // would open a nested transaction that deadlocks on SQLite.
        await inventorySystem.clearInventoryImmediate(playerId, true);
      },
    );

    // Below: persist the in-memory clears to DB. These calls are idempotent —
    // clearing an already-empty inventory/equipment is a no-op write. The
    // deathProcessingInProgress guard prevents item pickups during this window.
    //
    // CRASH RECOVERY: If the server crashes between the transaction commit above
    // and the persist calls below, the death lock exists in DB but equipment/
    // inventory rows may still contain the old items. Recovery path:
    //   1. On server restart, DeathStateManager.recoverUnrecoveredDeaths() finds
    //      the death lock and emits DEATH_RECOVERED.
    //   2. onPlayerReconnect() checks for an active death lock and blocks inventory
    //      load from DB, so old items are never restored to the player.
    //   3. The retry queue (pendingPersistRetries) handles transient failures during
    //      normal operation. If it also fails, AUDIT_LOG is emitted for ops alerting.

    // TWO-PHASE CLEAR: clearEquipmentAndReturn (inside tx) cleared in-memory state
    // and returned the items. clearEquipmentImmediate (below) persists the empty state
    // to DB. The tx couldn't persist because EquipmentSystem's save opens its own
    // transaction, which would deadlock on SQLite. If the persist below fails, the
    // retry queue handles it. On reconnect, onPlayerReconnect checks for death locks
    // and blocks inventory load, so even a DB desync won't give items back.
    if (equipmentSystem?.clearEquipmentImmediate) {
      try {
        await equipmentSystem.clearEquipmentImmediate(playerId);
      } catch (err) {
        this.logger.error(
          "DEATH_PERSIST_DESYNC: Equipment DB persist failed, queuing retry",
          err instanceof Error ? err : undefined,
          { playerId },
        );
        this.queuePersistRetry(playerId, "equipment");
      }
    }

    // Same two-phase pattern: in-memory clear happened inside tx (skipPersist=true),
    // now persist the empty inventory to DB. Death lock prevents reconnect item restore.
    try {
      await inventorySystem.clearInventoryImmediate(playerId, false);
    } catch (err) {
      this.logger.error(
        "DEATH_PERSIST_DESYNC: Inventory DB persist failed, queuing retry",
        err instanceof Error ? err : undefined,
        { playerId },
      );
      this.queuePersistRetry(playerId, "inventory");
    }

    this.postDeathCleanup(
      playerId,
      deathPosition,
      itemsToDrop,
      killedBy,
      itemsKept,
    );
  }

  private postDeathCleanup(
    playerId: string,
    deathPosition: { x: number; y: number; z: number },
    itemsToDrop: InventoryItem[],
    killedBy: string,
    keptItems?: InventoryItem[],
  ): void {
    // Store items to return on respawn (classic MMORPG keep-3)
    if (keptItems && keptItems.length > 0) {
      this.itemsKeptOnDeath.set(playerId, keptItems);
    }

    const deathData: DeathLocationData = {
      playerId,
      deathPosition,
      timestamp: Date.now(),
      items: itemsToDrop,
    };
    this.deathLocations.set(playerId, deathData);

    // PVP XP: Emit COMBAT_KILL event if killed by another player
    // This allows SkillsSystem to award XP for PvP kills
    // Pass killedBy directly since CombatSystem clears attacker states on ENTITY_DEATH
    // before PlayerDeathSystem runs, making stateService queries unreliable
    this.emitCombatKillForPvP(playerId, killedBy);

    // NOTE: PLAYER_SET_DEAD(isDead: true) is already emitted by PlayerSystem.handleDeath
    // (immediate client feedback). Do NOT emit it again here to avoid duplicate packets.

    // Emit death screen so the client shows the death overlay
    this.emitTypedEvent(EventType.UI_DEATH_SCREEN, {
      playerId,
      message: `Oh dear, you are dead!`,
      killedBy,
      respawnTime: ticksToMs(COMBAT_CONSTANTS.DEATH.ANIMATION_TICKS),
    });

    // Death state, emote, and deathPosition are already set by PlayerSystem.handleDeath.
    // Only set the respawnTick here (requires tick system, only available on server).
    const playerEntity = this.world.entities?.get?.(playerId);
    if (playerEntity && "data" in playerEntity) {
      const typedPlayerEntity = playerEntity as PlayerEntityLike;
      if (typedPlayerEntity.data) {
        // Calculate respawn tick using tick system
        // Use safe addition to prevent integer overflow
        const currentTick = this.tickSystem?.getCurrentTick() ?? 0;
        const animationTicks = COMBAT_CONSTANTS.DEATH.ANIMATION_TICKS;
        // Cap at 32-bit max to prevent overflow during serialization (MessagePack, etc.)
        const MAX_TICK = 2147483647; // 2^31-1, safe for 32-bit serialization
        const MAX_SAFE_TICK = MAX_TICK - animationTicks;
        typedPlayerEntity.data.respawnTick =
          currentTick > MAX_SAFE_TICK ? MAX_TICK : currentTick + animationTicks;
      }

      if ("markNetworkDirty" in playerEntity) {
        (playerEntity as { markNetworkDirty: () => void }).markNetworkDirty();
      }
    } else {
      this.logger.warn(
        "postDeathCleanup: no playerEntity found for respawnTick",
        {
          playerId,
          entityExists: !!playerEntity,
        },
      );
    }

    // Fallback: Use setTimeout if tick system is not available (e.g., client-side)
    // This maintains backward compatibility while preferring tick-based timing
    if (!this.tickSystem) {
      const DEATH_ANIMATION_DURATION = ticksToMs(
        COMBAT_CONSTANTS.DEATH.ANIMATION_TICKS,
      );
      const respawnTimer = setTimeout(() => {
        if (playerEntity && "data" in playerEntity) {
          const entityData = playerEntity.data as {
            e?: string;
            visible?: boolean;
          };
          entityData.visible = false;
          if ("markNetworkDirty" in playerEntity) {
            (
              playerEntity as { markNetworkDirty: () => void }
            ).markNetworkDirty();
          }
        }

        void this.requestPlayerRespawn(playerId);
      }, DEATH_ANIMATION_DURATION);

      this.respawnTimers.set(playerId, respawnTimer);
    }
    // Note: If tickSystem is available, respawn is handled by processPendingRespawns()
  }

  /**
   * Emit COMBAT_KILL event for PvP kills so SkillsSystem can award XP.
   *
   * Uses killedBy from the ENTITY_DEATH event as the primary attacker source.
   * CombatSystem handles ENTITY_DEATH before PlayerDeathSystem and clears all
   * attacker states via clearStatesTargeting(), so the stateService query is
   * used only as a fallback for multi-attacker scenarios.
   */
  private emitCombatKillForPvP(deadPlayerId: string, killedBy?: string): void {
    // Collect unique player attacker IDs
    const playerAttackerIds = new Set<string>();

    // Primary: use killedBy from the death event (always available, not cleared)
    if (killedBy && this.world.entities?.players?.has(killedBy)) {
      playerAttackerIds.add(killedBy);
    }

    // Secondary: try stateService for any additional attackers (may be empty
    // if CombatSystem already cleared states, which is the common case)
    const combatSystem = this.world.getSystem("combat") as {
      stateService?: {
        getAttackersTargeting: (
          entityId: string,
        ) => Array<{ toString: () => string }>;
        getCombatData: (entityId: string) => {
          attackerType: "player" | "mob";
        } | null;
      };
    } | null;

    if (combatSystem?.stateService) {
      const attackers =
        combatSystem.stateService.getAttackersTargeting(deadPlayerId);
      for (const attackerId of attackers) {
        const attackerIdStr = attackerId.toString();
        const combatData =
          combatSystem.stateService.getCombatData(attackerIdStr);
        if (combatData?.attackerType === "player") {
          playerAttackerIds.add(attackerIdStr);
        }
      }
    }

    if (playerAttackerIds.size === 0) {
      return;
    }

    // Get dead player's max health for damage calculation (same approach as MobEntity)
    const deadPlayerEntity = this.world.entities?.get?.(deadPlayerId);
    let maxHealth = 10; // Default fallback
    if (deadPlayerEntity && "getMaxHealth" in deadPlayerEntity) {
      maxHealth =
        (deadPlayerEntity as { getMaxHealth: () => number }).getMaxHealth() ||
        10;
    }

    // Get systems for weapon-type-aware attack style detection (same approach as MobEntity)
    const playerSystem = this.world.getSystem("player") as {
      getPlayerAttackStyle?: (playerId: string) => { id: string } | null;
    } | null;
    const equipmentSystem = this.world.getSystem("equipment") as {
      getPlayerEquipment?: (playerId: string) => {
        weapon?: { item?: { weaponType?: string; attackType?: string } };
      } | null;
    } | null;

    const meleeStyles = new Set([
      "accurate",
      "aggressive",
      "defensive",
      "controlled",
    ]);

    // Emit COMBAT_KILL for each player attacker (award XP to all who contributed)
    for (const attackerIdStr of playerAttackerIds) {
      // Detect attack style from equipped weapon type (not just UI selection)
      // This matches MobEntity logic — a bow should always grant Ranged XP
      const equipment = equipmentSystem?.getPlayerEquipment?.(attackerIdStr);
      const weapon = equipment?.weapon?.item;
      let attackStyle = "aggressive";

      const attackerEntity = this.world.getPlayer?.(attackerIdStr);
      const selectedSpell = (attackerEntity?.data as { selectedSpell?: string })
        ?.selectedSpell;

      if (weapon) {
        const attackType = weapon.attackType?.toLowerCase();
        const weaponType = weapon.weaponType?.toLowerCase();

        if (
          attackType === "ranged" ||
          weaponType === "bow" ||
          weaponType === "crossbow"
        ) {
          attackStyle = "ranged";
        } else if (
          (attackType === "magic" ||
            weaponType === "staff" ||
            weaponType === "wand") &&
          selectedSpell
        ) {
          attackStyle = "magic";
        } else {
          const styleData = playerSystem?.getPlayerAttackStyle?.(attackerIdStr);
          const playerStyle = styleData?.id;
          attackStyle =
            playerStyle && meleeStyles.has(playerStyle)
              ? playerStyle
              : "aggressive";
        }
      } else if (selectedSpell) {
        attackStyle = "magic";
      } else {
        const styleData = playerSystem?.getPlayerAttackStyle?.(attackerIdStr);
        const playerStyle = styleData?.id;
        attackStyle =
          playerStyle && meleeStyles.has(playerStyle)
            ? playerStyle
            : "aggressive";
      }

      // Emit COMBAT_KILL event - SkillsSystem will handle XP distribution
      this.emitTypedEvent(EventType.COMBAT_KILL, {
        attackerId: attackerIdStr,
        targetId: deadPlayerId,
        damageDealt: maxHealth,
        attackStyle: attackStyle,
      });
    }
  }

  private async initiateRespawn(playerId: string): Promise<boolean> {
    this.respawnTimers.delete(playerId);

    // Defense-in-depth: block respawn during active duel
    const duelSystem = this.world.getSystem?.("duel") as {
      isPlayerInActiveDuel?: (playerId: string) => boolean;
    } | null;
    if (duelSystem?.isPlayerInActiveDuel?.(playerId)) {
      this.logger.warn("Blocked initiateRespawn during active duel", {
        playerId,
      });
      return false;
    }

    this.logger.info("initiateRespawn called", { playerId });

    const deathData = this.deathLocations.get(playerId);
    if (!deathData) {
      this.logger.info(
        "No death data in deathLocations, checking pendingGravestones",
        {
          playerId,
        },
      );
    }

    // Get spawn position from manifest starter town (Central Haven at origin)
    const centralHaven = STARTER_TOWNS["central_haven"];
    const spawnPosition = centralHaven
      ? {
          x: (centralHaven.bounds.minX + centralHaven.bounds.maxX) / 2,
          y: 0,
          z: (centralHaven.bounds.minZ + centralHaven.bounds.maxZ) / 2,
        }
      : COMBAT_CONSTANTS.DEATH.DEFAULT_RESPAWN_POSITION;
    const spawnTownName =
      centralHaven?.name ?? COMBAT_CONSTANTS.DEATH.DEFAULT_RESPAWN_TOWN;

    const gravestoneData = this.pendingGravestones.get(playerId);
    if (gravestoneData && gravestoneData.items.length > 0) {
      this.logger.info("Spawning gravestone", {
        playerId,
        itemCount: gravestoneData.items.length,
        position: {
          x: gravestoneData.position.x,
          y: gravestoneData.position.y,
          z: gravestoneData.position.z,
        },
      });
      const gravestoneId = await this.safeAreaHandler.spawnAndTrackGravestone(
        playerId,
        gravestoneData.position,
        gravestoneData.items,
        gravestoneData.killedBy,
      );
      if (!gravestoneId) {
        throw new Error("safe_death_gravestone_spawn_failed");
      }
      try {
        await this.deathStateManager.updateGravestoneId(playerId, gravestoneId);
      } catch (error) {
        this.safeAreaHandler.cancelGravestoneTimer(gravestoneId);
        const entityManager = this.world.getSystem(
          "entity-manager",
        ) as EntityManager | null;
        entityManager?.destroyEntity(gravestoneId);
        throw error;
      }
      this.pendingGravestones.delete(playerId);
    } else {
      this.logger.info("No pending gravestone data", { playerId });
    }

    // Kept-item return and player revival happen only after any dropped-item
    // gravestone has a durable, exact identity.
    await this.respawnPlayer(playerId, spawnPosition, spawnTownName);
    return true;
  }

  private async respawnPlayer(
    playerId: string,
    spawnPosition: { x: number; y: number; z: number },
    townName: string,
  ): Promise<void> {
    const deathLock = await this.deathStateManager?.getDeathLock(playerId);
    let atomicKeptReturnCommitted = false;
    if (deathLock?.deathOperationId) {
      const databaseSystem = this.world.getSystem(
        "database",
      ) as unknown as DatabaseSystemLike | null;
      const inventorySystem = this.world.getSystem(
        "inventory",
      ) as InventorySystem | null;
      const equipmentSystem = this.world.getSystem(
        "equipment",
      ) as unknown as EquipmentSystemLike | null;
      if (
        !databaseSystem?.commitSafeAreaDeathKeptReturnAsync ||
        !inventorySystem?.reloadFromDatabase ||
        (equipmentSystem !== null && !equipmentSystem.reloadFromDatabase)
      ) {
        throw new Error("safe_death_kept_return_unavailable");
      }

      // Return conserved items before making the player alive. A crash or
      // database rejection leaves the player dead and safely retryable.
      await databaseSystem.commitSafeAreaDeathKeptReturnAsync({
        playerId,
        deathOperationId: deathLock.deathOperationId,
      });
      await inventorySystem.reloadFromDatabase(playerId);
      await equipmentSystem?.reloadFromDatabase?.(playerId);
      await this.deathStateManager.refreshDeathLock(playerId);
      this.itemsKeptOnDeath.delete(playerId);
      atomicKeptReturnCommitted = true;
    }

    const playerEntity = this.world.entities?.get?.(playerId);
    if (playerEntity) {
      if ("setHealth" in playerEntity && "getMaxHealth" in playerEntity) {
        const typedEntity = playerEntity as PlayerEntityLike;
        const maxHealth = typedEntity.getMaxHealth?.() ?? 100;
        typedEntity.setHealth?.(maxHealth);
      }

      if ("data" in playerEntity) {
        const typedPlayerEntity = playerEntity as PlayerEntityLike;
        const entityData = typedPlayerEntity.data!;

        entityData.e = "idle";
        entityData.visible = true;

        // AAA QUALITY: Clear death state (single source of truth)
        entityData.deathState = DeathState.ALIVE;
        entityData.deathPosition = undefined;
        entityData.respawnTick = undefined;

        if ("markNetworkDirty" in playerEntity) {
          (playerEntity as { markNetworkDirty: () => void }).markNetworkDirty();
        }
      }
    }

    // Ground to terrain (use same logic as initial player spawn)
    const terrainSystem = this.world.getSystem(
      "terrain",
    ) as unknown as TerrainSystemLike | null;
    let groundedY = spawnPosition.y;

    if (terrainSystem && terrainSystem.isReady && terrainSystem.isReady()) {
      // Get terrain height at respawn position
      const terrainHeight = terrainSystem.getHeightAt(
        spawnPosition.x,
        spawnPosition.z,
      );
      if (Number.isFinite(terrainHeight)) {
        // Player feet at ground level (no offset)
        groundedY = terrainHeight;
      } else {
        groundedY = 10; // Fallback safe height
      }
    } else {
      // Terrain not ready; use safe height
      groundedY = 10;
    }

    const groundedPosition = {
      x: spawnPosition.x,
      y: groundedY,
      z: spawnPosition.z,
    };

    if (playerEntity) {
      if ("node" in playerEntity && playerEntity.node) {
        const typedEntity = playerEntity as PlayerEntityLike;
        typedEntity.node?.position.set(
          groundedPosition.x,
          groundedPosition.y,
          groundedPosition.z,
        );
      }

      if ("data" in playerEntity) {
        const entityData = playerEntity.data as {
          position?: number[];
        };

        if (Array.isArray(entityData.position)) {
          entityData.position[0] = groundedPosition.x;
          entityData.position[1] = groundedPosition.y;
          entityData.position[2] = groundedPosition.z;
        }

        if ("markNetworkDirty" in playerEntity) {
          (playerEntity as { markNetworkDirty: () => void }).markNetworkDirty();
        }
      }

      if ("position" in playerEntity && playerEntity.position) {
        const pos = playerEntity.position as {
          x: number;
          y: number;
          z: number;
        };
        pos.x = groundedPosition.x;
        pos.y = groundedPosition.y;
        pos.z = groundedPosition.z;
      }
    }

    // Send teleport packet to client
    if (this.world.network && "sendTo" in this.world.network) {
      (this.world.network as NetworkLike).sendTo(playerId, "playerTeleport", {
        playerId,
        position: [groundedPosition.x, groundedPosition.y, groundedPosition.z],
      });
    }

    this.emitTypedEvent(EventType.PLAYER_RESPAWNED, {
      playerId,
      spawnPosition: groundedPosition,
      townName,
      deathLocation: this.deathLocations.get(playerId)?.deathPosition,
    });

    this.emitTypedEvent(EventType.PLAYER_SET_DEAD, {
      playerId,
      isDead: false,
    });

    // Close death screen overlay on client
    this.emitTypedEvent(EventType.UI_DEATH_SCREEN_CLOSE, {
      playerId,
    });

    // classic MMORPG-style: Return kept items to inventory after respawn.
    // Prefer in-memory (fast path), fall back to death lock DB (crash recovery).
    let keptItems = atomicKeptReturnCommitted
      ? undefined
      : this.itemsKeptOnDeath.get(playerId);
    if (!atomicKeptReturnCommitted && (!keptItems || keptItems.length === 0)) {
      const legacyDeathLock =
        await this.deathStateManager?.getDeathLock(playerId);
      if (legacyDeathLock?.keptItems && legacyDeathLock.keptItems.length > 0) {
        keptItems = legacyDeathLock.keptItems.map((item) => ({
          id: `kept_${playerId}_${Date.now()}_${item.itemId}`,
          itemId: item.itemId,
          quantity: item.quantity,
          slot: -1,
          metadata: null,
        }));
        this.logger.info(
          "Restored kept items from death lock (crash recovery)",
          {
            playerId,
            count: keptItems.length,
          },
        );
      }
    }
    if (keptItems && keptItems.length > 0) {
      this.itemsKeptOnDeath.delete(playerId);
      const inventorySystem = this.world.getSystem(
        "inventory",
      ) as InventorySystem | null;
      if (inventorySystem) {
        for (const item of keptItems) {
          try {
            await inventorySystem.addItemDirect(playerId, {
              itemId: item.itemId,
              quantity: item.quantity,
            });
          } catch (err) {
            this.logger.error(
              "Failed to return kept item on respawn",
              err instanceof Error ? err : undefined,
              { playerId, itemId: item.itemId },
            );
          }
        }
      }
    }

    const hasGravestone = this.deathLocations.has(playerId);
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId,
      message: hasGravestone
        ? `You have respawned in ${townName}. Your items are at your gravestone where you died.`
        : `You have respawned in ${townName}.`,
      type: "info",
    });

    // NOTE: Do NOT clear death lock here - it must persist for crash recovery!
    // Death lock is cleared when:
    // 1. All items are looted from gravestone (CORPSE_EMPTY event)
    // 2. Ground items despawn (timeout)
    // This ensures that if server crashes before items are looted, they can be recovered.

    // Clear death cooldown so player can die again immediately after respawn
    this.lastDeathTime.delete(playerId);
  }

  /**
   * Request and await the authoritative respawn postcondition.
   *
   * Exact `true` means the complete respawn boundary resolved. Rejected,
   * duplicate, unavailable, or failed work returns `false`; callers must not
   * infer success from event dispatch alone.
   */
  async requestPlayerRespawn(playerId: string): Promise<boolean> {
    if (!playerId || this.respawnInProgress.has(playerId)) {
      return false;
    }

    // SECURITY: Block respawn during active duel — players cannot escape duels via respawn button
    const duelSystem = this.world.getSystem?.("duel") as {
      isPlayerInActiveDuel?: (playerId: string) => boolean;
    } | null;
    if (duelSystem?.isPlayerInActiveDuel?.(playerId)) {
      this.logger.warn("Blocked respawn request during active duel", {
        playerId,
      });
      return false;
    }

    // Block respawn while death transaction is still processing
    if (this.deathProcessingInProgress.has(playerId)) {
      this.logger.info("Blocked respawn request during death processing", {
        playerId,
      });
      return false;
    }

    // PRECONDITION: Player must be in DYING state. This is the single source of truth
    // for whether a player is dead. PlayerSystem.handleDeath always sets deathState = DYING
    // before emitting ENTITY_DEATH, so any legitimately dead player will have this state.
    const playerEntity = this.world.entities?.get?.(playerId);
    const isDying =
      playerEntity &&
      "data" in playerEntity &&
      (playerEntity as PlayerEntityLike).data?.deathState === DeathState.DYING;

    if (!isDying) {
      return false;
    }

    // Clear any legacy setTimeout timer if still active
    const timer = this.respawnTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.respawnTimers.delete(playerId);
    }

    this.respawnInProgress.add(playerId);
    try {
      return await this.initiateRespawn(playerId);
    } catch (err) {
      this.logger.error(
        "Respawn request failed",
        err instanceof Error ? err : undefined,
        { playerId },
      );
      return false;
    } finally {
      this.respawnInProgress.delete(playerId);
    }
  }

  private handleRespawnRequest(data: { playerId: string }): void {
    void this.requestPlayerRespawn(data.playerId);
  }

  private async handlePlayerReconnect(data: {
    playerId: string;
  }): Promise<void> {
    if (!this.world.isServer) {
      return; // Only server validates death state
    }

    await this.onPlayerReconnect(data.playerId);
  }

  /** Validates death state on reconnect - blocks inventory load if death lock exists */
  async onPlayerReconnect(playerId: string): Promise<{
    blockInventoryLoad: boolean;
  }> {
    this.logger.info("onPlayerReconnect called", { playerId });
    const deathLock = await this.deathStateManager.getDeathLock(playerId);

    if (deathLock) {
      this.logger.info("Found death lock for player", {
        playerId,
        itemCount: deathLock.itemCount,
        recoveryItems: deathLock.items?.length || 0,
      });
      // Check if death lock is stale (older than 1 hour)
      // Stale death locks should be cleared, not restored
      const MAX_DEATH_LOCK_AGE = ticksToMs(
        COMBAT_CONSTANTS.DEATH.STALE_LOCK_AGE_TICKS,
      );
      const deathAge = Date.now() - deathLock.timestamp;

      if (deathAge > MAX_DEATH_LOCK_AGE && !deathLock.deathOperationId) {
        await this.deathStateManager.clearDeathLock(playerId);
        return { blockInventoryLoad: false };
      }

      // Convert death lock items to InventoryItem format for gravestone
      const itemsFromDeathLock: InventoryItem[] = (deathLock.items || []).map(
        (item, index) => ({
          id: `recovery_${playerId}_${Date.now()}_${index}`,
          itemId: item.itemId,
          quantity: item.quantity,
          slot: index,
          metadata: null,
        }),
      );

      // Restore death location to memory WITH items from death lock
      this.deathLocations.set(playerId, {
        playerId,
        deathPosition: deathLock.position,
        timestamp: deathLock.timestamp,
        items: itemsFromDeathLock,
      });

      // Restore pendingGravestones so initiateRespawn will spawn the gravestone
      const hasExactRestoredGravestone = this.hasExactOwnedGravestone(
        playerId,
        deathLock.gravestoneId,
      );
      if (hasExactRestoredGravestone) {
        // Startup recovery already restored the exact durable identity. Remove
        // any stale pending request so reconnect cannot create a sibling grave.
        this.pendingGravestones.delete(playerId);
        this.logger.info("Using restored gravestone on reconnect", {
          playerId,
          gravestoneId: deathLock.gravestoneId,
        });
      } else if (itemsFromDeathLock.length > 0) {
        this.pendingGravestones.set(playerId, {
          position: deathLock.position,
          items: itemsFromDeathLock,
          killedBy: deathLock.killedBy || "unknown",
          zoneType: deathLock.zoneType,
        });
        this.logger.info(
          "Restored items from death lock, will spawn gravestone on respawn",
          {
            playerId,
            itemCount: itemsFromDeathLock.length,
          },
        );
      } else {
        this.logger.info("No items to restore, skipping gravestone spawn", {
          playerId,
        });
      }

      // Immediately trigger respawn (classic fantasy MMORPG-style - no waiting, no screen)
      // Very short delay, then auto-respawn (just enough for world to load)
      const reconnectTimer = setTimeout(() => {
        this.respawnTimers.delete(playerId);
        void this.requestPlayerRespawn(playerId);
      }, ticksToMs(COMBAT_CONSTANTS.DEATH.RECONNECT_RESPAWN_DELAY_TICKS));
      this.respawnTimers.set(playerId, reconnectTimer);

      // Block inventory load until respawn.
      // AUDIT: This means a death lock survived a server restart or reconnect.
      // If the post-tx persist never ran (crash window), DB inventory/equipment
      // rows may still contain stale items — blockInventoryLoad prevents them
      // from being restored. Ops can cross-reference this with DB state.
      this.emitTypedEvent(EventType.AUDIT_LOG, {
        action: "DEATH_LOCK_RECONNECT_BLOCK",
        playerId,
        actorId: playerId,
        zoneType: deathLock.zoneType,
        success: true,
        itemCount: deathLock.itemCount,
        deathAge: deathAge,
        timestamp: Date.now(),
      });
      return { blockInventoryLoad: true };
    }

    return { blockInventoryLoad: false };
  }

  /**
   * Handle crash recovery for offline players.
   * Called when DeathStateManager finds unrecovered deaths on server restart
   * where items exist but no gravestone/ground items are in the world.
   * Spawns a new gravestone with the recovered items.
   */
  private hasExactOwnedGravestone(
    playerId: string,
    gravestoneId: string | null | undefined,
  ): boolean {
    if (!gravestoneId) return false;
    const entity = this.world.entities?.get?.(gravestoneId) as
      | {
          getOwnerId?: () => string;
          getLootItems?: () => InventoryItem[];
        }
      | undefined;
    return (
      typeof entity?.getOwnerId === "function" &&
      typeof entity.getLootItems === "function" &&
      entity.getOwnerId() === playerId
    );
  }

  private async restoreDeathCustody(data: DeathRecoveryRequest): Promise<void> {
    if (!this.world.isServer) {
      throw new Error("death_recovery_requires_server_authority");
    }

    // Guard against double-recovery
    if (this.pendingGravestones.has(data.playerId)) {
      this.logger.warn(
        "Skipping death recovery, already has pending gravestone",
        {
          playerId: data.playerId,
        },
      );
      throw new Error("death_recovery_pending_gravestone_conflict");
    }

    if (data.items.length === 0) {
      this.logger.info("No items to recover, skipping", {
        playerId: data.playerId,
      });
      return;
    }

    this.logger.info("Recovering death for offline player", {
      playerId: data.playerId,
      itemCount: data.items.length,
    });

    // Spawn gravestone via SafeAreaDeathHandler (tick-based expiration)
    const gravestoneId = await this.safeAreaHandler.spawnAndTrackGravestone(
      data.playerId,
      data.position,
      data.items,
      data.killedBy,
      {
        deathOperationId: data.deathOperationId,
        exactGravestoneId: data.gravestoneId,
      },
    );
    if (!gravestoneId) {
      throw new Error("death_recovery_gravestone_spawn_failed");
    }

    try {
      if (data.gravestoneId !== gravestoneId) {
        await this.deathStateManager.updateGravestoneId(
          data.playerId,
          gravestoneId,
        );
      }
    } catch (error) {
      this.safeAreaHandler.cancelGravestoneTimer(gravestoneId);
      const entityManager = this.world.getSystem(
        "entity-manager",
      ) as EntityManager | null;
      entityManager?.destroyEntity(gravestoneId);
      throw error;
    }
  }

  private handleLootCollection(data: { playerId: string }): void {
    const deathData = this.deathLocations.get(data.playerId);
    if (!deathData) {
      return;
    }

    // Check if player is near their death location (within 3 meters) - reactive pattern
    const playerPosition = this.playerPositions.get(data.playerId);
    if (!playerPosition) {
      this.logger.error(`Could not get position for player ${data.playerId}`);
      return;
    }

    const distance = calculateDistance(playerPosition, deathData.deathPosition);

    if (distance > 3) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: data.playerId,
        message: "You need to be closer to your grave to collect your items.",
        type: "error",
      });
      return;
    }

    // Return all items to player
    let returnedItems = 0;
    for (const item of deathData.items) {
      this.emitTypedEvent(EventType.INVENTORY_CAN_ADD, {
        playerId: data.playerId,
        item: item,
        callback: (canAdd: boolean) => {
          if (canAdd) {
            this.emitTypedEvent(EventType.INVENTORY_ITEM_ADDED, {
              playerId: data.playerId,
              item: item,
            });
            returnedItems++;
          } else {
            // If inventory full, create ground item
            this.emitTypedEvent(EventType.WORLD_CREATE_GROUND_ITEM, {
              position: playerPosition,
              item: item,
            });
          }
        },
      });
    }

    // Clear death location and timers
    this.clearDeathLocation(data.playerId);

    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId: data.playerId,
      message: `Retrieved ${returnedItems} items from your grave.`,
      type: "success",
    });
  }

  private despawnDeathItems(playerId: string): void {
    const deathData = this.deathLocations.get(playerId) as
      DeathLocationDataWithHeadstone | undefined;
    if (!deathData) return;

    const headstoneId = deathData.headstoneId;
    if (headstoneId) {
      const entityManager = this.world.getSystem("entity-manager");
      if (entityManager) {
        entityManager.destroyEntity(headstoneId);
      }
    }

    this.clearDeathLocation(playerId);

    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId,
      message: "Your death items have despawned due to timeout.",
      type: "warning",
    });
  }

  private clearDeathLocation(playerId: string): void {
    // Clear all data and timers for this player's death
    this.deathLocations.delete(playerId);

    const respawnTimer = this.respawnTimers.get(playerId);
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      this.respawnTimers.delete(playerId);
    }
  }

  private cleanupPlayerDeath(data: { id: string }): void {
    const playerId = data.id;
    this.clearDeathLocation(playerId);
    this.playerPositions.delete(playerId);
    this.lastDeathTime.delete(playerId);
    this.pendingGravestones.delete(playerId);
  }

  private handleHeadstoneExpired(data: {
    headstoneId: string;
    playerId: string;
  }): void {
    this.despawnDeathItems(data.playerId);
  }

  private async handleCorpseEmpty(data: {
    corpseId: string;
    playerId: string;
  }): Promise<void> {
    this.logger.info("All items looted, clearing death lock", {
      corpseId: data.corpseId,
      playerId: data.playerId,
    });

    // Cancel tick-based gravestone expiration to prevent duplicate ground item spawns.
    // NOTE: If CORPSE_EMPTY never fires (event lost), the gravestone still gets cleaned
    // up by SafeAreaDeathHandler.processTick when its tick-based TTL expires — that's
    // the fallback. This handler is the fast path for immediate cleanup after looting.
    this.safeAreaHandler.cancelGravestoneTimer(data.corpseId);

    // Destroy the gravestone entity immediately via EntityManager.
    // This sends an entityRemoved packet to all clients, preventing stale
    // gravestones from persisting and showing duplicate items.
    // Previously relied on HeadstoneEntity's internal setTimeout which was unreliable.
    const entityManager = this.world.getSystem(
      "entity-manager",
    ) as EntityManager | null;
    if (entityManager) {
      entityManager.destroyEntity(data.corpseId);
    }

    await this.deathStateManager.clearDeathLock(data.playerId);
  }

  getDeathLocation(playerId: string): DeathLocationData | undefined {
    // AAA QUALITY: Check entity deathPosition first (single source of truth)
    const playerEntity = this.world.entities?.get?.(playerId);
    if (playerEntity && "data" in playerEntity) {
      const typedEntity = playerEntity as PlayerEntityLike;
      if (
        typedEntity.data?.deathState === DeathState.DYING &&
        typedEntity.data?.deathPosition
      ) {
        const [x, y, z] = typedEntity.data.deathPosition;
        return {
          playerId,
          deathPosition: { x, y, z },
          timestamp: Date.now(), // Not available from entity, use now
          items: this.deathLocations.get(playerId)?.items || [],
        };
      }
    }
    // Fallback to deathLocations Map for backward compatibility
    return this.deathLocations.get(playerId);
  }

  getAllDeathLocations(): DeathLocationData[] {
    return Array.from(this.deathLocations.values());
  }

  isPlayerDead(playerId: string): boolean {
    // AAA QUALITY: Check entity deathState first (single source of truth)
    const playerEntity = this.world.entities?.get?.(playerId);
    if (playerEntity && "data" in playerEntity) {
      const typedEntity = playerEntity as PlayerEntityLike;
      if (typedEntity.data?.deathState) {
        return (
          typedEntity.data.deathState === DeathState.DYING ||
          typedEntity.data.deathState === DeathState.DEAD
        );
      }
    }
    // Fallback to deathLocations Map for backward compatibility
    return this.deathLocations.has(playerId);
  }

  getRemainingRespawnTime(playerId: string): number {
    const deathData = this.deathLocations.get(playerId);
    if (!deathData) return 0;

    const elapsed = Date.now() - deathData.timestamp;
    return Math.max(
      0,
      ticksToMs(COMBAT_CONSTANTS.DEATH.ANIMATION_TICKS) - elapsed,
    );
  }

  getRemainingDespawnTime(playerId: string): number {
    const deathData = this.deathLocations.get(playerId);
    if (!deathData) return 0;

    const elapsed = Date.now() - deathData.timestamp;
    return Math.max(0, ticksToMs(COMBAT_CONSTANTS.GRAVESTONE_TICKS) - elapsed);
  }

  forceRespawn(playerId: string): void {
    void this.requestPlayerRespawn(playerId);
  }

  // Headstone API (now uses EntityManager instead of HeadstoneApp objects)
  getPlayerHeadstoneId(playerId: string): string | undefined {
    const deathData = this.deathLocations.get(playerId) as
      DeathLocationDataWithHeadstone | undefined;
    if (!deathData) return undefined;
    return deathData.headstoneId;
  }

  processTick(currentTick: number): void {
    if (this.safeAreaHandler) {
      this.safeAreaHandler.processTick(currentTick);
    }
  }

  /**
   * Tick-based respawn processing (AAA quality - deterministic timing)
   * Called every tick by TickSystem when registered.
   * Checks all players in DYING state and respawns them when respawnTick is reached.
   */
  private processPendingRespawns(currentTick: number): void {
    // Process single-retry persist queue (equipment/inventory DB writes that failed)
    this.processPersistRetries();

    // Iterate over all player entities and check for pending respawns
    // Use world.entities.players to get the players Map
    const players = this.world.entities?.players;
    if (!players) return;

    for (const [playerId, playerEntity] of players) {
      const typedEntity = playerEntity as PlayerEntityLike;
      if (!typedEntity.data) continue;

      // Check if player is in DYING state and respawn tick has been reached
      // Skip if death transaction is still in progress
      if (
        typedEntity.data.deathState === DeathState.DYING &&
        typedEntity.data.respawnTick !== undefined &&
        currentTick >= typedEntity.data.respawnTick &&
        !this.deathProcessingInProgress.has(playerId)
      ) {
        // Hide player briefly before respawn
        typedEntity.data.visible = false;
        if ("markNetworkDirty" in playerEntity) {
          (playerEntity as { markNetworkDirty: () => void }).markNetworkDirty();
        }

        // Initiate respawn for this player
        void this.requestPlayerRespawn(playerId);
      }
    }
  }

  /** Queue a persist retry, bounded to prevent unbounded growth under sustained DB failures */
  private queuePersistRetry(
    playerId: string,
    type: "equipment" | "inventory",
  ): void {
    if (
      this.pendingPersistRetries.length >= PlayerDeathSystem.MAX_PERSIST_RETRIES
    ) {
      this.logger.error(
        "DEATH_PERSIST_DESYNC: Retry queue full — dropping retry (DB may be persistently unavailable)",
        undefined,
        { playerId, type, queueSize: this.pendingPersistRetries.length },
      );
      this.emitTypedEvent(EventType.AUDIT_LOG, {
        action: "DEATH_PERSIST_RETRY_QUEUE_FULL",
        playerId,
        actorId: playerId,
        zoneType: "unknown",
        success: false,
        failureReason: `${type}_persist_retry_dropped`,
        queueSize: this.pendingPersistRetries.length,
        timestamp: Date.now(),
      });
      return;
    }
    this.pendingPersistRetries.push({ playerId, type });
  }

  /** Single-attempt retry for post-transaction DB persist failures */
  private processPersistRetries(): void {
    if (this.pendingPersistRetries.length === 0) return;

    // Drain the queue (single attempt only — no infinite retry loops)
    const retries = this.pendingPersistRetries.splice(0);

    for (const { playerId, type } of retries) {
      // Skip if a retry is already in-flight for this player (prevents races)
      if (this.persistRetryInFlight.has(playerId)) {
        this.logger.debug(
          "Skipping persist retry — already in-flight for player",
          { playerId, type },
        );
        continue;
      }

      this.persistRetryInFlight.add(playerId);

      const onComplete = () => {
        this.persistRetryInFlight.delete(playerId);
      };

      if (type === "equipment") {
        const equipmentSystem = this.world.getSystem(
          "equipment",
        ) as unknown as EquipmentSystemLike | null;
        if (equipmentSystem?.clearEquipmentImmediate) {
          void equipmentSystem
            .clearEquipmentImmediate(playerId)
            .then(() => {
              this.logger.info(
                "DEATH_PERSIST_DESYNC: Equipment DB persist retry succeeded",
                { playerId },
              );
            })
            .catch((err) => {
              this.logger.error(
                "DEATH_PERSIST_DESYNC: Equipment DB persist retry also failed — possible item duplication",
                err instanceof Error ? err : undefined,
                { playerId },
              );
              this.emitTypedEvent(EventType.AUDIT_LOG, {
                action: "DEATH_PERSIST_DESYNC",
                playerId,
                actorId: playerId,
                zoneType: "unknown",
                success: false,
                failureReason: "equipment_persist_retry_failed",
                timestamp: Date.now(),
              });
            })
            .finally(onComplete);
        } else {
          onComplete();
        }
      } else {
        const inventorySystem = this.world.getSystem(
          "inventory",
        ) as InventorySystem | null;
        if (inventorySystem) {
          void inventorySystem
            .clearInventoryImmediate(playerId, false)
            .then(() => {
              this.logger.info(
                "DEATH_PERSIST_DESYNC: Inventory DB persist retry succeeded",
                { playerId },
              );
            })
            .catch((err) => {
              this.logger.error(
                "DEATH_PERSIST_DESYNC: Inventory DB persist retry also failed — possible item duplication",
                err instanceof Error ? err : undefined,
                { playerId },
              );
              this.emitTypedEvent(EventType.AUDIT_LOG, {
                action: "DEATH_PERSIST_DESYNC",
                playerId,
                actorId: playerId,
                zoneType: "unknown",
                success: false,
                failureReason: "inventory_persist_retry_failed",
                timestamp: Date.now(),
              });
            })
            .finally(onComplete);
        } else {
          onComplete();
        }
      }
    }
  }
}
