/**
 * GroundItemSystem - Shared Ground Item Manager
 *
 * SystemBase wrapper around ground item functionality.
 * Registered as a world system so all systems share the same instance.
 *
 * This replaces multiple GroundItemManager instances (LootSystem, PlayerDeathSystem)
 * with a single shared system, eliminating the need for ID prefixes.
 *
 * Features:
 * - classic MMORPG-style tile-based piling
 * - Stackable item merging
 * - Tick-based despawn timers
 * - Loot protection
 * - O(1) tile lookups via spatial indexing
 *
 */

import type { World } from "../../../core/World";
import type { EntityManager } from "..";
import type { InventoryItem } from "../../../types/core/core";
import type {
  GroundItemOptions,
  GroundItemData,
  GroundItemPileData,
} from "../../../types/death";
import type {
  GroundItemSourceRegistrationReceipt,
  GroundItemSourceRegistrationRequest,
  GroundItemSourceState,
} from "../../../types/network/database";
import type { DatabaseSystem } from "../../../types/systems/system-interfaces";
import { EventType } from "../../../types/events";
import {
  EntityType,
  InteractionType,
  ItemRarity,
} from "../../../types/entities";
import { ItemType } from "../../../types/game/item-types";
import type { ItemEntityConfig } from "../../../types/entities";
import { groundToTerrain } from "../../../utils/game/EntityUtils";
import { getItem } from "../../../data/items";
import { isPositionInsideDuelArenaZone } from "../../../data/duel-manifest";
import { msToTicks, ticksToMs } from "../../../utils/game/CombatCalculations";
import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";
import { worldToTile, tileToWorld } from "../movement/TileSystem";
import { SystemBase } from "../infrastructure/SystemBase";
import {
  generateGroundItemSourceContributionId,
  generateGroundItemSourceEntityId,
} from "../../../utils/game/GroundItemSourceIdentity";
import { serializeGroundItemSourceRegistrationFingerprint } from "../../../utils/game/GroundItemSourceRegistration";

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

const MAX_PERSISTED_GROUND_ITEM_QUANTITY = 2_147_483_647;

type DurableGroundItemBatchPlanningResult =
  | { ok: true; requests: GroundItemSourceRegistrationRequest[] }
  | { ok: false; reason: string };

export type GroundItemCustodyStats = {
  durableHydrationStatus: "not_started" | "in_progress" | "complete" | "failed";
  hydrationAuthorityAvailable: boolean;
  expiryAuthorityAvailable: boolean;
  trackedItems: number;
  durableSources: number;
  pendingCustodyReconciliations: number;
  pendingPresentationHydrations: number;
  presentationHydrationsInFlight: number;
  maxPresentationHydrationAttempts: number;
  pendingDurableExpiries: number;
  durableExpiriesInFlight: number;
  maxDurableExpiryAttempts: number;
  pendingPresentationCleanups: number;
  maxPresentationCleanupAttempts: number;
};

export class GroundItemSystem extends SystemBase {
  private groundItems = new Map<string, GroundItemData>();
  private groundItemPiles = new Map<string, GroundItemPileData>();
  private entityManager: EntityManager | null = null;

  /** Pre-allocated buffer for tick processing (zero-allocation hot path) */
  private readonly _expiredItemsBuffer: string[] = [];

  /**
   * Logical custody removal can succeed before an entity-manager cleanup does.
   * Keep failed presentations quarantined and retry them instead of leaving an
   * interactive duplicate in the world indefinitely.
   */
  private pendingPresentationCleanup = new Map<
    string,
    { attempts: number; nextRetryTick: number }
  >();

  private pendingPresentationHydration = new Map<
    string,
    {
      source: GroundItemSourceState;
      attempts: number;
      nextRetryTick: number;
      inFlight: boolean;
    }
  >();
  private durableSourceIds = new Set<string>();
  private pendingDurableExpiry = new Map<
    string,
    { attempts: number; nextRetryTick: number; inFlight: boolean }
  >();
  private durableHydrationStatus: GroundItemCustodyStats["durableHydrationStatus"] =
    "not_started";
  private isDestroying = false;

  /**
   * Pickup locks to prevent concurrent pickup race condition
   * Key: entityId, Value: playerId who is currently picking up
   * Lock is held for the duration of the pickup operation
   */
  private pickupLocks = new Map<string, string>();

  /**
   * Pickup lock timeout (5 seconds) to prevent stuck locks
   * If a pickup doesn't complete within this time, the lock is auto-released
   */
  private pickupLockTimestamps = new Map<string, number>();
  private readonly PICKUP_LOCK_TIMEOUT_MS = 5000;

  /** classic MMORPG: Maximum items per tile */
  private readonly MAX_PILE_SIZE = 128;

  /** Server-wide ground item limit to prevent memory exhaustion */
  private readonly MAX_GLOBAL_ITEMS = 65536;

