/**
 * Loot System - GDD Compliant (TICK-BASED)
 *
 * Orchestrates loot drops using modular services:
 * - LootTableService: Pure loot table logic and rolling
 * - GroundItemSystem: Shared ground item management
 *
 * classic MMORPG-STYLE BEHAVIOR:
 * - Mob dies → Items drop directly to ground at tile center
 * - Items pile on same tile, stackables merge
 * - Click item directly to pick up (no loot window)
 * - 2 minute despawn timer per item
 *
 */

import type { World } from "../../../types/index";
import { EventType } from "../../../types/events";
import type { InventoryItem } from "../../../types/core/core";
import { SystemBase } from "../infrastructure/SystemBase";
import { groundToTerrain } from "../../../utils/game/EntityUtils";
import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";
import { ticksToMs } from "../../../utils/game/CombatCalculations";
import { LootTableService } from "./LootTableService";
import type { GroundItemSystem } from "./GroundItemSystem";
import type {
  GroundItemMobLootCommitReceipt,
  GroundItemMobLootCommitRequest,
} from "../../../types/network/database";
import type { DatabaseSystem } from "../../../types/systems/system-interfaces";
import { validateKillToken } from "../../../utils/game/KillTokenUtils";
import { serializeGroundItemMobLootCommitFingerprint } from "../../../utils/game/GroundItemMobLootRegistration";

const MOB_COMBAT_PROGRESS_SKILLS = new Set([
  "attack",
  "strength",
  "defense",
  "constitution",
  "ranged",
  "magic",
]);

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

function isDefinitiveMobLootError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith("ground_item_mob_loot_") ||
    message.startsWith("ground_item_source_")
  );
}

type AuthenticatedMobDeath = {
  mobId: string;
  mobType: string;
  level: number;
  killedBy: string;
  position: { x: number; y: number; z: number };
  timestamp: number;
  lootOperationId: string;
  killToken: string;
  attackStyle: string;
  damageDealt: number;
};

type MobLootCommitAuthority = Pick<
  DatabaseSystem,
  "commitGroundItemMobLootOperationAsync"
>;

type PendingMobLootReconciliation = {
  data: AuthenticatedMobDeath;
  request: GroundItemMobLootCommitRequest;
  database: MobLootCommitAuthority;
  attempts: number;
  nextAttemptAt: number;
  inFlight: boolean;
  blocked: boolean;
};

export type LootCustodyStats = {
  pendingMobLootCommits: number;
  mobLootCommitsInFlight: number;
  mobLootCommitsBlocked: number;
  maxMobLootCommitAttempts: number;
};

export class LootSystem extends SystemBase {
  private lootTableService: LootTableService;
  private groundItemSystem: GroundItemSystem | null = null;
  private readonly pendingMobLootReconciliations = new Map<
    string,
    PendingMobLootReconciliation
  >();
  private mobLootReconciliationTimer: ReturnType<typeof setTimeout> | null =
    null;
  private destroyed = false;

  private static readonly MAX_PENDING_MOB_LOOT_RECONCILIATIONS = 4_096;
  private static readonly MOB_LOOT_RECONCILIATION_MAX_DELAY_MS = 30_000;

  constructor(world: World) {
    super(world, {
      name: "loot",
      dependencies: {
        required: ["ground-items"], // Depends on shared GroundItemSystem
        optional: ["inventory", "entity-manager", "ui", "client-graphics"],
      },
      autoCleanup: true,
    });

    // Initialize pure loot table service (no World dependencies)
    this.lootTableService = new LootTableService();
  }

