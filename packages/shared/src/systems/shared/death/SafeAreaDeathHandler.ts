/**
 * SafeAreaDeathHandler (TICK-BASED)
 *
 * Handles player death in safe zones (classic fantasy MMORPG-style):
 * 1. Items → gravestone (1500 ticks = 15 minutes)
 * 2. Gravestone expires → ground items (6000 ticks = 60 minutes)
 * 3. Ground items despawn via GroundItemSystem tick processing
 *
 * TICK-BASED TIMING (rules-accurate):
 * - Gravestone expiration tracked in ticks
 * - processTick() called once per tick by TickSystem
 * - Uses constants from COMBAT_CONSTANTS
 *
 */

import type { World } from "../../../core/World";
import { Logger } from "../../../utils/Logger";
import type { InventoryItem } from "../../../types/core/core";
import type { GroundItemSystem } from "../economy/GroundItemSystem";
import type { DeathStateManager } from "./DeathStateManager";
import type { EntityManager } from "..";
import { ZoneType, type TransactionContext } from "../../../types/death";
import { EntityType, InteractionType } from "../../../types/entities";
import type { HeadstoneEntityConfig } from "../../../types/entities";
import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";
import { ticksToMs } from "../../../utils/game/CombatCalculations";
import { isPositionInsideDuelArenaZone } from "../../../data/duel-manifest";
import { GRAVESTONE_ID_PREFIX } from "../combat/DeathUtils";

const GRAVESTONE_MODEL_PATH = "models/environment/gravestone.glb";

/** Gravestone data tracked for tick-based expiration */
interface GravestoneData {
  gravestoneId: string;
  playerId: string;
  position: { x: number; y: number; z: number };
  items: InventoryItem[];
  expirationTick: number;
  durableCustody: boolean;
}

export class SafeAreaDeathHandler {
  // TICK-BASED gravestone tracking (no more setTimeout)
  private gravestones = new Map<string, GravestoneData>();

  // Keep ms values for backwards compatibility with GroundItemOptions
  private readonly GROUND_ITEM_DURATION_MS = ticksToMs(
    COMBAT_CONSTANTS.GROUND_ITEM_DESPAWN_TICKS,
  );

  constructor(
    private world: World,
    private groundItemManager: GroundItemSystem,
    private deathStateManager: DeathStateManager,
  ) {}

  /**
   * Handle player death in safe area
   *
   * @param playerId - The player who died
   * @param position - Death position
   * @param items - Items to drop in gravestone
   * @param killedBy - Who/what killed the player
   * @param tx - Optional transaction context for atomic operations
   */
  async handleDeath(
    playerId: string,
    position: { x: number; y: number; z: number },
    items: InventoryItem[],
    killedBy: string,
    tx?: TransactionContext,
  ): Promise<void> {
    // CRITICAL: Server authority check - prevent client from spawning fake gravestones
    if (!this.world.isServer) {
      console.error(
        `[SafeAreaDeathHandler] ⚠️  Client attempted server-only death handling for ${playerId} - BLOCKED`,
      );
      return;
    }

    Logger.system(
      "SafeAreaDeathHandler",
      `Handling safe area death for ${playerId} at (${position.x}, ${position.y}, ${position.z})${tx ? " (in transaction)" : ""}`,
    );
    Logger.system(
      "SafeAreaDeathHandler",
      `Received ${items.length} items to put in gravestone: ${items.map((item) => `${item.itemId} x${item.quantity}`).join(", ") || "(none)"}`,
    );

    if (items.length === 0) {
      console.log(
        `[SafeAreaDeathHandler] No items to drop for ${playerId}, skipping gravestone`,
      );
      return;
    }

    // Spawn gravestone with items
    const gravestoneId = await this.spawnGravestone(
      playerId,
      position,
      items,
      killedBy,
    );

    if (!gravestoneId) {
      const errorMsg = `Failed to spawn gravestone for ${playerId}`;
      console.error(`[SafeAreaDeathHandler] ${errorMsg}`);
      // If in transaction, throw to trigger rollback
      if (tx) {
        throw new Error(errorMsg);
      }
      return;
    }

    // Create death lock in database (with transaction if provided)
    await this.deathStateManager.createDeathLock(
      playerId,
      {
        gravestoneId: gravestoneId,
        position: position,
        zoneType: ZoneType.SAFE_AREA,
        itemCount: items.length,
      },
      tx, // Pass transaction context
    );

    // Track gravestone for tick-based expiration (500 ticks = 5 minutes)
    // Type-safe tick calculation with explicit number type
    const currentTick: number = this.world.currentTick ?? 0;
    const gravestoneTicks: number = COMBAT_CONSTANTS.GRAVESTONE_TICKS;
    const expirationTick: number = currentTick + gravestoneTicks;

    // Defensive copy of items array to prevent external mutation
    this.gravestones.set(gravestoneId, {
      gravestoneId,
      playerId,
      position: { ...position },
      items: items.map((item) => ({ ...item })),
      expirationTick,
      durableCustody: false,
    });

    console.log(
      `[SafeAreaDeathHandler] Gravestone ${gravestoneId} will expire at tick ${expirationTick} (${COMBAT_CONSTANTS.GRAVESTONE_TICKS} ticks = ${(ticksToMs(COMBAT_CONSTANTS.GRAVESTONE_TICKS) / 1000).toFixed(1)}s)`,
    );
  }