  constructor(world: World) {
    super(world, {
      name: "ground-items",
      dependencies: {
        required: ["entity-manager"],
        optional: [],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    this.entityManager =
      this.world.getSystem<EntityManager>("entity-manager") ?? null;
    if (!this.entityManager) {
      console.error(
        "[GroundItemSystem] EntityManager not found - ground items disabled",
      );
    }
  }

  /** Restore durable sources only after every server system has initialized. */
  async start(): Promise<void> {
    if (!this.world.isServer) {
      this.durableHydrationStatus = "complete";
      return;
    }
    const database = this.getDatabaseSystem();
    if (!database?.listActiveGroundItemSourcesAsync) {
      this.durableHydrationStatus = "failed";
      return;
    }
    this.durableHydrationStatus = "in_progress";
    try {
      const sources = await database.listActiveGroundItemSourcesAsync();
      for (const source of sources) {
        if (!this.isValidSourceState(source) || source.status !== "active") {
          throw new Error("ground_item_source_hydration_invalid");
        }
        if (!(await this.exposeSourcePresentation(source))) {
          this.queuePresentationHydration(source);
        }
      }
      this.durableHydrationStatus = "complete";
    } catch (error) {
      this.durableHydrationStatus = "failed";
      throw error;
    }
  }

  private getDatabaseSystem(): DatabaseSystem | undefined {
    return this.world.getSystem<DatabaseSystem>("database");
  }

  /**
   * Get tile key for Map lookup
   */
  private getTileKey(tile: { x: number; z: number }): string {
    return `${tile.x}_${tile.z}`;
  }

  private allocateGroundItemEntityId(reservedIds?: Set<string>): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const entityId = generateGroundItemSourceEntityId();
      if (
        !this.groundItems.has(entityId) &&
        !this.world.entities.get(entityId) &&
        !reservedIds?.has(entityId)
      ) {
        reservedIds?.add(entityId);
        return entityId;
      }
    }
    throw new Error("ground_item_secure_identity_collision");
  }

  private isDefinitiveSourceRegistrationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "ground_item_source_request_invalid",
      "ground_item_source_batch_invalid",
      "ground_item_source_batch_duplicate_contribution",
      "ground_item_source_contribution_id_conflict",
      "ground_item_source_quantity_overflow",
      "ground_item_source_lifetime_overflow",
      "ground_item_source_state_invalid",
    ].some((code) => message.includes(code));
  }

  private async createDurableSourceRequest(
    itemId: string,
    quantity: number,
    stackable: boolean,
    position: { x: number; y: number; z: number },
    tile: { x: number; z: number },
    droppedBy: string | null,
    lifetimeMs: number,
    lootProtectionMs: number,
    allowMerge: boolean,
    reservedSourceIds?: Set<string>,
  ): Promise<GroundItemSourceRegistrationRequest> {
    const input: Omit<
      GroundItemSourceRegistrationRequest,
      "requestFingerprint"
    > = {
      contributionId: generateGroundItemSourceContributionId(),
      preferredSourceId: this.allocateGroundItemEntityId(reservedSourceIds),
      itemId,
      quantity,
      stackable,
      position,
      tile,
      droppedBy,
      lifetimeMs,
      lootProtectionMs,
      allowMerge,
    };
    return {
      ...input,
      requestFingerprint: await sha256Hex(
        serializeGroundItemSourceRegistrationFingerprint(input),
      ),
    };
  }

  private validateSourceRegistrationReceipt(
    request: GroundItemSourceRegistrationRequest,
    receipt: GroundItemSourceRegistrationReceipt,
  ): void {
    if (
      receipt.contributionId !== request.contributionId ||
      receipt.requestFingerprint !== request.requestFingerprint ||
      receipt.itemId !== request.itemId ||
      receipt.stackable !== request.stackable ||
      receipt.quantity < request.quantity ||
      receipt.tile.x !== request.tile.x ||
      receipt.tile.z !== request.tile.z ||
      receipt.droppedBy !== request.droppedBy ||
      (!request.allowMerge && receipt.sourceId !== request.preferredSourceId) ||
      !this.isValidSourceState(receipt)
    ) {
      throw new Error("ground_item_source_registration_receipt_invalid");
    }
  }

  private async waitForSourceRegistrationRetry(
    attempts: number,
  ): Promise<void> {
    if (attempts <= 1) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(250 * 2 ** (attempts - 2), 5_000));
    });
  }

  /**
   * Get all items at a specific tile (O(1) lookup)
   * @param tile - Tile coordinates
   * @param outArray - Optional pre-allocated array to populate (avoids allocation)
   * @returns Array of ground items at tile
   */
  getItemsAtTile(
    tile: { x: number; z: number },
    outArray?: GroundItemData[],
  ): GroundItemData[] {
    const tileKey = this.getTileKey(tile);
    const pile = this.groundItemPiles.get(tileKey);

    if (outArray) {
      // Zero-allocation path: populate provided array
      outArray.length = 0;
      if (pile) {
        for (let i = 0; i < pile.items.length; i++) {
          outArray.push(pile.items[i]);
        }
      }
      return outArray;
    }

    // Allocation path: create new array (backwards compatible)
    return pile ? [...pile.items] : [];
  }

  /**
   * Get pile data at a specific tile
   */
  getPileAtTile(tile: { x: number; z: number }): GroundItemPileData | null {
    return this.groundItemPiles.get(this.getTileKey(tile)) || null;
  }

  /**
   * Update item visibility in pile (server sets property, syncs to client)
   */
  private setItemVisibility(entityId: string, visible: boolean): void {
    const entity = this.world.entities.get(entityId);
    if (entity) {
      entity.setProperty("visibleInPile", visible);
      if (typeof entity.markNetworkDirty === "function") {
        entity.markNetworkDirty();
      }
    }
  }

  private isValidSourceState(source: GroundItemSourceState): boolean {
    const item = getItem(source?.itemId);
    const expectedTile =
      source &&
      Number.isFinite(source.position?.x) &&
      Number.isFinite(source.position?.z)
        ? worldToTile(source.position.x, source.position.z)
        : null;
    return Boolean(
      source &&
      /^ground_item_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        source.sourceId,
      ) &&
      ["active", "claimed", "expired"].includes(source.status) &&
      item &&
      source.stackable === (item.stackable === true) &&
      Number.isSafeInteger(source.quantity) &&
      source.quantity > 0 &&
      Object.values(source.position).every(Number.isFinite) &&
      Number.isSafeInteger(source.tile.x) &&
      Number.isSafeInteger(source.tile.z) &&
      expectedTile?.x === source.tile.x &&
      expectedTile?.z === source.tile.z &&
      Number.isSafeInteger(source.createdAt) &&
      Number.isSafeInteger(source.updatedAt) &&
      Number.isSafeInteger(source.expiresAt) &&
      source.expiresAt > source.createdAt &&
      (source.lootProtectionExpiresAt === null ||
        (Number.isSafeInteger(source.lootProtectionExpiresAt) &&
          source.lootProtectionExpiresAt >= source.createdAt &&
          source.lootProtectionExpiresAt <= source.expiresAt)) &&
      Number.isSafeInteger(source.version) &&
      source.version >= 1,
    );
  }

  private async exposeSourcePresentation(
    source: GroundItemSourceState,
  ): Promise<boolean> {
    if (
      !this.entityManager ||
      !this.isValidSourceState(source) ||
      source.status !== "active" ||
      source.expiresAt <= Date.now()
    ) {
      return false;
    }
    const item = getItem(source.itemId)!;
    const existing = this.groundItems.get(source.sourceId);
    const existingEntity = this.world.entities.get(source.sourceId);
    const currentTick = this.world.currentTick ?? 0;
    const despawnTick =
      currentTick + Math.max(1, msToTicks(source.expiresAt - Date.now()));
    const lootProtectionTick =
      source.lootProtectionExpiresAt !== null &&
      source.lootProtectionExpiresAt > Date.now()
        ? currentTick +
          Math.max(1, msToTicks(source.lootProtectionExpiresAt - Date.now()))
        : undefined;

    if (existing && existingEntity) {
      existing.quantity = source.quantity;
      existing.despawnTick = despawnTick;
      existing.droppedBy = source.droppedBy ?? undefined;
      existing.lootProtectionTick = lootProtectionTick;
      existingEntity.setProperty("quantity", source.quantity);
      existingEntity.setProperty("custodyPolicy", "durable_ground");
      existingEntity.setProperty("custodySourceId", source.sourceId);
      existingEntity.setProperty("interactable", true);
      if (typeof existingEntity.markNetworkDirty === "function") {
        existingEntity.markNetworkDirty();
      }
      this.durableSourceIds.add(source.sourceId);
      this.pendingPresentationHydration.delete(source.sourceId);
      return true;
    }
    if (existing || existingEntity) {
      throw new Error("ground_item_source_presentation_identity_collision");
    }

    const itemEntity = await this.entityManager.spawnEntity({
      id: source.sourceId,
      name: item.name,
      type: EntityType.ITEM,
      position: source.position,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: true,
      interactionType: InteractionType.PICKUP,
      interactionDistance: 2,
      description: item.description || "",
      model: item.modelPath || null,
      itemId: item.id,
      itemType: this.getItemTypeString(item.type),
      quantity: source.quantity,
      stackable: source.stackable,
      value: item.value ?? 0,
      weight: item.weight || 1.0,
      rarity: item.rarity || ItemRarity.COMMON,
      stats: {},
      requirements: { level: 1 },
      effects: [],
      armorSlot: null,
      examine: item.examine || "",
      modelPath: item.modelPath || "",
      iconPath: item.iconPath || "",
      healAmount: item.healAmount || 0,
      modelScale: item.modelScale,
      groundOffset: item.groundOffset,
      properties: {
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        health: { current: 1, max: 1 },
        level: 1,
        itemId: item.id,
        custodyPolicy: "durable_ground",
        harvestable: false,
        dialogue: [],
        quantity: source.quantity,
        custodySourceId: source.sourceId,
        stackable: source.stackable,
        value: item.value ?? 0,
        weight: item.weight || 1.0,
        rarity: item.rarity,
        visibleInPile: true,
      },
    } as ItemEntityConfig);
    if (!itemEntity) return false;

    const groundItemData: GroundItemData = {
      entityId: source.sourceId,
      itemId: source.itemId,
      quantity: source.quantity,
      position: source.position,
      despawnTick,
      droppedBy: source.droppedBy ?? undefined,
      lootProtectionTick,
      spawnedAt: source.createdAt,
    };
    this.groundItems.set(source.sourceId, groundItemData);
    const tileKey = this.getTileKey(source.tile);
    const pile = this.groundItemPiles.get(tileKey);
    if (pile) {
      this.setItemVisibility(pile.topItemEntityId, false);
      pile.items.unshift(groundItemData);
      pile.topItemEntityId = source.sourceId;
    } else {
      this.groundItemPiles.set(tileKey, {
        tileKey,
        tile: source.tile,
        items: [groundItemData],
        topItemEntityId: source.sourceId,
      });
    }
    this.durableSourceIds.add(source.sourceId);
    this.pendingPresentationHydration.delete(source.sourceId);
    return true;
  }

  private queuePresentationHydration(source: GroundItemSourceState): void {
    const existing = this.pendingPresentationHydration.get(source.sourceId);
    if (
      existing &&
      (existing.source.version > source.version ||
        (existing.source.version === source.version &&
          existing.source.updatedAt >= source.updatedAt))
    ) {
      return;
    }
    const attempts = existing?.attempts ?? 0;
    this.pendingPresentationHydration.set(source.sourceId, {
      source,
      attempts,
      nextRetryTick: (this.world.currentTick ?? 0) + 1,
      inFlight: false,
    });
  }

  private processPendingPresentationHydration(currentTick: number): void {
    for (const [sourceId, pending] of this.pendingPresentationHydration) {
      if (pending.inFlight || currentTick < pending.nextRetryTick) continue;
      if (pending.source.expiresAt <= Date.now()) {
        this.pendingPresentationHydration.delete(sourceId);
        this.beginDurableSourceExpiry(sourceId, currentTick);
        continue;
      }
      pending.inFlight = true;
      void this.exposeSourcePresentation(pending.source)
        .then((presented) => {
          if (presented) {
            this.pendingPresentationHydration.delete(sourceId);
            return;
          }
          const attempts = pending.attempts + 1;
          pending.attempts = attempts;
          pending.inFlight = false;
          pending.nextRetryTick =
            currentTick + Math.min(2 ** Math.min(attempts - 1, 6), 64);
        })
        .catch((error) => {
          const attempts = pending.attempts + 1;
          pending.attempts = attempts;
          pending.inFlight = false;
          pending.nextRetryTick =
            currentTick + Math.min(2 ** Math.min(attempts - 1, 6), 64);
          if (attempts === 1 || (attempts & (attempts - 1)) === 0) {
            console.error(
              `[GroundItemSystem] Durable source presentation pending for ${sourceId}: ${String(error)}`,
            );
          }
        });
    }
  }

  private async registerDurableSource(
    itemId: string,
    quantity: number,
    stackable: boolean,
    position: { x: number; y: number; z: number },
    tile: { x: number; z: number },
    droppedBy: string | null,
    lifetimeMs: number,
    lootProtectionMs: number,
    allowMerge: boolean,
  ): Promise<GroundItemSourceRegistrationReceipt | null> {
    const database = this.getDatabaseSystem();
    if (!database?.registerGroundItemSourceAsync) return null;
    const request = await this.createDurableSourceRequest(
      itemId,
      quantity,
      stackable,
      position,
      tile,
      droppedBy,
      lifetimeMs,
      lootProtectionMs,
      allowMerge,
    );
    let receipt: GroundItemSourceRegistrationReceipt | null = null;
    let attempts = 0;
    while (!receipt && !this.isDestroying) {
      attempts++;
      try {
        receipt = await database.registerGroundItemSourceAsync(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.isDefinitiveSourceRegistrationError(error)) throw error;
        if (attempts === 1 || (attempts & (attempts - 1)) === 0) {
          console.error(
            `[GroundItemSystem] Durable source registration pending for ${itemId} after ${attempts} attempt(s): ${message}`,
          );
        }
        await this.waitForSourceRegistrationRetry(attempts);
      }
    }
    if (!receipt) throw new Error("ground_item_source_registration_cancelled");
    this.validateSourceRegistrationReceipt(request, receipt);
    return receipt;
  }

  private async registerDurableSourceBatch(
    requests: GroundItemSourceRegistrationRequest[],
  ): Promise<GroundItemSourceRegistrationReceipt[]> {
    const database = this.getDatabaseSystem();
    if (!database?.registerGroundItemSourcesAsync) {
      throw new Error("ground_item_source_batch_authority_unavailable");
    }
    let receipts: GroundItemSourceRegistrationReceipt[] | null = null;
    let attempts = 0;
    while (!receipts && !this.isDestroying) {
      attempts++;
      try {
        receipts = await database.registerGroundItemSourcesAsync(requests);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.isDefinitiveSourceRegistrationError(error)) throw error;
        if (attempts === 1 || (attempts & (attempts - 1)) === 0) {
          console.error(
            `[GroundItemSystem] Durable source batch registration pending after ${attempts} attempt(s): ${message}`,
          );
        }
        await this.waitForSourceRegistrationRetry(attempts);
      }
    }
    if (!receipts) {
      throw new Error("ground_item_source_batch_registration_cancelled");
    }
    if (receipts.length !== requests.length) {
      throw new Error("ground_item_source_batch_receipt_invalid");
    }
    for (let index = 0; index < requests.length; index++) {
      this.validateSourceRegistrationReceipt(requests[index], receipts[index]);
    }
    return receipts;
  }

  /**
   * Freeze one source request without changing custody or presentation. This is
   * used by operations that co-commit an upstream debit with source creation.
   */
  async prepareDurableSourceRegistration(
    itemId: string,
    quantity: number,
    position: { x: number; y: number; z: number },
    options: GroundItemOptions,
  ): Promise<GroundItemSourceRegistrationRequest | null> {
    if (
      !this.world.isServer ||
      !this.entityManager ||
      !Object.values(position).every(Number.isFinite) ||
      isPositionInsideDuelArenaZone(position.x, position.z) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_GROUND_ITEM_QUANTITY ||
      !Number.isFinite(options.despawnTime) ||
      options.despawnTime <= 0 ||
      (options.lootProtection !== undefined &&
        (!Number.isFinite(options.lootProtection) ||
          options.lootProtection < 0))
    ) {
      return null;
    }
    const item = getItem(itemId);
    if (!item) return null;
    const currentTick = this.world.currentTick ?? 0;
    const despawnTicks =
      item.tradeable === false
        ? COMBAT_CONSTANTS.UNTRADEABLE_DESPAWN_TICKS
        : msToTicks(options.despawnTime);
    const lootProtectionTicks = options.lootProtection
      ? msToTicks(options.lootProtection)
      : 0;
    const lifetimeMs = ticksToMs(despawnTicks);
    const lootProtectionMs = ticksToMs(lootProtectionTicks);
    if (
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs <= 0 ||
      !Number.isSafeInteger(lootProtectionMs) ||
      lootProtectionMs < 0 ||
      lootProtectionMs > lifetimeMs
    ) {
      return null;
    }

    const tile = worldToTile(position.x, position.z);
    const tileKey = this.getTileKey(tile);
    const tileCenter = tileToWorld(tile);
    const groundedPosition = groundToTerrain(
      this.world,
      { x: tileCenter.x, y: position.y, z: tileCenter.z },
      0.2,
      Infinity,
    );
    if (!Object.values(groundedPosition).every(Number.isFinite)) return null;

    const droppedBy = options.droppedBy?.trim() || null;
    const hasLootProtection = lootProtectionTicks > 0;
    const existingPile = this.groundItemPiles.get(tileKey);
    const compatibleDurableStack =
      item.stackable && existingPile
        ? existingPile.items.find(
            (pileItem) =>
              this.durableSourceIds.has(pileItem.entityId) &&
              pileItem.itemId === item.id &&
              !this.pickupLocks.has(pileItem.entityId) &&
              (pileItem.droppedBy?.trim() || null) === droppedBy &&
              (hasLootProtection
                ? pileItem.lootProtectionTick !== undefined
                : pileItem.lootProtectionTick === undefined ||
                  pileItem.lootProtectionTick <= currentTick),
          )
        : undefined;
    if (
      this.groundItems.size >= this.MAX_GLOBAL_ITEMS &&
      !compatibleDurableStack
    ) {
      return null;
    }
    if (
      existingPile &&
      existingPile.items.length >= this.MAX_PILE_SIZE &&
      !compatibleDurableStack
    ) {
      return null;
    }
    return this.createDurableSourceRequest(
      item.id,
      quantity,
      item.stackable === true,
      groundedPosition,
      tile,
      droppedBy,
      lifetimeMs,
      lootProtectionMs,
      Boolean(compatibleDurableStack),
    );
  }

  /** Expose committed truth or retain it for bounded presentation retry. */
  async exposeCommittedDurableSource(
    source: GroundItemSourceRegistrationReceipt,
  ): Promise<boolean> {
    if (!this.isValidSourceState(source)) {
      throw new Error("ground_item_source_registration_receipt_invalid");
    }
    if (source.status !== "active") return true;
    try {
      if (await this.exposeSourcePresentation(source)) return true;
    } catch (error) {
      console.error(
        `[GroundItemSystem] Committed source ${source.sourceId} presentation pending: ${String(error)}`,
      );
    }
    this.queuePresentationHydration(source);
    return false;
  }

  private rejectGroundItemBatch(
    reason: string,
    throwOnFailure: boolean,
  ): string[] {
    console.error(`[GroundItemSystem] ${reason}`);
    if (throwOnFailure) throw new Error(reason);
    return [];
  }

  private async planDurableGroundItemBatch(
    items: InventoryItem[],
    position: { x: number; y: number; z: number },
    options: GroundItemOptions,
  ): Promise<DurableGroundItemBatchPlanningResult> {
    if (!this.world.isServer) {
      return {
        ok: false,
        reason: "Client attempted server-only durable ground-item batch",
      };
    }
    if (!this.entityManager) {
      return {
        ok: false,
        reason: "EntityManager not available for durable batch",
      };
    }
    if (items.length === 0) return { ok: true, requests: [] };
    if (items.length > 128) {
      return {
        ok: false,
        reason: `Durable ground-item batch exceeds the 128-contribution limit (${items.length})`,
      };
    }
    if (
      !Object.values(position).every(Number.isFinite) ||
      !Number.isFinite(options.despawnTime) ||
      options.despawnTime <= 0 ||
      (options.lootProtection !== undefined &&
        (!Number.isFinite(options.lootProtection) ||
          options.lootProtection < 0)) ||
      (options.scatterRadius !== undefined &&
        (!Number.isFinite(options.scatterRadius) || options.scatterRadius < 0))
    ) {
      return {
        ok: false,
        reason:
          "Durable ground-item batch has invalid position or lifetime options",
      };
    }

    const currentTick = this.world.currentTick ?? 0;
    const droppedBy = options.droppedBy?.trim() || null;
    const lootProtectionTicks = options.lootProtection
      ? msToTicks(options.lootProtection)
      : 0;
    const lootProtectionMs = ticksToMs(lootProtectionTicks);
    const hasLootProtection = lootProtectionTicks > 0;
    const reservedSourceIds = new Set<string>();
    const plannedMergeGroups = new Set<string>();
    const requests: GroundItemSourceRegistrationRequest[] = [];
    const newPresentationsByTile = new Map<string, number>();

    for (let index = 0; index < items.length; index++) {
      const inventoryItem = items[index];
      const item = getItem(inventoryItem.itemId);
      if (
        !item ||
        !Number.isSafeInteger(inventoryItem.quantity) ||
        inventoryItem.quantity <= 0 ||
        inventoryItem.quantity > MAX_PERSISTED_GROUND_ITEM_QUANTITY
      ) {
        return {
          ok: false,
          reason: `Durable ground-item batch has invalid item at index ${index}`,
        };
      }

      let requestedPosition = { ...position };
      if (options.scatter) {
        const radius = options.scatterRadius || 2.0;
        requestedPosition = {
          x: position.x + (Math.random() - 0.5) * radius,
          y: position.y,
          z: position.z + (Math.random() - 0.5) * radius,
        };
      }
      if (
        !Object.values(requestedPosition).every(Number.isFinite) ||
        isPositionInsideDuelArenaZone(requestedPosition.x, requestedPosition.z)
      ) {
        return {
          ok: false,
          reason: `Durable ground-item batch has a forbidden position at index ${index}`,
        };
      }

      const tile = worldToTile(requestedPosition.x, requestedPosition.z);
      const tileKey = this.getTileKey(tile);
      const tileCenter = tileToWorld(tile);
      const groundedPosition = groundToTerrain(
        this.world,
        {
          x: tileCenter.x,
          y: requestedPosition.y,
          z: tileCenter.z,
        },
        0.2,
        Infinity,
      );
      const despawnTicks =
        item.tradeable === false
          ? COMBAT_CONSTANTS.UNTRADEABLE_DESPAWN_TICKS
          : msToTicks(options.despawnTime);
      const lifetimeMs = ticksToMs(despawnTicks);
      if (
        !Object.values(groundedPosition).every(Number.isFinite) ||
        !Number.isSafeInteger(lifetimeMs) ||
        lifetimeMs <= 0 ||
        !Number.isSafeInteger(lootProtectionMs) ||
        lootProtectionMs < 0 ||
        lootProtectionMs > lifetimeMs
      ) {
        return {
          ok: false,
          reason: `Durable ground-item batch has invalid grounded state at index ${index}`,
        };
      }

      const stackable = item.stackable === true;
      const mergeGroup = stackable
        ? JSON.stringify([
            tile.x,
            tile.z,
            item.id,
            droppedBy,
            hasLootProtection,
          ])
        : JSON.stringify([tile.x, tile.z, item.id, index]);
      const groupAlreadyPlanned = plannedMergeGroups.has(mergeGroup);
      const existingPile = this.groundItemPiles.get(tileKey);
      const compatibleDurableStack =
        stackable && existingPile
          ? existingPile.items.find(
              (pileItem) =>
                this.durableSourceIds.has(pileItem.entityId) &&
                pileItem.itemId === item.id &&
                !this.pickupLocks.has(pileItem.entityId) &&
                (pileItem.droppedBy?.trim() || null) === droppedBy &&
                (hasLootProtection
                  ? pileItem.lootProtectionTick !== undefined
                  : pileItem.lootProtectionTick === undefined ||
                    pileItem.lootProtectionTick <= currentTick),
            )
          : undefined;
      const createsPresentation = !groupAlreadyPlanned;
      if (createsPresentation) {
        plannedMergeGroups.add(mergeGroup);
        newPresentationsByTile.set(
          tileKey,
          (newPresentationsByTile.get(tileKey) ?? 0) + 1,
        );
      }
      requests.push(
        await this.createDurableSourceRequest(
          item.id,
          inventoryItem.quantity,
          stackable,
          groundedPosition,
          tile,
          droppedBy,
          lifetimeMs,
          lootProtectionMs,
          Boolean(compatibleDurableStack) || groupAlreadyPlanned,
          reservedSourceIds,
        ),
      );
    }

    const plannedPresentationCount = [
      ...newPresentationsByTile.values(),
    ].reduce((total, count) => total + count, 0);
    if (
      this.groundItems.size + plannedPresentationCount >
      this.MAX_GLOBAL_ITEMS
    ) {
      return {
        ok: false,
        reason: `Durable ground-item batch would exceed the global item limit (${this.MAX_GLOBAL_ITEMS})`,
      };
    }
    for (const [tileKey, count] of newPresentationsByTile) {
      const existingCount =
        this.groundItemPiles.get(tileKey)?.items.length ?? 0;
      if (existingCount + count > this.MAX_PILE_SIZE) {
        return {
          ok: false,
          reason: `Durable ground-item batch would exceed the pile limit at ${tileKey}`,
        };
      }
    }

    return { ok: true, requests };
  }

  /**
   * Freeze a full scatter/merge/source plan without changing custody. Death and
   * other upstream operations use this to include every source in one database
   * transaction before any presentation becomes interactable.
   */
  async prepareDurableSourceBatchRegistration(
    items: InventoryItem[],
    position: { x: number; y: number; z: number },
    options: GroundItemOptions,
  ): Promise<GroundItemSourceRegistrationRequest[] | null> {
    const plan = await this.planDurableGroundItemBatch(
      items,
      position,
      options,
    );
    if (!plan.ok) {
      console.error(`[GroundItemSystem] ${plan.reason}`);
      return null;
    }
    return plan.requests;
  }

  private async spawnDurableGroundItemBatch(
    items: InventoryItem[],
    position: { x: number; y: number; z: number },
    options: GroundItemOptions,
    throwOnFailure: boolean,
  ): Promise<string[]> {
    const plan = await this.planDurableGroundItemBatch(
      items,
      position,
      options,
    );
    if (!plan.ok) {
      return this.rejectGroundItemBatch(plan.reason, throwOnFailure);
    }
    if (plan.requests.length === 0) return [];

    const receipts = await this.registerDurableSourceBatch(plan.requests);
    for (const receipt of receipts) {
      if (receipt.status !== "active") continue;
      try {
        if (!(await this.exposeSourcePresentation(receipt))) {
          this.queuePresentationHydration(receipt);
        }
      } catch (error) {
        this.queuePresentationHydration(receipt);
        console.error(
          `[GroundItemSystem] Durable batch source ${receipt.sourceId} committed but presentation is pending: ${String(error)}`,
        );
      }
    }
    const entityIds = receipts.map((receipt) => receipt.sourceId);
    console.log(
      `[GroundItemSystem] Committed ${receipts.length} durable ground-item contributions as ${new Set(entityIds).size} source(s) at (${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)})`,
    );
    return entityIds;
  }

  /**
   * Spawn a single ground item (TICK-BASED despawn)
   * Options accept ms for backwards compatibility, converted to ticks internally
   * Items are snapped to tile centers and managed in piles (classic MMORPG-style stacking)
   */
  async spawnGroundItem(
    itemId: string,
    quantity: number,
    position: { x: number; y: number; z: number },
    options: GroundItemOptions,
  ): Promise<string> {
    // CRITICAL: Server authority check - prevent client from spawning arbitrary items
    if (!this.world.isServer) {
      console.error(
        `[GroundItemSystem] ⚠️  Client attempted server-only ground item spawn - BLOCKED`,
      );
      return "";
    }

    if (!this.entityManager) {
      console.error("[GroundItemSystem] EntityManager not available");
      return "";
    }

    if (
      !Object.values(position).every(Number.isFinite) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_PERSISTED_GROUND_ITEM_QUANTITY ||
      !Number.isFinite(options.despawnTime) ||
      options.despawnTime <= 0 ||
      (options.lootProtection !== undefined &&
        (!Number.isFinite(options.lootProtection) ||
          options.lootProtection < 0))
    ) {
      console.error("[GroundItemSystem] Refusing invalid ground-item source");
      return "";
    }

    if (isPositionInsideDuelArenaZone(position.x, position.z)) {
      return "";
    }

    // Global ground item limit - prevent memory exhaustion attacks
    if (this.groundItems.size >= this.MAX_GLOBAL_ITEMS) {
      console.warn(
        `[GroundItemSystem] Global item limit reached (${this.MAX_GLOBAL_ITEMS}), rejecting spawn`,
      );
      return "";
    }

    const item = getItem(itemId);
    if (!item) {
      console.warn(`[GroundItemSystem] Unknown item: ${itemId}`);
      return "";
    }

    const currentTick = this.world.currentTick ?? 0;

    // classic MMORPG: Untradeable items ALWAYS despawn in 3 min, tradeable uses caller's time
    // This overrides caller's despawnTime for untradeable items (rules-accurate behavior)
    const despawnTicks =
      item.tradeable === false
        ? COMBAT_CONSTANTS.UNTRADEABLE_DESPAWN_TICKS // 300 ticks = 3 min (forced)
        : msToTicks(options.despawnTime); // Use caller's value

    const lootProtectionTicks = options.lootProtection
      ? msToTicks(options.lootProtection)
      : 0;

    // classic MMORPG-STYLE: Snap position to tile center
    const tile = worldToTile(position.x, position.z);
    const tileKey = this.getTileKey(tile);
    const tileCenter = tileToWorld(tile);

    // Ground the tile center position to terrain
    const groundedPosition = groundToTerrain(
      this.world,
      { x: tileCenter.x, y: position.y, z: tileCenter.z },
      0.2,
      Infinity,
    );

    // Check for existing pile at this tile
    const existingPile = this.groundItemPiles.get(tileKey);
    const normalizedDroppedBy = options.droppedBy?.trim() || null;
    const hasLootProtection = lootProtectionTicks > 0;
    const compatibleUnlockedStack =
      item.stackable && existingPile
        ? existingPile.items.find(
            (pileItem) =>
              this.durableSourceIds.has(pileItem.entityId) &&
              pileItem.itemId === itemId &&
              !this.pickupLocks.has(pileItem.entityId) &&
              (pileItem.droppedBy?.trim() || null) === normalizedDroppedBy &&
              (hasLootProtection
                ? pileItem.lootProtectionTick !== undefined
                : pileItem.lootProtectionTick === undefined ||
                  pileItem.lootProtectionTick <= currentTick),
          )
        : undefined;
    const database = this.getDatabaseSystem();
    if (database && !database.registerGroundItemSourceAsync) {
      console.error(
        "[GroundItemSystem] Refusing claimable presentation: durable source authority is incomplete",
      );
      return "";
    }
    if (database?.registerGroundItemSourceAsync) {
      if (
        existingPile &&
        existingPile.items.length >= this.MAX_PILE_SIZE &&
        !compatibleUnlockedStack
      ) {
        console.warn(
          `[GroundItemSystem] Durable pile full at (${tile.x}, ${tile.z}); rejecting source instead of discarding custody`,
        );
        return "";
      }
      const receipt = await this.registerDurableSource(
        itemId,
        quantity,
        item.stackable === true,
        groundedPosition,
        tile,
        normalizedDroppedBy,
        ticksToMs(despawnTicks),
        ticksToMs(lootProtectionTicks),
        Boolean(compatibleUnlockedStack),
      );
      if (!receipt) return "";
      if (receipt.status === "active") {
        if (!(await this.exposeSourcePresentation(receipt))) {
          this.queuePresentationHydration(receipt);
        }
      }
      return receipt.sourceId;
    }

    // classic MMORPG-STYLE: Check pile size limit (max 128 items per tile)
    // If full, remove oldest item (bottom of pile) to make room
    if (existingPile && existingPile.items.length >= this.MAX_PILE_SIZE) {
      this.cleanupStaleLocks();
      const oldestUnlockedItem = [...existingPile.items]
        .reverse()
        .find((pileItem) => !this.pickupLocks.has(pileItem.entityId));
      if (!oldestUnlockedItem) {
        console.warn(
          `[GroundItemSystem] Pile full at (${tile.x}, ${tile.z}) with every source in custody transfer; rejecting spawn`,
        );
        return "";
      }
      const oldestItem = oldestUnlockedItem;
      if (oldestItem) {
        this.removeGroundItem(oldestItem.entityId);
        console.log(
          `[GroundItemSystem] Pile full at (${tile.x}, ${tile.z}), removed oldest item ${oldestItem.entityId}`,
        );
      }
    }

    // classic MMORPG-STYLE: If stackable, try to merge with existing item of same type
    if (item.stackable && existingPile) {
      const existingStackItem = existingPile.items.find(
        (pileItem) =>
          pileItem.itemId === itemId &&
          !this.pickupLocks.has(pileItem.entityId) &&
          // Only merge if both have no loot protection or same owner
          (!pileItem.lootProtectionTick ||
            pileItem.droppedBy === options.droppedBy),
      );

      if (existingStackItem) {
        // Merge quantities - update existing entity, don't create new one
        const newQuantity = existingStackItem.quantity + quantity;
        if (
          !Number.isSafeInteger(newQuantity) ||
          newQuantity > MAX_PERSISTED_GROUND_ITEM_QUANTITY
        ) {
          console.error(
            "[GroundItemSystem] Refusing ground-item stack quantity overflow",
          );
          return "";
        }
        existingStackItem.quantity = newQuantity;

        // Extend despawn timer to the newer drop's timer
        existingStackItem.despawnTick = currentTick + despawnTicks;

        // Update entity properties
        const existingEntity = this.world.entities.get(
          existingStackItem.entityId,
        );
        if (existingEntity) {
          existingEntity.setProperty("quantity", newQuantity);
          existingEntity.name = item.name; // Quantity tracked as property
          if (typeof existingEntity.markNetworkDirty === "function") {
            existingEntity.markNetworkDirty();
          }
        }

        console.log(
          `[GroundItemSystem] Merged stackable item ${itemId} x${quantity} into existing stack (now x${newQuantity}) at tile (${tile.x}, ${tile.z})`,
        );

        return existingStackItem.entityId;
      }
    }

    // The source identity is persisted in pickup receipts, so it must remain
    // collision-resistant across process and host replacement.
    const dropId = this.allocateGroundItemEntityId();

    const itemEntity = await this.entityManager.spawnEntity({
      id: dropId,
      name: item.name, // Quantity tracked as property, not in name
      type: EntityType.ITEM,
      position: groundedPosition,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: true,
      interactionType: InteractionType.PICKUP,
      interactionDistance: 2,
      description: item.description || "",
      model: item.modelPath || null,
      itemId: item.id,
      itemType: this.getItemTypeString(item.type),
      quantity: quantity,
      stackable: item.stackable ?? false,
      value: item.value ?? 0,
      weight: item.weight || 1.0,
      rarity: item.rarity || ItemRarity.COMMON,
      stats: {},
      requirements: { level: 1 },
      effects: [],
      armorSlot: null,
      examine: item.examine || "",
      modelPath: item.modelPath || "",
      iconPath: item.iconPath || "",
      healAmount: item.healAmount || 0,
      modelScale: item.modelScale,
      groundOffset: item.groundOffset,
      properties: {
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        health: { current: 1, max: 1 },
        level: 1,
        itemId: item.id,
        custodyPolicy: "diagnostic_only",
        harvestable: false,
        dialogue: [],
        quantity: quantity,
        custodySourceId: dropId,
        stackable: item.stackable ?? false,
        value: item.value ?? 0,
        weight: item.weight || 1.0,
        rarity: item.rarity,
        visibleInPile: true, // New item is visible (will be top of pile)
      },
    } as ItemEntityConfig);

    if (!itemEntity) {
      console.error(`[GroundItemSystem] Failed to spawn item: ${itemId}`);
      return "";
    }

    // Track ground item (TICK-BASED)
    const groundItemData: GroundItemData = {
      entityId: dropId,
      itemId: itemId,
      quantity: quantity,
      position: groundedPosition,
      despawnTick: currentTick + despawnTicks,
      droppedBy: options.droppedBy,
      lootProtectionTick:
        lootProtectionTicks > 0 ? currentTick + lootProtectionTicks : undefined,
      spawnedAt: Date.now(),
    };

    this.groundItems.set(dropId, groundItemData);

    // classic MMORPG-STYLE: Manage pile - hide previous top item, add new item to pile
    if (existingPile) {
      // Hide the current top item
      this.setItemVisibility(existingPile.topItemEntityId, false);

      // Add new item to front of pile (newest first)
      existingPile.items.unshift(groundItemData);
      existingPile.topItemEntityId = dropId;
    } else {
      // Create new pile
      const newPile: GroundItemPileData = {
        tileKey,
        tile,
        items: [groundItemData],
        topItemEntityId: dropId,
      };
      this.groundItemPiles.set(tileKey, newPile);
    }

    console.log(
      `[GroundItemSystem] Spawned ground item ${dropId} (${itemId} x${quantity}) at tile (${tile.x}, ${tile.z})`,
      {
        despawnTick: groundItemData.despawnTick,
        despawnIn: `${despawnTicks} ticks (${(ticksToMs(despawnTicks) / 1000).toFixed(1)}s)`,
        lootProtectionTick: groundItemData.lootProtectionTick,
        pileSize: existingPile ? existingPile.items.length : 1,
      },
    );

    return dropId;
  }

  /**
   * Spawn multiple ground items (from player death or mob loot)
   */
  /**
   * Spawn multiple ground items at a position (batch operation)
   *
   * Durable sources are registered in one database transaction before any
   * presentation is exposed. The database commit is never "rolled back" by
   * deleting presentation entities. The legacy database-less path retains its
   * process-local rollback behavior for tests and development worlds.
   *
   * @param items - Array of inventory items to spawn
   * @param position - Base position for spawning
   * @param options - Ground item options (despawn time, scatter, etc.)
   * @param throwOnFailure - If true, throw error on any failure (for transaction rollback)
   * @returns Array of spawned entity IDs (empty if any spawn failed)
   */
  async spawnGroundItems(
    items: InventoryItem[],
    position: { x: number; y: number; z: number },
    options: GroundItemOptions,
    throwOnFailure = false,
  ): Promise<string[]> {
    // CRITICAL: Server authority check - prevent client from mass-spawning items
    if (!this.world.isServer) {
      console.error(
        `[GroundItemSystem] ⚠️  Client attempted server-only ground items spawn - BLOCKED`,
      );
      return [];
    }

    const database = this.getDatabaseSystem();
    if (
      database?.registerGroundItemSourceAsync ||
      database?.registerGroundItemSourcesAsync
    ) {
      if (
        !database.registerGroundItemSourceAsync ||
        !database.registerGroundItemSourcesAsync
      ) {
        return this.rejectGroundItemBatch(
          "Durable ground-item batch authority is incomplete",
          throwOnFailure,
        );
      }
      return this.spawnDurableGroundItemBatch(
        items,
        position,
        options,
        throwOnFailure,
      );
    }

    const entityIds: string[] = [];
    let failedIndex = -1;
    let failedItem: InventoryItem | null = null;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Calculate scatter position
      let itemPosition = { ...position };
      if (options.scatter) {
        const radius = options.scatterRadius || 2.0;
        const offsetX = (Math.random() - 0.5) * radius;
        const offsetZ = (Math.random() - 0.5) * radius;
        itemPosition = {
          x: position.x + offsetX,
          y: position.y,
          z: position.z + offsetZ,
        };
      }

      const entityId = await this.spawnGroundItem(
        item.itemId,
        item.quantity,
        itemPosition,
        options,
      );

      if (entityId) {
        entityIds.push(entityId);
      } else {
        // Track failure for rollback
        failedIndex = i;
        failedItem = item;
        break; // Stop spawning on first failure
      }
    }

    // Rollback all spawned items if ANY spawn failed
    if (failedIndex >= 0) {
      console.error(
        `[GroundItemSystem] Batch spawn failed at index ${failedIndex} (${failedItem?.itemId}). Rolling back ${entityIds.length} spawned items.`,
      );

      // Clean up all previously spawned items
      for (const entityId of entityIds) {
        this.removeGroundItem(entityId);
      }

      // Throw error for transaction rollback if requested
      if (throwOnFailure) {
        throw new Error(
          `Failed to spawn ground item ${failedItem?.itemId} at index ${failedIndex}`,
        );
      }

      return []; // Return empty to indicate failure
    }

    console.log(
      `[GroundItemSystem] Spawned ${entityIds.length} ground items at (${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)})`,
    );

    return entityIds;
  }

  /**
   * Rollback spawned ground items (for transaction failure cleanup)
   *
   * Removes all ground items with the given IDs. Call this if a transaction
   * fails after ground items were already spawned.
   *
   * @param entityIds - Array of entity IDs to remove
   * @returns Number of items successfully removed
   */
  rollbackGroundItems(entityIds: string[]): number {
    let removedCount = 0;
    for (const entityId of entityIds) {
      if (this.removeGroundItem(entityId)) {
        removedCount++;
      }
    }
    console.log(
      `[GroundItemSystem] Rolled back ${removedCount}/${entityIds.length} ground items`,
    );
    return removedCount;
  }

  /**
   * Process tick - check for expired items (TICK-BASED)
   * Called once per tick by TickSystem
   *
   * @param currentTick - Current server tick number
   */
  processTick(currentTick: number): void {
    this.cleanupStaleLocks();
    this.processPendingPresentationCleanup(currentTick);
    this.processPendingPresentationHydration(currentTick);
    this.processPendingDurableExpiries(currentTick);
    // ZERO-ALLOCATION: Reuse buffer, clear via length instead of new array
    this._expiredItemsBuffer.length = 0;

    for (const [itemId, itemData] of this.groundItems) {
      if (
        currentTick >= itemData.despawnTick &&
        !this.pickupLocks.has(itemId)
      ) {
        this._expiredItemsBuffer.push(itemId);
      }
    }

    // Process from buffer (use indexed loop for performance)
    for (let i = 0; i < this._expiredItemsBuffer.length; i++) {
      this.handleItemExpire(this._expiredItemsBuffer[i], currentTick);
    }
  }

  /**
   * Handle item expiration (TICK-BASED)
   */
  private handleItemExpire(itemId: string, currentTick: number): void {
    const itemData = this.groundItems.get(itemId);
    if (!itemData) return;

    if (this.durableSourceIds.has(itemId)) {
      this.beginDurableSourceExpiry(itemId, currentTick);
      return;
    }

    const ticksExisted =
      currentTick -
      (itemData.despawnTick - COMBAT_CONSTANTS.GROUND_ITEM_DESPAWN_TICKS);

    console.log(
      `[GroundItemSystem] Item ${itemId} (${itemData.itemId}) despawning after ${ticksExisted} ticks (${(ticksToMs(ticksExisted) / 1000).toFixed(1)}s)`,
    );

    // Remove from world
    this.removeGroundItem(itemId);

    // Emit event
    this.emitTypedEvent(EventType.ITEM_DESPAWNED, {
      itemId: itemId,
      itemType: itemData.itemId,
    });
  }

  private beginDurableSourceExpiry(itemId: string, currentTick: number): void {
    const existing = this.pendingDurableExpiry.get(itemId);
    if (
      existing?.inFlight ||
      (existing && currentTick < existing.nextRetryTick)
    ) {
      return;
    }
    const database = this.getDatabaseSystem();
    const pending = existing ?? {
      attempts: 0,
      nextRetryTick: currentTick,
      inFlight: false,
    };
    if (!database?.expireGroundItemSourceAsync) {
      pending.attempts += 1;
      pending.nextRetryTick =
        currentTick + Math.min(2 ** Math.min(pending.attempts - 1, 6), 64);
      this.pendingDurableExpiry.set(itemId, pending);
      const item = this.groundItems.get(itemId);
      if (item) item.despawnTick = pending.nextRetryTick;
      if (
        pending.attempts === 1 ||
        (pending.attempts & (pending.attempts - 1)) === 0
      ) {
        console.error(
          `[GroundItemSystem] Durable source expiration authority unavailable for ${itemId} after ${pending.attempts} attempt(s)`,
        );
      }
      return;
    }
    pending.inFlight = true;
    this.pendingDurableExpiry.set(itemId, pending);
    void database
      .expireGroundItemSourceAsync(itemId)
      .then((expired) => {
        pending.inFlight = false;
        if (!expired) {
          pending.nextRetryTick = currentTick + 1;
          const item = this.groundItems.get(itemId);
          if (item) item.despawnTick = currentTick + 1;
          return;
        }
        this.pendingDurableExpiry.delete(itemId);
        this.pendingPresentationHydration.delete(itemId);
        const itemData = this.groundItems.get(itemId);
        if (itemData) {
          this.removeGroundItem(itemId);
          this.emitTypedEvent(EventType.ITEM_DESPAWNED, {
            itemId,
            itemType: itemData.itemId,
          });
        }
      })
      .catch((error) => {
        pending.inFlight = false;
        pending.attempts += 1;
        pending.nextRetryTick =
          currentTick + Math.min(2 ** Math.min(pending.attempts - 1, 6), 64);
        const item = this.groundItems.get(itemId);
        if (item) item.despawnTick = pending.nextRetryTick;
        if (
          pending.attempts === 1 ||
          (pending.attempts & (pending.attempts - 1)) === 0
        ) {
          console.error(
            `[GroundItemSystem] Durable source expiration pending for ${itemId} after ${pending.attempts} attempt(s): ${String(error)}`,
          );
        }
      });
  }

  private processPendingDurableExpiries(currentTick: number): void {
    for (const itemId of this.pendingDurableExpiry.keys()) {
      this.beginDurableSourceExpiry(itemId, currentTick);
    }
  }

  /**
   * Remove ground item immediately
   * Also updates pile to show next item if applicable
   * Handles both tracked items (spawned via GroundItemSystem) and untracked items
   */
  removeGroundItem(itemId: string): boolean {
    // Clear any pickup lock on this item
    this.pickupLocks.delete(itemId);
    this.pickupLockTimestamps.delete(itemId);
    this.pendingPresentationHydration.delete(itemId);
    this.pendingDurableExpiry.delete(itemId);
    this.durableSourceIds.delete(itemId);

    const itemData = this.groundItems.get(itemId);

    if (itemData) {
      // Item was tracked - handle pile management
      const tile = worldToTile(itemData.position.x, itemData.position.z);
      const tileKey = this.getTileKey(tile);
      const pile = this.groundItemPiles.get(tileKey);

      if (pile) {
        // Remove item from pile
        const itemIndex = pile.items.findIndex((i) => i.entityId === itemId);
        if (itemIndex !== -1) {
          pile.items.splice(itemIndex, 1);
        }

        // If this was the top item, show the next item
        if (pile.topItemEntityId === itemId && pile.items.length > 0) {
          const nextItem = pile.items[0];
          pile.topItemEntityId = nextItem.entityId;
          this.setItemVisibility(nextItem.entityId, true);
        }

        // If pile is now empty, remove it
        if (pile.items.length === 0) {
          this.groundItemPiles.delete(tileKey);
        }
      }

      // Remove from tracking
      this.groundItems.delete(itemId);
    }

    return this.destroyOrQuarantinePresentation(itemId);
  }

  private destroyOrQuarantinePresentation(itemId: string): boolean {
    const entity = this.world.entities.get(itemId);
    if (!entity) {
      this.pendingPresentationCleanup.delete(itemId);
      return true;
    }
    if (this.entityManager?.destroyEntity(itemId)) {
      this.pendingPresentationCleanup.delete(itemId);
      return true;
    }
    if (!this.world.entities.get(itemId)) {
      this.pendingPresentationCleanup.delete(itemId);
      return true;
    }

    entity.setProperty("visibleInPile", false);
    entity.setProperty("interactable", false);
    if (typeof entity.markNetworkDirty === "function") {
      entity.markNetworkDirty();
    }
    const existing = this.pendingPresentationCleanup.get(itemId);
    const attempts = (existing?.attempts ?? 0) + 1;
    const backoffTicks = Math.min(2 ** Math.min(attempts - 1, 6), 64);
    this.pendingPresentationCleanup.set(itemId, {
      attempts,
      nextRetryTick: (this.world.currentTick ?? 0) + backoffTicks,
    });
    if (attempts === 1 || (attempts & (attempts - 1)) === 0) {
      console.error(
        `[GroundItemSystem] Source presentation cleanup pending for ${itemId} after ${attempts} attempt(s)`,
      );
    }
    return false;
  }

  private processPendingPresentationCleanup(currentTick: number): void {
    for (const [itemId, pending] of this.pendingPresentationCleanup) {
      if (currentTick < pending.nextRetryTick) continue;
      this.destroyOrQuarantinePresentation(itemId);
    }
  }

  /**
   * Get ground item data
   */
  getGroundItem(itemId: string): GroundItemData | null {
    return this.groundItems.get(itemId) || null;
  }

  /**
   * Get all ground items near a position
   */
  getItemsNearPosition(
    position: { x: number; y: number; z: number },
    radius: number,
  ): GroundItemData[] {
    const nearbyItems: GroundItemData[] = [];

    for (const itemData of this.groundItems.values()) {
      const dx = itemData.position.x - position.x;
      const dz = itemData.position.z - position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);

      if (distance <= radius) {
        nearbyItems.push(itemData);
      }
    }

    return nearbyItems;
  }

  /**
   * Get count of tracked ground items
   */
  getItemCount(): number {
    return this.groundItems.size;
  }

  /** Public aggregate only; exact source identities remain private logs. */
  getGroundItemCustodyStats(): GroundItemCustodyStats {
    let presentationHydrationsInFlight = 0;
    let maxPresentationHydrationAttempts = 0;
    for (const pending of this.pendingPresentationHydration.values()) {
      if (pending.inFlight) presentationHydrationsInFlight++;
      maxPresentationHydrationAttempts = Math.max(
        maxPresentationHydrationAttempts,
        pending.attempts,
      );
    }

    let durableExpiriesInFlight = 0;
    let maxDurableExpiryAttempts = 0;
    for (const pending of this.pendingDurableExpiry.values()) {
      if (pending.inFlight) durableExpiriesInFlight++;
      maxDurableExpiryAttempts = Math.max(
        maxDurableExpiryAttempts,
        pending.attempts,
      );
    }

    let maxPresentationCleanupAttempts = 0;
    for (const pending of this.pendingPresentationCleanup.values()) {
      maxPresentationCleanupAttempts = Math.max(
        maxPresentationCleanupAttempts,
        pending.attempts,
      );
    }

    const database = this.getDatabaseSystem();
    const pendingPresentationHydrations =
      this.pendingPresentationHydration.size;
    const pendingDurableExpiries = this.pendingDurableExpiry.size;
    const pendingPresentationCleanups = this.pendingPresentationCleanup.size;
    return {
      durableHydrationStatus: this.durableHydrationStatus,
      hydrationAuthorityAvailable: Boolean(
        database?.listActiveGroundItemSourcesAsync,
      ),
      expiryAuthorityAvailable: Boolean(database?.expireGroundItemSourceAsync),
      trackedItems: this.groundItems.size,
      durableSources: this.durableSourceIds.size,
      pendingCustodyReconciliations:
        pendingPresentationHydrations +
        pendingDurableExpiries +
        pendingPresentationCleanups,
      pendingPresentationHydrations,
      presentationHydrationsInFlight,
      maxPresentationHydrationAttempts,
      pendingDurableExpiries,
      durableExpiriesInFlight,
      maxDurableExpiryAttempts,
      pendingPresentationCleanups,
      maxPresentationCleanupAttempts,
    };
  }

  /**
   * Check if item is still under loot protection (TICK-BASED)
   * @param itemId - Ground item entity ID
   * @param currentTick - Current server tick
   * @returns true if loot protection is still active
   */
  isLootProtected(itemId: string, currentTick: number): boolean {
    const itemData = this.groundItems.get(itemId);
    if (!itemData || !itemData.lootProtectionTick) return false;
    return currentTick < itemData.lootProtectionTick;
  }

  /**
   * Check if an item is visible to a specific player (classic MMORPG visibility phases)
   * - Private phase (0-100 ticks): Only dropper/killer sees item
   * - Public phase (100-200 ticks): Everyone sees item
   *
   * NOTE: Currently used for server-side validation only. Full visual filtering
   * on the client would require network layer changes to filter items per-player.
   */
  isVisibleTo(itemId: string, playerId: string, currentTick: number): boolean {
    const itemData = this.groundItems.get(itemId);

    // Untracked items (world spawns) are always visible
    if (!itemData) return true;

    // If no loot protection, everyone can see
    if (!itemData.lootProtectionTick) return true;

    // If public phase reached, everyone can see
    if (currentTick >= itemData.lootProtectionTick) return true;

    // Private phase: only dropper can see
    return itemData.droppedBy === playerId;
  }

  /**
   * Check if a player can pick up an item (considering loot protection)
   *
   * Returns true for untracked items (world spawns from ItemSpawnerSystem)
   * since they have no loot protection to enforce.
   *
   * NOTE: This only checks loot protection. Use tryAcquirePickupLock() to also
   * prevent concurrent pickup race conditions.
   */
  canPickup(itemId: string, playerId: string, currentTick: number): boolean {
    const itemData = this.groundItems.get(itemId);

    // Untracked items (world spawns, resource drops) have no protection
    // If we can't find tracking data, allow pickup
    if (!itemData) return true;

    // If no loot protection, anyone can pick up
    if (!itemData.lootProtectionTick) return true;

    // If protection expired, anyone can pick up
    if (currentTick >= itemData.lootProtectionTick) return true;

    // Only the dropper/killer can pick up during protection
    return itemData.droppedBy === playerId;
  }

  /**
   * Try to acquire a pickup lock for an item
   *
   * This prevents the concurrent pickup race condition where two players
   * both check canPickup() → true and then both pick up the same item.
   *
   * The lock is atomic: if another player already has the lock, this returns false.
   *
   * @param itemId - Ground item entity ID
   * @param playerId - Player attempting to pick up
   * @param currentTick - Current server tick (for loot protection check)
   * @returns true if lock acquired (caller can proceed with pickup), false if locked by another player
   */
  tryAcquirePickupLock(
    itemId: string,
    playerId: string,
    currentTick: number,
  ): boolean {
    // First check loot protection
    if (!this.canPickup(itemId, playerId, currentTick)) {
      return false;
    }

    // Clean up any stale locks (timed out)
    this.cleanupStaleLocks();

    // Check if already locked by another player
    const existingLock = this.pickupLocks.get(itemId);
    if (existingLock && existingLock !== playerId) {
      console.log(
        `[GroundItemSystem] Pickup lock denied for ${playerId} on ${itemId} - locked by ${existingLock}`,
      );
      return false;
    }

    // Acquire lock
    this.pickupLocks.set(itemId, playerId);
    this.pickupLockTimestamps.set(itemId, Date.now());

    console.log(
      `[GroundItemSystem] Pickup lock acquired: ${playerId} → ${itemId}`,
    );

    return true;
  }

  /**
   * Release a pickup lock
   *
   * Call this after pickup completes (success or failure) to allow
   * other players to attempt pickup.
   *
   * @param itemId - Ground item entity ID
   * @param playerId - Player who held the lock (for validation)
   */
  releasePickupLock(itemId: string, playerId: string): void {
    const existingLock = this.pickupLocks.get(itemId);

    // Only release if the caller owns the lock
    if (existingLock === playerId) {
      this.pickupLocks.delete(itemId);
      this.pickupLockTimestamps.delete(itemId);
      console.log(
        `[GroundItemSystem] Pickup lock released: ${playerId} → ${itemId}`,
      );
    }
  }

  /**
   * Check if an item is currently locked for pickup by another player
   */
  isPickupLocked(itemId: string, playerId: string): boolean {
    const existingLock = this.pickupLocks.get(itemId);
    return !!existingLock && existingLock !== playerId;
  }

  /**
   * Clean up stale pickup locks (timed out)
   */
  private cleanupStaleLocks(): void {
    const now = Date.now();

    for (const [itemId, timestamp] of this.pickupLockTimestamps) {
      if (now - timestamp > this.PICKUP_LOCK_TIMEOUT_MS) {
        const playerId = this.pickupLocks.get(itemId);
        console.warn(
          `[GroundItemSystem] Pickup lock timed out: ${playerId} → ${itemId}`,
        );
        this.pickupLocks.delete(itemId);
        this.pickupLockTimestamps.delete(itemId);
      }
    }
  }

  /**
   * Get ticks until despawn (TICK-BASED)
   * @param itemId - Ground item entity ID
   * @param currentTick - Current server tick
   * @returns Ticks until despawn, or -1 if item not found
   */
  getTicksUntilDespawn(itemId: string, currentTick: number): number {
    const itemData = this.groundItems.get(itemId);
    if (!itemData) return -1;
    return Math.max(0, itemData.despawnTick - currentTick);
  }

  /**
   * Helper: Get item type string
   */
  private getItemTypeString(itemType: ItemType | string | undefined): string {
    if (typeof itemType === "string") return itemType;
    return "misc";
  }

  /**
   * Clean up all ground items
   */
  destroy(): void {
    this.isDestroying = true;
    // Destroy all entities
    if (this.entityManager) {
      for (const itemId of this.groundItems.keys()) {
        this.entityManager.destroyEntity(itemId);
      }
    }
    this.groundItems.clear();
    this.groundItemPiles.clear();
    this.pendingPresentationCleanup.clear();
    this.pendingPresentationHydration.clear();
    this.pendingDurableExpiry.clear();
    this.durableSourceIds.clear();

    // Clear all pickup locks
    this.pickupLocks.clear();
    this.pickupLockTimestamps.clear();

    super.destroy();
  }
}