  async init(): Promise<void> {
    // Get shared GroundItemSystem
    this.groundItemSystem =
      this.world.getSystem<GroundItemSystem>("ground-items") ?? null;
    if (!this.groundItemSystem) {
      console.warn(
        "[LootSystem] GroundItemSystem not found - mob loot drops disabled",
      );
    }

    // Subscribe to mob death events
    this.subscribe(
      EventType.NPC_DIED,
      async (event: {
        mobId?: string;
        killerId?: string;
        mobType?: string;
        level?: number;
        killedBy?: string;
        position?: { x: number; y: number; z: number };
        timestamp?: number;
        lootOperationId?: string;
        killToken?: string;
        attackStyle?: string;
        damageDealt?: number;
      }) => {
        // Validate event data
        if (!event || typeof event !== "object") {
          console.warn("[LootSystem] Invalid NPC_DIED event");
          return;
        }

        if (typeof event.mobId !== "string" || !event.mobId) {
          console.warn("[LootSystem] NPC_DIED missing mobId");
          return;
        }

        if (!event.position || typeof event.position !== "object") {
          console.warn("[LootSystem] NPC_DIED missing position");
          return;
        }

        const pos = event.position;
        if (
          typeof pos.x !== "number" ||
          typeof pos.y !== "number" ||
          typeof pos.z !== "number" ||
          !Object.values(pos).every(Number.isFinite)
        ) {
          console.warn("[LootSystem] NPC_DIED invalid position");
          return;
        }

        const killedBy =
          typeof event.killedBy === "string" ? event.killedBy.trim() : "";
        const mobType =
          typeof event.mobType === "string" ? event.mobType.trim() : "";
        const timestamp = Number(event.timestamp);
        const lootOperationId =
          typeof event.lootOperationId === "string"
            ? event.lootOperationId.trim()
            : "";
        const killToken =
          typeof event.killToken === "string" ? event.killToken.trim() : "";
        const attackStyle =
          typeof event.attackStyle === "string" ? event.attackStyle.trim() : "";
        const damageDealt = Number(event.damageDealt);
        if (
          !killedBy ||
          !mobType ||
          !Number.isSafeInteger(timestamp) ||
          !(await validateKillToken(
            event.mobId,
            killedBy,
            timestamp,
            killToken,
            lootOperationId,
            attackStyle,
            damageDealt,
          ))
        ) {
          console.error(
            `[LootSystem] Refused unauthenticated NPC_DIED for ${event.mobId}`,
          );
          return;
        }

        const payload = {
          mobId: event.mobId,
          mobType,
          level: typeof event.level === "number" ? event.level : 1,
          killedBy,
          position: { x: pos.x, y: pos.y, z: pos.z },
          timestamp,
          lootOperationId,
          killToken,
          attackStyle,
          damageDealt,
        };

        try {
          await this.handleMobDeath(payload);
        } catch (error) {
          console.error(
            `[LootSystem] Durable loot custody failed for ${payload.mobId}: ${String(error)}`,
          );
        }
      },
    );

    // NOTE: Ground item pickup is handled by InventorySystem via ITEM_PICKUP event
    // NOTE: Ground item despawn is handled by GroundItemSystem.processTick()
  }

