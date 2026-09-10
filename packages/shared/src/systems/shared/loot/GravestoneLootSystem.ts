/**
 * GravestoneLootSystem
 *
 * ECS system that handles all gravestone loot processing.
 * Extracted from HeadstoneEntity to follow ECS architecture:
 * entities are data containers, systems handle logic.
 *
 * Responsibilities:
 * - Processing CORPSE_LOOT_REQUEST (single item loot)
 * - Processing CORPSE_LOOT_ALL_REQUEST (loot all)
 * - Rate limiting loot requests
 * - Inventory space validation
 * - Loot result emission (network + events)
 * - Audit logging
 */

import { SystemBase } from "../infrastructure/SystemBase";
import type { World } from "../../../core/World";
import { EventType } from "../../../types/events";
import type { InventoryItem } from "../../../types/core/core";
import type { LootFailureReason } from "../../../types/death";
import { generateTransactionId } from "../../../utils/IdGenerator";
import { DeathState } from "../../../types/entities";
import { getItem } from "../../../data/items";
import { INVENTORY_CONSTANTS } from "../../../constants/GameConstants";

/** Interface for entities that can be looted (HeadstoneEntity) */
type LootableEntity = {
  id: string;
  canPlayerLoot: (playerId: string) => boolean;
  removeItem: (itemId: string, quantity: number) => boolean;
  restoreItem: (
    itemId: string,
    quantity: number,
    originalIndex: number,
  ) => void;
  getLootItems: () => InventoryItem[];
  hasLoot: () => boolean;
  getPosition: () => { x: number; y: number; z: number };
  getOwnerId: () => string;
  getZoneType: () => string;
};

/** Type for inventory system access */
type InventorySystemAccess = {
  getInventory: (
    playerId: string,
  ) => { items: Array<{ itemId: string }> } | null;
  reloadFromDatabase?: (playerId: string) => Promise<void>;
};

type DatabaseSystemAccess = {
  getDeathLockAsync?: (playerId: string) => Promise<{
    playerId: string;
    gravestoneId?: string | null;
    deathOperationId?: string | null;
  } | null>;
  commitSafeAreaDeathGravestoneLootAsync?: (request: {
    operationId: string;
    playerId: string;
    deathOperationId: string;
    gravestoneId: string;
    items?: Array<{ itemId: string; quantity: number }>;
  }) => Promise<{
    replayed: boolean;
    transferred: Array<{ itemId: string; quantity: number }>;
    remaining: Array<{ itemId: string; quantity: number }>;
  }>;
};

/** Validated loot context returned by shared validation */
type LootContext = {
  entity: LootableEntity;
  ownerId: string;
  zoneType: string;
};

// --- Runtime Payload Validators ---

function isValidLootRequest(data: unknown): data is {
  corpseId: string;
  playerId: string;
  itemId: string;
  quantity: number;
  slot?: number;
  transactionId?: string;
} {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.corpseId === "string" &&
    d.corpseId.length > 0 &&
    typeof d.playerId === "string" &&
    d.playerId.length > 0 &&
    typeof d.itemId === "string" &&
    d.itemId.length > 0 &&
    typeof d.quantity === "number" &&
    d.quantity > 0 &&
    Number.isInteger(d.quantity)
  );
}

function isValidLootAllRequest(
  data: unknown,
): data is { corpseId: string; playerId: string; transactionId?: string } {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.corpseId === "string" &&
    d.corpseId.length > 0 &&
    typeof d.playerId === "string" &&
    d.playerId.length > 0
  );
}

export class GravestoneLootSystem extends SystemBase {
  private lootQueues = new Map<string, Promise<void>>();
  private lootRateLimiter = new Map<string, number>();
  private readonly LOOT_RATE_LIMIT_MS = 100;
  private rateLimiterLastPruned = 0;
  private readonly RATE_LIMITER_PRUNE_INTERVAL_MS = 60_000;