  /**
   * Spawn gravestone entity with items
   */
  private async spawnGravestone(
    playerId: string,
    position: { x: number; y: number; z: number },
    items: InventoryItem[],
    killedBy: string,
    durableCustody = false,
    exactGravestoneId?: string,
  ): Promise<string> {
    const entityManager = this.world.getSystem(
      "entity-manager",
    ) as EntityManager | null;
    if (!entityManager) {
      console.error("[SafeAreaDeathHandler] EntityManager not available");
      return "";
    }

    // Get the player's display name from multiple sources
    const playerFromWorld = this.world.getPlayer?.(playerId) as {
      playerName?: string;
      name?: string;
    } | null;
    const playerEntity = this.world.entities?.get?.(playerId) as
      { playerName?: string; name?: string } | undefined;
    const playerName =
      playerFromWorld?.playerName ||
      playerFromWorld?.name ||
      playerEntity?.playerName ||
      playerEntity?.name ||
      playerId;

    const gravestoneId =
      exactGravestoneId ?? `${GRAVESTONE_ID_PREFIX}${playerId}_${Date.now()}`;
    // Calculate despawnTime in ms for entity config (backwards compatible)
    const despawnTime = durableCustody
      ? Number.MAX_SAFE_INTEGER
      : Date.now() + ticksToMs(COMBAT_CONSTANTS.GRAVESTONE_TICKS);

    // Create gravestone entity
    const gravestoneConfig: HeadstoneEntityConfig = {
      id: gravestoneId,
      name: `${playerName}'s Gravestone`,
      type: EntityType.HEADSTONE,
      position: position,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: true,
      interactionType: InteractionType.LOOT,
      interactionDistance: 2,
      description: `Gravestone of ${playerName} (killed by ${killedBy})`,
      model: GRAVESTONE_MODEL_PATH,
      headstoneData: {
        playerId: playerId,
        playerName: playerName,
        deathTime: Date.now(),
        deathMessage: `Slain by ${killedBy}`,
        position: position,
        items: items,
        itemCount: items.length,
        despawnTime: despawnTime,
        // Safe area gravestone: owner-only loot (no expiration until despawn)
        // lootProtectionUntil: 0 signals permanent owner-only protection
        lootProtectionUntil: 0,
        protectedFor: playerId,
        zoneType: "safe_area",
      },
      properties: {
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        health: { current: 1, max: 1 },
        level: 1,
      },
    };

    const gravestoneEntity = await entityManager.spawnEntity(gravestoneConfig);

    if (!gravestoneEntity) {
      console.error(
        `[SafeAreaDeathHandler] Failed to spawn gravestone entity: ${gravestoneId}`,
      );
      return "";
    }

    console.log(
      `[SafeAreaDeathHandler] Spawned gravestone ${gravestoneId} with ${items.length} items`,
    );

    return gravestoneId;
  }