  /**
   * Handle mob death and generate loot (classic MMORPG-style ground items)
   *
   * Drops items directly to ground at tile center instead of creating
   * a corpse entity. Items can be picked up by clicking directly.
   */
  private async handleMobDeath(data: AuthenticatedMobDeath): Promise<void> {
    // Roll loot using service
    const lootItems = this.lootTableService.rollLoot(data.mobType);
    if (!this.lootTableService.hasLootTable(data.mobType)) {
      console.warn(
        `[LootSystem] No loot table found for mob type: ${data.mobType}`,
      );
    }

    // Check if GroundItemSystem is available
    if (!this.groundItemSystem) {
      throw new Error("ground_item_mob_loot_source_authority_unavailable");
    }

    // Convert loot items to InventoryItem format
    const inventoryItems: InventoryItem[] = lootItems.map((loot, index) => ({
      id: `mob_loot_${data.mobId}_${index}`,
      itemId: loot.itemId,
      quantity: loot.quantity,
      slot: index,
      metadata: null,
    }));

    // Ground position to terrain
    const groundedPosition = groundToTerrain(
      this.world,
      data.position,
      0.2,
      Infinity,
    );

    const options = {
      despawnTime: ticksToMs(COMBAT_CONSTANTS.GROUND_ITEM_DESPAWN_TICKS),
      droppedBy: data.killedBy,
      lootProtection: ticksToMs(COMBAT_CONSTANTS.LOOT_PROTECTION_TICKS),
      scatter: false,
    } as const;
    const database = this.world.getSystem<DatabaseSystem>(
      "database",
    ) as Partial<DatabaseSystem> | null;
    if (database) {
      if (!database.commitGroundItemMobLootOperationAsync) {
        throw new Error("ground_item_mob_loot_database_authority_incomplete");
      }
      const sources =
        await this.groundItemSystem.prepareDurableSourceBatchRegistration(
          inventoryItems,
          groundedPosition,
          options,
        );
      if (!sources) {
        throw new Error("ground_item_mob_loot_source_plan_unavailable");
      }
      const identity = {
        operationId: data.lootOperationId,
        killedBy: data.killedBy,
        mobId: data.mobId,
        mobType: data.mobType,
        deathTimestamp: data.timestamp,
        position: data.position,
        killToken: data.killToken,
        attackStyle: data.attackStyle,
        damageDealt: data.damageDealt,
      };
      const request: GroundItemMobLootCommitRequest = {
        ...identity,
        requestFingerprint: await sha256Hex(
          serializeGroundItemMobLootCommitFingerprint(identity),
        ),
        sources,
      };
      const authority = database as MobLootCommitAuthority;
      try {
        const receipt = await this.commitMobLootWithExactRetry(
          data.lootOperationId,
          () => authority.commitGroundItemMobLootOperationAsync(request),
        );
        await this.finalizeCommittedMobLoot(data, request, receipt);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === `mob_loot_commit_unknown:${data.lootOperationId}`
        ) {
          this.queueMobLootReconciliation(
            data,
            request,
            authority,
            "response_unknown",
          );
          return;
        }
        if (
          error instanceof Error &&
          error.message === "ground_item_mob_loot_receipt_invalid"
        ) {
          this.queueMobLootReconciliation(
            data,
            request,
            authority,
            "receipt_invalid",
          );
          return;
        }
        throw error;
      }
      return;
    }

    if (inventoryItems.length === 0) {
      this.publishUndurableCombatKill(data);
      return;
    }
    const sourceIds = await this.groundItemSystem.spawnGroundItems(
      inventoryItems,
      groundedPosition,
      options,
      true,
    );
    if (sourceIds.length !== inventoryItems.length) {
      throw new Error("mob_loot_source_batch_incomplete");
    }

    console.log(
      `[LootSystem] Dropped ${inventoryItems.length} ground items for ${data.mobType} killed by ${data.killedBy}`,
    );