  constructor(world: World) {
    super(world, {
      name: "gravestone-loot",
      dependencies: {
        required: [],
        optional: ["inventory", "database"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    this.subscribe(EventType.CORPSE_LOOT_REQUEST, (data: unknown) => {
      if (!isValidLootRequest(data)) {
        console.warn(
          `[GravestoneLootSystem] Rejected malformed CORPSE_LOOT_REQUEST`,
        );
        return;
      }
      this.validateAndQueueLoot(data, (d) =>
        this.processLootRequest(d as typeof data & { transactionId: string }),
      );
    });

    this.subscribe(EventType.CORPSE_LOOT_ALL_REQUEST, (data: unknown) => {
      if (!isValidLootAllRequest(data)) {
        console.warn(
          `[GravestoneLootSystem] Rejected malformed CORPSE_LOOT_ALL_REQUEST`,
        );
        return;
      }
      this.validateAndQueueLoot(data, (d) =>
        this.processLootAllRequest(
          d as { corpseId: string; playerId: string; transactionId: string },
        ),
      );
    });
  }

  // --- Shared Validation ---

  /**
   * Shared preamble for all loot requests:
   * server check, transaction ID, rate limiting, queue serialization
   */
  private validateAndQueueLoot(
    data: { corpseId: string; playerId: string; transactionId?: string },
    processor: (
      data: {
        corpseId: string;
        playerId: string;
        transactionId: string;
      } & Record<string, unknown>,
    ) => Promise<void>,
  ): void {
    if (!this.world.isServer) return;

    const transactionId = data.transactionId || generateTransactionId();

    if (this.isRateLimited(data.playerId)) {
      this.emitLootResult(
        data.playerId,
        transactionId,
        false,
        data.corpseId,
        "",
        "RATE_LIMITED",
      );
      return;
    }

    const enrichedData = { ...data, transactionId };
    const queue = this.lootQueues.get(data.corpseId) || Promise.resolve();
    const newQueue = queue
      .then(() => processor(enrichedData))
      .catch((error) => {
        console.error(`[GravestoneLootSystem] Loot operation failed:`, error);
        this.emitLootResult(
          data.playerId,
          transactionId,
          false,
          data.corpseId,
          "",
          "INVALID_REQUEST",
        );
      })
      .finally(() => {
        // Clean up stale queue entry if this is still the latest in the chain
        if (this.lootQueues.get(data.corpseId) === newQueue) {
          this.lootQueues.delete(data.corpseId);
        }
      });
    this.lootQueues.set(data.corpseId, newQueue);
  }

  /**
   * Shared permission validation for all loot processors:
   * entity lookup, loot permission, death state check
   */
  private validateLootPermissions(
    corpseId: string,
    playerId: string,
    transactionId: string,
  ): LootContext | null {
    const entity = this.getLootableEntity(corpseId);
    if (!entity) {
      // A service may validate an entity immediately before it is removed by
      // another authoritative action. Always close the exact request instead
      // of making the caller wait for its custody timeout.
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        "",
        "INVALID_REQUEST",
      );
      return null;
    }

    const ownerId = entity.getOwnerId();
    const zoneType = entity.getZoneType();

    if (!entity.canPlayerLoot(playerId)) {
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        "PROTECTED",
        undefined,
        undefined,
        zoneType,
      );
      return null;
    }

    if (this.isPlayerInDeathState(playerId)) {
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        "PLAYER_DYING",
        undefined,
        undefined,
        zoneType,
      );
      return null;
    }

    return { entity, ownerId, zoneType };
  }

  // --- Helpers ---

  private getInventorySystem(): InventorySystemAccess | null {
    const sys = this.world.getSystem("inventory");
    return sys?.getInventory ? (sys as InventorySystemAccess) : null;
  }

  private getLootableEntity(entityId: string): LootableEntity | null {
    const entity = this.world.entities?.get?.(entityId);
    if (
      !entity ||
      !("canPlayerLoot" in entity) ||
      !("removeItem" in entity) ||
      !("restoreItem" in entity) ||
      !("getLootItems" in entity) ||
      !("getOwnerId" in entity) ||
      !("getZoneType" in entity)
    ) {
      return null;
    }
    return entity as unknown as LootableEntity;
  }

  /**
   * Safe-area gravestones use database-first custody. Returning true means the
   * request was fully handled (successfully or fail-closed); false selects the
   * legacy non-safe-area path.
   */
  private async processAtomicSafeAreaLoot(
    ctx: LootContext,
    data: {
      corpseId: string;
      playerId: string;
      transactionId: string;
    },
    requested?: Array<{ itemId: string; quantity: number }>,
  ): Promise<boolean> {
    if (ctx.zoneType !== "safe_area") return false;

    const { corpseId, playerId, transactionId } = data;
    const { entity, ownerId, zoneType } = ctx;
    const databaseSystem = this.world.getSystem(
      "database",
    ) as unknown as DatabaseSystemAccess | null;
    const inventorySystem = this.getInventorySystem();
    if (
      ownerId !== playerId ||
      !databaseSystem?.getDeathLockAsync ||
      !databaseSystem.commitSafeAreaDeathGravestoneLootAsync ||
      !inventorySystem?.reloadFromDatabase
    ) {
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        "INVALID_REQUEST",
        undefined,
        undefined,
        zoneType,
      );
      return true;
    }

    try {
      const deathLock = await databaseSystem.getDeathLockAsync(ownerId);
      if (!deathLock?.deathOperationId || deathLock.gravestoneId !== corpseId) {
        throw new Error("safe_death_lock_mismatch");
      }
      const receipt =
        await databaseSystem.commitSafeAreaDeathGravestoneLootAsync({
          operationId: transactionId,
          playerId,
          deathOperationId: deathLock.deathOperationId,
          gravestoneId: corpseId,
          ...(requested ? { items: requested } : {}),
        });

      // Mirror the committed inventory before removing the visible custody.
      // A crash at any boundary can replay the same database receipt.
      await inventorySystem.reloadFromDatabase(playerId);
      for (const item of receipt.transferred) {
        if (!entity.removeItem(item.itemId, item.quantity)) {
          throw new Error("safe_death_gravestone_memory_mismatch");
        }
      }

      const single = requested?.length === 1 ? receipt.transferred[0] : null;
      this.emitLootResult(
        playerId,
        transactionId,
        true,
        corpseId,
        ownerId,
        undefined,
        single?.itemId,
        single?.quantity ?? receipt.transferred.length,
        zoneType,
      );
      this.world.emit(EventType.AUDIT_LOG, {
        action: requested ? "LOOT_SUCCESS" : "LOOT_ALL_SUCCESS",
        playerId: ownerId,
        actorId: playerId,
        entityId: corpseId,
        items: receipt.transferred,
        zoneType,
        position: entity.getPosition(),
        success: true,
        transactionId,
        replayed: receipt.replayed,
        timestamp: Date.now(),
      });
    } catch (error) {
      const inventoryFull =
        error instanceof Error && error.message === "safe_death_inventory_full";
      if (inventoryFull) {
        this.world.emit(EventType.UI_MESSAGE, {
          playerId,
          message: "Your inventory is full!",
          type: "error",
        });
      }
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        inventoryFull ? "INVENTORY_FULL" : "INVALID_REQUEST",
        undefined,
        undefined,
        zoneType,
      );
    }
    return true;
  }

  private isRateLimited(playerId: string): boolean {
    const now = Date.now();

    // Periodically prune stale entries to prevent unbounded growth
    if (
      now - this.rateLimiterLastPruned >
      this.RATE_LIMITER_PRUNE_INTERVAL_MS
    ) {
      this.rateLimiterLastPruned = now;
      for (const [id, timestamp] of this.lootRateLimiter) {
        if (now - timestamp > this.RATE_LIMITER_PRUNE_INTERVAL_MS) {
          this.lootRateLimiter.delete(id);
        }
      }
    }

    const lastRequest = this.lootRateLimiter.get(playerId) || 0;
    if (now - lastRequest < this.LOOT_RATE_LIMIT_MS) {
      return true;
    }
    this.lootRateLimiter.set(playerId, now);
    return false;
  }

  private isPlayerInDeathState(playerId: string): boolean {
    const playerEntity = this.world.entities?.get?.(playerId) as
      { data?: { deathState?: DeathState } } | undefined;
    if (!playerEntity?.data?.deathState) return false;
    return (
      playerEntity.data.deathState === DeathState.DYING ||
      playerEntity.data.deathState === DeathState.DEAD
    );
  }

  private checkInventorySpace(
    playerId: string,
    itemId: string,
  ): { hasSpace: boolean; reason?: string } {
    const inventorySystem = this.getInventorySystem();
    if (!inventorySystem) {
      return { hasSpace: false, reason: "InventorySystem not available" };
    }

    const inventory = inventorySystem.getInventory(playerId);
    if (!inventory) {
      return { hasSpace: false, reason: "No inventory" };
    }

    const isFull =
      inventory.items.length >= INVENTORY_CONSTANTS.MAX_INVENTORY_SLOTS;
    if (isFull) {
      const itemDef = getItem(itemId);
      const isStackable = itemDef?.stackable === true;
      if (isStackable) {
        const existingItem = inventory.items.find(
          (item: { itemId: string }) => item.itemId === itemId,
        );
        if (existingItem) {
          return { hasSpace: true };
        }
      }
      return { hasSpace: false, reason: "INVENTORY_FULL" };
    }

    return { hasSpace: true };
  }

  private emitLootResult(
    playerId: string,
    transactionId: string,
    success: boolean,
    entityId: string,
    ownerId: string,
    reason?: LootFailureReason,
    itemId?: string,
    quantity?: number,
    zoneType: string = "safe_area",
  ): void {
    const result = {
      transactionId,
      success,
      itemId,
      quantity,
      reason,
      timestamp: Date.now(),
    };

    if (this.world.network && "sendTo" in this.world.network) {
      (
        this.world.network as {
          sendTo: (id: string, event: string, data: unknown) => void;
        }
      ).sendTo(playerId, "lootResult", result);
    }

    this.world.emit(EventType.LOOT_RESULT, { playerId, ...result });

    if (!success) {
      this.world.emit(EventType.AUDIT_LOG, {
        action: "LOOT_FAILED",
        playerId: ownerId,
        actorId: playerId,
        entityId,
        items: itemId ? [{ itemId, quantity: quantity || 1 }] : undefined,
        zoneType,
        position: undefined,
        success: false,
        failureReason: reason,
        transactionId,
        timestamp: Date.now(),
      });
    }
  }

  // --- Single Item Loot ---

  private async processLootRequest(data: {
    corpseId: string;
    playerId: string;
    itemId: string;
    quantity: number;
    slot?: number;
    transactionId: string;
  }): Promise<void> {
    const { corpseId, playerId, itemId, quantity, transactionId } = data;

    const ctx = this.validateLootPermissions(corpseId, playerId, transactionId);
    if (!ctx) return;
    const { entity, ownerId, zoneType } = ctx;

    if (
      await this.processAtomicSafeAreaLoot(ctx, data, [{ itemId, quantity }])
    ) {
      return;
    }

    const lootItems = entity.getLootItems();
    const item = lootItems.find((i) => i.itemId === itemId);
    if (!item) {
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        "ITEM_NOT_FOUND",
        undefined,
        undefined,
        zoneType,
      );
      return;
    }

    const quantityToLoot = Math.min(quantity, item.quantity);
    if (quantityToLoot <= 0) {
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        "INVALID_REQUEST",
        undefined,
        undefined,
        zoneType,
      );
      return;
    }

    const spaceCheck = this.checkInventorySpace(playerId, itemId);
    if (!spaceCheck.hasSpace) {
      if (spaceCheck.reason === "INVENTORY_FULL") {
        this.world.emit(EventType.UI_MESSAGE, {
          playerId,
          message: "Your inventory is full!",
          type: "error",
        });
      }
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        "INVENTORY_FULL",
        undefined,
        undefined,
        zoneType,
      );
      return;
    }

    // Snapshot item index before removal for rollback
    const preRemovalItems = entity.getLootItems();
    const originalIndex = preRemovalItems.findIndex((i) => i.itemId === itemId);

    const removed = entity.removeItem(itemId, quantityToLoot);
    if (!removed) {
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        "ITEM_NOT_FOUND",
        undefined,
        undefined,
        zoneType,
      );
      return;
    }

    // Defensive re-check: if inventory space disappeared after removal, rollback
    const recheck = this.checkInventorySpace(playerId, itemId);
    if (!recheck.hasSpace) {
      entity.restoreItem(
        itemId,
        quantityToLoot,
        originalIndex >= 0 ? originalIndex : 0,
      );
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        "INVENTORY_FULL",
        undefined,
        undefined,
        zoneType,
      );
      return;
    }

    this.world.emit(EventType.INVENTORY_ITEM_ADDED, {
      playerId,
      item: {
        id: `loot_${playerId}_${Date.now()}`,
        itemId,
        quantity: quantityToLoot,
        slot: -1,
        metadata: null,
      },
    });

    this.emitLootResult(
      playerId,
      transactionId,
      true,
      corpseId,
      ownerId,
      undefined,
      itemId,
      quantityToLoot,
      zoneType,
    );

    this.world.emit(EventType.AUDIT_LOG, {
      action: "LOOT_SUCCESS",
      playerId: ownerId,
      actorId: playerId,
      entityId: corpseId,
      items: [{ itemId, quantity: quantityToLoot }],
      zoneType,
      position: entity.getPosition(),
      success: true,
      transactionId,
      timestamp: Date.now(),
    });
  }

  // --- Loot All ---

  private async processLootAllRequest(data: {
    corpseId: string;
    playerId: string;
    transactionId: string;
  }): Promise<void> {
    const { corpseId, playerId, transactionId } = data;

    const ctx = this.validateLootPermissions(corpseId, playerId, transactionId);
    if (!ctx) return;
    const { entity, ownerId, zoneType } = ctx;

    if (await this.processAtomicSafeAreaLoot(ctx, data)) return;

    const lootItems = entity.getLootItems();
    if (lootItems.length === 0) {
      this.emitLootResult(playerId, transactionId, true, corpseId, ownerId);
      return;
    }

    const inventorySystem = this.getInventorySystem();
    if (!inventorySystem) {
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        "INVALID_REQUEST",
        undefined,
        undefined,
        zoneType,
      );
      return;
    }

    const inventory = inventorySystem.getInventory(playerId);
    if (!inventory) {
      this.emitLootResult(
        playerId,
        transactionId,
        false,
        corpseId,
        ownerId,
        "INVALID_REQUEST",
        undefined,
        undefined,
        zoneType,
      );
      return;
    }

    const maxSlots = INVENTORY_CONSTANTS.MAX_INVENTORY_SLOTS;
    let usedSlots = inventory.items.length;
    const existingItemIds = new Set(inventory.items.map((i) => i.itemId));

    const itemsToLoot: Array<{ itemId: string; quantity: number }> = [];

    for (const item of lootItems) {
      const itemDef = getItem(item.itemId);
      const canStack =
        itemDef?.stackable === true && existingItemIds.has(item.itemId);
      const hasSpace = usedSlots < maxSlots || canStack;

      if (!hasSpace) break;

      itemsToLoot.push({ itemId: item.itemId, quantity: item.quantity });

      if (!canStack) {
        usedSlots++;
        existingItemIds.add(item.itemId);
      }
    }

    // Snapshot item positions before mutations for rollback
    const preRemovalItems = entity.getLootItems();

    const successfullyLooted: Array<{ itemId: string; quantity: number }> = [];
    const batchTimestamp = Date.now();

    for (let i = 0; i < itemsToLoot.length; i++) {
      const item = itemsToLoot[i];
      const spaceCheck = this.checkInventorySpace(playerId, item.itemId);
      if (!spaceCheck.hasSpace) break;

      const originalIndex = preRemovalItems.findIndex(
        (pi) => pi.itemId === item.itemId,
      );

      const removed = entity.removeItem(item.itemId, item.quantity);
      if (!removed) continue;

      // Defensive re-check: if space disappeared after removal, rollback this item
      const recheck = this.checkInventorySpace(playerId, item.itemId);
      if (!recheck.hasSpace) {
        entity.restoreItem(
          item.itemId,
          item.quantity,
          originalIndex >= 0 ? originalIndex : 0,
        );
        break;
      }

      this.world.emit(EventType.INVENTORY_ITEM_ADDED, {
        playerId,
        item: {
          id: `loot_${playerId}_${batchTimestamp}_${i}_${item.itemId}`,
          itemId: item.itemId,
          quantity: item.quantity,
          slot: -1,
          metadata: null,
        },
      });
      successfullyLooted.push(item);
    }

    this.emitLootResult(
      playerId,
      transactionId,
      true,
      corpseId,
      ownerId,
      undefined,
      undefined,
      successfullyLooted.length,
      zoneType,
    );

    if (successfullyLooted.length > 0) {
      this.world.emit(EventType.AUDIT_LOG, {
        action: "LOOT_ALL_SUCCESS",
        playerId: ownerId,
        actorId: playerId,
        entityId: corpseId,
        items: successfullyLooted,
        zoneType,
        position: entity.getPosition(),
        success: true,
        transactionId,
        timestamp: Date.now(),
      });
    }
  }

  destroy(): void {
    this.lootQueues.clear();
    this.lootRateLimiter.clear();
    super.destroy();
  }
}