  /**
   * Process tick - check for expired gravestones (TICK-BASED)
   * Called once per tick by TickSystem
   *
   * Uses consistent async/await pattern for promise handling
   *
   * @param currentTick - Current server tick number
   */
  processTick(currentTick: number): void {
    const expiredGravestones: GravestoneData[] = [];

    for (const gravestoneData of this.gravestones.values()) {
      if (currentTick >= gravestoneData.expirationTick) {
        expiredGravestones.push(gravestoneData);
      }
    }

    // Process expired gravestones — delete from Map only AFTER async completes
    for (const gravestoneData of expiredGravestones) {
      // Remove from tracking BEFORE async work to prevent double-processing on next tick
      this.gravestones.delete(gravestoneData.gravestoneId);

      void this.handleGravestoneExpire(gravestoneData, currentTick).catch(
        (err) => {
          Logger.systemError(
            "SafeAreaDeathHandler",
            `Gravestone expiration failed for ${gravestoneData.gravestoneId}`,
            err instanceof Error ? err : new Error(String(err)),
          );
        },
      );
    }
  }

  /**
   * Handle gravestone expiration (transition to ground items) - TICK-BASED
   */
  private async handleGravestoneExpire(
    gravestoneData: GravestoneData,
    currentTick: number,
  ): Promise<void> {
    const { gravestoneId, playerId, position, items } = gravestoneData;

    // Database-native custody must remain owner-only and recoverable. Renew the
    // visible grave instead of converting it into ephemeral public ground loot.
    if (gravestoneData.durableCustody) {
      const deathLock = await this.deathStateManager.getDeathLock(playerId);
      if (
        deathLock?.deathOperationId &&
        deathLock.gravestoneId === gravestoneId
      ) {
        this.gravestones.set(gravestoneId, {
          ...gravestoneData,
          expirationTick: Number.MAX_SAFE_INTEGER,
        });
        Logger.system(
          "SafeAreaDeathHandler",
          `Renewed durable gravestone ${gravestoneId} for owner recovery`,
        );
      } else {
        const entityManager = this.world.getSystem(
          "entity-manager",
        ) as EntityManager | null;
        entityManager?.destroyEntity(gravestoneId);
      }
      return;
    }

    // Note: gravestone was already removed from this.gravestones in processTick
    // to prevent double-processing on next tick.

    // Destroy gravestone entity
    const entityManager = this.world.getSystem(
      "entity-manager",
    ) as EntityManager | null;
    if (entityManager) {
      entityManager.destroyEntity(gravestoneId);
    }

    // Spawn ground items (using ms for GroundItemOptions backwards compatibility)
    const groundItemIds = await this.groundItemManager.spawnGroundItems(
      items,
      position,
      {
        despawnTime: this.GROUND_ITEM_DURATION_MS,
        droppedBy: playerId,
        lootProtection: 0, // No loot protection after gravestone expires
        scatter: true,
        scatterRadius: 2.0,
      },
    );

    // Update death lock
    await this.deathStateManager.onGravestoneExpired(playerId, groundItemIds);

    Logger.system(
      "SafeAreaDeathHandler",
      `Transitioned gravestone ${gravestoneId} to ${groundItemIds.length} ground items`,
    );
  }