    this.publishLootDropped(data, lootItems, false);
    this.publishUndurableCombatKill(data);
  }

  private async finalizeCommittedMobLoot(
    data: AuthenticatedMobDeath,
    request: GroundItemMobLootCommitRequest,
    receipt: GroundItemMobLootCommitReceipt,
  ): Promise<void> {
    this.assertMobLootReceipt(request, receipt);
    if (this.destroyed) return;
    this.emitTypedEvent(EventType.MOB_LOOT_COMMITTED, {
      playerId: receipt.killedBy,
      lootOperationId: receipt.operationId,
      replayed: receipt.replayed,
      combatProgress: receipt.combatProgress,
    });
    const finalSources = new Map<
      string,
      GroundItemMobLootCommitReceipt["sources"][number]
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
          await this.groundItemSystem?.exposeCommittedDurableSource(source);
        if (!exposed) {
          console.warn(
            `[LootSystem] Mob-loot source ${source.sourceId} committed with deferred presentation`,
          );
        }
      } catch (error) {
        console.error(
          `[LootSystem] Mob-loot source ${source.sourceId} committed but presentation failed: ${String(error)}`,
        );
      }
    }
    if (receipt.dropped.length > 0) {
      this.publishLootDropped(data, receipt.dropped, receipt.replayed);
    }
  }

  /**
   * Database-free worlds retain their prior in-memory XP behavior, but only
   * after the complete local loot batch succeeds. Production database worlds
   * never enter this path.
   */
  private publishUndurableCombatKill(data: AuthenticatedMobDeath): void {
    this.emitTypedEvent(EventType.COMBAT_KILL, {
      attackerId: data.killedBy,
      targetId: data.mobId,
      damageDealt: data.damageDealt,
      attackStyle: data.attackStyle,
    });
  }

  private queueMobLootReconciliation(
    data: AuthenticatedMobDeath,
    request: GroundItemMobLootCommitRequest,
    database: MobLootCommitAuthority,
    reason: "response_unknown" | "receipt_invalid",
  ): void {
    const existing = this.pendingMobLootReconciliations.get(
      request.operationId,
    );
    if (existing) {
      if (existing.request.requestFingerprint !== request.requestFingerprint) {
        existing.blocked = true;
        throw new Error("mob_loot_reconciliation_identity_conflict");
      }
      return;
    }
    if (
      this.pendingMobLootReconciliations.size >=
      LootSystem.MAX_PENDING_MOB_LOOT_RECONCILIATIONS
    ) {
      throw new Error("mob_loot_reconciliation_capacity_exceeded");
    }
    this.pendingMobLootReconciliations.set(request.operationId, {
      data,
      request,
      database,
      attempts: 8,
      nextAttemptAt: Date.now() + 5_000,
      inFlight: false,
      blocked: false,
    });
    console.error(
      `[LootSystem] Mob-loot commit ${request.operationId} requires ${reason} reconciliation; exact request queued`,
    );
    this.scheduleMobLootReconciliation();
  }

  private scheduleMobLootReconciliation(): void {
    if (this.destroyed || this.mobLootReconciliationTimer) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const pending of this.pendingMobLootReconciliations.values()) {
      if (!pending.blocked && !pending.inFlight) {
        earliest = Math.min(earliest, pending.nextAttemptAt);
      }
    }
    if (!Number.isFinite(earliest)) return;
    this.mobLootReconciliationTimer = setTimeout(
      () => {
        this.mobLootReconciliationTimer = null;
        void this.drainMobLootReconciliations().catch((error) => {
          console.error(
            `[LootSystem] Mob-loot reconciliation worker failed: ${String(error)}`,
          );
        });
      },
      Math.max(0, earliest - Date.now()),
    );
  }

  private async drainMobLootReconciliations(now = Date.now()): Promise<void> {
    if (this.destroyed) return;
    for (const [operationId, pending] of this.pendingMobLootReconciliations) {
      if (
        this.destroyed ||
        pending.blocked ||
        pending.inFlight ||
        pending.nextAttemptAt > now
      ) {
        continue;
      }
      pending.inFlight = true;
      try {
        const receipt =
          await pending.database.commitGroundItemMobLootOperationAsync(
            pending.request,
          );
        this.assertMobLootReceipt(pending.request, receipt);
        this.pendingMobLootReconciliations.delete(operationId);
        await this.finalizeCommittedMobLoot(
          pending.data,
          pending.request,
          receipt,
        );
      } catch (error) {
        pending.attempts++;
        if (isDefinitiveMobLootError(error)) {
          pending.blocked = true;
          console.error(
            `[LootSystem] Mob-loot reconciliation ${operationId} blocked: ${String(error)}`,
          );
        } else {
          pending.nextAttemptAt =
            Date.now() +
            Math.min(
              250 * 2 ** Math.min(pending.attempts - 1, 16),
              LootSystem.MOB_LOOT_RECONCILIATION_MAX_DELAY_MS,
            );
        }
      } finally {
        pending.inFlight = false;
      }
    }
    this.scheduleMobLootReconciliation();
  }

  private publishLootDropped(
    data: {
      mobId: string;
      mobType: string;
      position: { x: number; y: number; z: number };
    },
    items: Array<{ itemId: string; quantity: number }>,
    replayed: boolean,
  ): void {
    this.emitTypedEvent(EventType.LOOT_DROPPED, {
      mobId: data.mobId,
      mobType: data.mobType,
      items,
      position: data.position,
      lootOperationId:
        "lootOperationId" in data ? data.lootOperationId : undefined,
      replayed,
    });
  }

  private assertMobLootReceipt(
    request: GroundItemMobLootCommitRequest,
    receipt: GroundItemMobLootCommitReceipt,
  ): void {
    if (
      receipt.operationId !== request.operationId ||
      receipt.killedBy !== request.killedBy ||
      receipt.requestFingerprint !== request.requestFingerprint ||
      receipt.mobId !== request.mobId ||
      receipt.mobType !== request.mobType ||
      receipt.deathTimestamp !== request.deathTimestamp ||
      JSON.stringify(receipt.position) !== JSON.stringify(request.position) ||
      receipt.killToken !== request.killToken ||
      receipt.attackStyle !== request.attackStyle ||
      receipt.damageDealt !== request.damageDealt ||
      typeof receipt.replayed !== "boolean" ||
      !Array.isArray(receipt.combatProgress) ||
      receipt.combatProgress.length === 0 ||
      receipt.combatProgress.length > 4 ||
      receipt.combatProgress.some(
        (progress) =>
          !MOB_COMBAT_PROGRESS_SKILLS.has(progress.skill) ||
          !Number.isSafeInteger(progress.xpAmount) ||
          progress.xpAmount <= 0 ||
          !Number.isSafeInteger(progress.awardedXp) ||
          progress.awardedXp < 0 ||
          progress.awardedXp > progress.xpAmount ||
          !Number.isSafeInteger(progress.operationCommittedXp) ||
          progress.operationCommittedXp < 0 ||
          !Number.isSafeInteger(progress.currentXp) ||
          progress.currentXp < progress.operationCommittedXp ||
          !Number.isSafeInteger(progress.currentLevel) ||
          progress.currentLevel < 1 ||
          progress.currentLevel > 99,
      ) ||
      new Set(receipt.combatProgress.map((progress) => progress.skill)).size !==
        receipt.combatProgress.length ||
      !Array.isArray(receipt.dropped) ||
      !Array.isArray(receipt.sources) ||
      (receipt.dropped.length > 0 && receipt.sources.length === 0) ||
      receipt.dropped.some(
        (item) =>
          !item ||
          typeof item.itemId !== "string" ||
          !item.itemId ||
          !Number.isSafeInteger(item.quantity) ||
          item.quantity <= 0,
      ) ||
      new Set(receipt.sources.map((source) => source.contributionId)).size !==
        receipt.sources.length
    ) {
      throw new Error("ground_item_mob_loot_receipt_invalid");
    }
  }

  private async commitMobLootWithExactRetry<T>(
    operationId: string,
    commit: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        return await commit();
      } catch (error) {
        if (isDefinitiveMobLootError(error)) throw error;
        lastError = error;
        if (attempt < 8) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 5_000));
          });
        }
      }
    }
    throw new Error(`mob_loot_commit_unknown:${operationId}`, {
      cause: lastError,
    });
  }

  /**
   * Public API for testing
   */
  public getLootTableCount(): number {
    return this.lootTableService.getLootTableCount();
  }

  /** Public aggregate only; operation identities and errors remain private. */
  public getLootCustodyStats(): LootCustodyStats {
    let mobLootCommitsInFlight = 0;
    let mobLootCommitsBlocked = 0;
    let maxMobLootCommitAttempts = 0;
    for (const pending of this.pendingMobLootReconciliations.values()) {
      if (pending.inFlight) mobLootCommitsInFlight++;
      if (pending.blocked) mobLootCommitsBlocked++;
      maxMobLootCommitAttempts = Math.max(
        maxMobLootCommitAttempts,
        pending.attempts,
      );
    }
    return {
      pendingMobLootCommits: this.pendingMobLootReconciliations.size,
      mobLootCommitsInFlight,
      mobLootCommitsBlocked,
      maxMobLootCommitAttempts,
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.mobLootReconciliationTimer) {
      clearTimeout(this.mobLootReconciliationTimer);
      this.mobLootReconciliationTimer = null;
    }
    this.pendingMobLootReconciliations.clear();
    // GroundItemSystem cleanup is handled by the system itself
    // Call parent cleanup (handles event listeners)
    super.destroy();
  }
}