  /**
   * Spawn a gravestone and track it for tick-based expiration.
   * Unlike handleDeath(), this does NOT create a death lock — the caller
   * is responsible for the death lock (it already exists by this point).
   * Used by PlayerDeathSystem for post-respawn gravestone spawning and crash recovery.
   */
  async spawnAndTrackGravestone(
    playerId: string,
    position: { x: number; y: number; z: number },
    items: InventoryItem[],
    killedBy: string,
    recovery: {
      deathOperationId?: string | null;
      exactGravestoneId?: string | null;
    } = {},
  ): Promise<string> {
    if (!this.world.isServer) {
      console.error(
        `[SafeAreaDeathHandler] Client attempted server-only gravestone spawn for ${playerId} - BLOCKED`,
      );
      return "";
    }

    if (items.length === 0) {
      Logger.system(
        "SafeAreaDeathHandler",
        `No items to drop for ${playerId}, skipping gravestone`,
      );
      return "";
    }

    // HARD RULE: Never spawn gravestones inside the duel arena.
    // Duel deaths are handled by DuelSystem/StreamingDuelScheduler.
    if (isPositionInsideDuelArenaZone(position.x, position.z)) {
      Logger.system(
        "SafeAreaDeathHandler",
        `Position (${position.x.toFixed(1)}, ${position.z.toFixed(1)}) is inside duel arena — skipping gravestone for ${playerId}`,
      );
      return "";
    }

    const deathLock = await this.deathStateManager.getDeathLock(playerId);
    if (
      recovery.deathOperationId !== undefined &&
      (deathLock?.deathOperationId ?? null) !== recovery.deathOperationId
    ) {
      throw new Error("death_recovery_operation_mismatch");
    }
    const exactGravestoneId = recovery.exactGravestoneId?.trim() || undefined;
    if (exactGravestoneId) {
      const requiredPrefix = `${GRAVESTONE_ID_PREFIX}${playerId}_`;
      if (
        exactGravestoneId.length > 256 ||
        !exactGravestoneId.startsWith(requiredPrefix) ||
        /[\u0000-\u001f\u007f]/u.test(exactGravestoneId) ||
        deathLock?.gravestoneId !== exactGravestoneId
      ) {
        throw new Error("death_recovery_gravestone_identity_invalid");
      }
    }
    const durableCustody = Boolean(deathLock?.deathOperationId);
    let gravestoneId = exactGravestoneId;
    if (gravestoneId) {
      const existing = this.world.entities?.get?.(gravestoneId) as
        | {
            getOwnerId?: () => string;
            getLootItems?: () => InventoryItem[];
          }
        | undefined;
      if (existing) {
        const summarize = (values: InventoryItem[]): string =>
          JSON.stringify(
            [...values]
              .map(({ itemId, quantity }) => ({ itemId, quantity }))
              .sort((left, right) =>
                left.itemId === right.itemId
                  ? left.quantity - right.quantity
                  : left.itemId.localeCompare(right.itemId),
              ),
          );
        if (
          existing.getOwnerId?.() !== playerId ||
          typeof existing.getLootItems !== "function" ||
          summarize(existing.getLootItems()) !== summarize(items)
        ) {
          throw new Error("death_recovery_gravestone_collision");
        }
      } else {
        gravestoneId = await this.spawnGravestone(
          playerId,
          position,
          items,
          killedBy,
          durableCustody,
          exactGravestoneId,
        );
      }
    } else {
      gravestoneId = await this.spawnGravestone(
        playerId,
        position,
        items,
        killedBy,
        durableCustody,
      );
    }

    if (!gravestoneId) {
      console.error(
        `[SafeAreaDeathHandler] Failed to spawn gravestone for ${playerId}`,
      );
      return "";
    }

    // Track for tick-based expiration
    const currentTick: number = this.world.currentTick ?? 0;
    const gravestoneTicks: number = COMBAT_CONSTANTS.GRAVESTONE_TICKS;
    const expirationTick: number = durableCustody
      ? Number.MAX_SAFE_INTEGER
      : currentTick + gravestoneTicks;

    this.gravestones.set(gravestoneId, {
      gravestoneId,
      playerId,
      position: { ...position },
      items: items.map((item) => ({ ...item })),
      expirationTick,
      durableCustody,
    });

    console.log(
      durableCustody
        ? `[SafeAreaDeathHandler] Gravestone ${gravestoneId} retained for durable owner recovery`
        : `[SafeAreaDeathHandler] Gravestone ${gravestoneId} tracked for expiration at tick ${expirationTick} (${COMBAT_CONSTANTS.GRAVESTONE_TICKS} ticks = ${(ticksToMs(COMBAT_CONSTANTS.GRAVESTONE_TICKS) / 1000).toFixed(1)}s)`,
    );

    return gravestoneId;
  }

  /**
   * Handle item looted from gravestone
   * Called when player interacts with gravestone and takes an item
   */
  async onItemLooted(playerId: string, itemId: string): Promise<void> {
    await this.deathStateManager.onItemLooted(playerId, itemId);
  }

  /**
   * Cancel gravestone tracking (e.g., all items looted)
   */
  cancelGravestoneTimer(gravestoneId: string): void {
    if (this.gravestones.has(gravestoneId)) {
      this.gravestones.delete(gravestoneId);
      console.log(
        `[SafeAreaDeathHandler] Cancelled gravestone tracking for ${gravestoneId}`,
      );
    }
  }

  /**
   * Returns ticks remaining before gravestone expiration.
   * - `-1` when gravestone is not tracked
   * - `0` when already expired
   */
  getTicksUntilExpiration(gravestoneId: string, currentTick: number): number {
    const gravestone = this.gravestones.get(gravestoneId);
    if (!gravestone) return -1;
    return Math.max(0, gravestone.expirationTick - currentTick);
  }

  /**
   * Clean up all gravestone tracking
   */
  destroy(): void {
    this.gravestones.clear();
  }
}
