/**
 * SmeltingSystem - Handles Smelting at Furnaces
 *
 * rules-accurate smelting implementation:
 * - Use ores on furnace to smelt bars
 * - Consumes primary ore, secondary ore (bronze), and coal
 * - Iron ore has 50% success rate (others always succeed)
 * - Grants smithing XP on successful smelt
 * - Auto-smelting continues until out of materials
 *
 * @see ProcessingDataProvider for smelting recipes from manifest
 */

import {
  isLooseInventoryItem,
  getItemQuantity,
  getSmithingLevelSafe,
} from "../../../constants/SmithingConstants";
import { processingDataProvider } from "../../../data/ProcessingDataProvider";
import {
  EventType,
  getProcessingRequestOperationId,
} from "../../../types/events";
import { uuid } from "../../../utils";
import { SystemBase } from "../infrastructure/SystemBase";
import type { World } from "../../../types/index";
import type {
  AtomicProcessingActionReceipt,
  InventorySystem,
} from "../character/InventorySystem";
import { canPlayerUseProcessingStation } from "./ProcessingStationAuthority";
import {
  clearProcessingInteractionPresentation,
  publishProcessingInteractionPresentation,
} from "./ProcessingInteractionPresentation";
import type { PlayerProcessingQuiescenceSystem } from "./ProcessingQuiescence";

/** Active smelting session for a player */
interface SmeltingSession {
  playerId: string;
  barItemId: string;
  furnaceId: string;
  startTime: number;
  quantity: number;
  smelted: number;
  failed: number;
  /** Tick when current smelt action completes (tick-based timing) */
  completionTick: number;
  requestId?: string;
}

interface PendingSmeltingAction {
  operationId: string;
  playerId: string;
  barItemId: string;
  success: boolean;
  retryCount: number;
  retryAtTick: number;
  state: "in_flight" | "retry_wait" | "settled";
  receipt: AtomicProcessingActionReceipt | null;
  stopAfterCommit: boolean;
}

export class SmeltingSystem
  extends SystemBase
  implements PlayerProcessingQuiescenceSystem
{
  private readonly activeSessions = new Map<string, SmeltingSession>();
  private readonly authorizedFurnaces = new Map<string, string>();
  private readonly pendingActions = new Map<string, PendingSmeltingAction>();
  private readonly playerSkills = new Map<
    string,
    Record<string, { level: number; xp: number }>
  >();

  /** Track last processed tick to ensure once-per-tick processing */
  private lastProcessedTick = -1;
  private destroyed = false;

  /** OPTIMIZATION: Pre-allocated array for completed players (avoids allocation per tick) */
  private readonly _completedPlayers: string[] = [];

  constructor(world: World) {
    super(world, {
      name: "smelting",
      dependencies: {
        required: [],
        optional: ["inventory", "skills"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // Server-only system - client doesn't need these event handlers
    if (!this.world.isServer) {
      return;
    }

    // Listen for smelting interaction (player clicked furnace)
    this.subscribe(
      EventType.SMELTING_INTERACT,
      (data: { playerId: string; furnaceId: string }) => {
        this.handleFurnaceInteract(data);
      },
    );

    // Listen for smelting request (player selected bar to smelt)
    this.subscribe(
      EventType.PROCESSING_SMELTING_REQUEST,
      (data: {
        playerId: string;
        barItemId: string;
        furnaceId: string;
        quantity: number;
        requestId?: string;
      }) => {
        this.startSmelting(data);
      },
    );

    // Listen for skills updates
    this.subscribe(
      EventType.SKILLS_UPDATED,
      (data: {
        playerId: string;
        skills: Record<string, { level: number; xp: number }>;
      }) => {
        this.playerSkills.set(data.playerId, data.skills);
      },
    );

    // Cancel smelting on movement (classic MMORPG: any click cancels skilling)
    this.subscribe<{
      playerId: string;
      targetPosition: { x: number; y: number; z: number };
    }>(EventType.MOVEMENT_CLICK_TO_MOVE, (data) => {
      this.authorizedFurnaces.delete(data.playerId);
      this.cancelSmelting(data.playerId);
    });

    // Cancel smelting on combat start
    this.subscribe(
      EventType.COMBAT_STARTED,
      (data: { attackerId: string; targetId: string }) => {
        this.authorizedFurnaces.delete(data.attackerId);
        this.authorizedFurnaces.delete(data.targetId);
        this.cancelSmelting(data.attackerId);
        this.cancelSmelting(data.targetId);
      },
    );

    // Clean up on player disconnect
    this.subscribe(
      EventType.PLAYER_UNREGISTERED,
      (data: { playerId: string }) => {
        this.authorizedFurnaces.delete(data.playerId);
        this.cancelSmelting(data.playerId);
        this.playerSkills.delete(data.playerId); // Memory cleanup
      },
    );
  }

  /**
   * Handle furnace interaction - show available bars to smelt
   */
  private handleFurnaceInteract(data: {
    playerId: string;
    furnaceId: string;
  }): void {
    const { playerId, furnaceId } = data;

    if (!this.canPlayerUseFurnace(playerId, furnaceId)) {
      this.authorizedFurnaces.delete(playerId);
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You must be next to that furnace to smelt.",
        type: "error",
      });
      return;
    }
    this.authorizedFurnaces.set(playerId, furnaceId);

    // Check if already smelting
    if (this.activeSessions.has(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are already smelting.",
        type: "error",
      });
      return;
    }

    // Get player inventory
    const inventory = this.world.getInventory?.(playerId);
    if (!inventory || !Array.isArray(inventory)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You have no items.",
        type: "error",
      });
      return;
    }

    // Get player smithing level
    const smithingLevel = this.getSmithingLevel(playerId);

    // Get available bars to smelt
    const availableBars = processingDataProvider.getSmeltableBarsFromInventory(
      inventory.map((item: { itemId: string; quantity?: number }) => ({
        itemId: item.itemId,
        quantity: item.quantity || 1,
      })),
      smithingLevel,
    );

    if (availableBars.length === 0) {
      // Check if any bars are blocked by level — give a specific message
      const inventoryItems = inventory.map(
        (item: { itemId: string; quantity?: number }) => ({
          itemId: item.itemId,
          quantity: item.quantity || 1,
        }),
      );
      const levelBlocked = processingDataProvider.getLevelBlockedBars(
        inventoryItems,
        smithingLevel,
      );

      if (levelBlocked.length > 0) {
        // Find the lowest level bar they could work toward
        const lowest = levelBlocked.reduce((a, b) =>
          a.levelRequired < b.levelRequired ? a : b,
        );
        const barName = lowest.barItemId.replace(/_/g, " ");
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId,
          message: `You need level ${lowest.levelRequired} Smithing to smelt a ${barName}.`,
          type: "error",
        });
      } else {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId,
          message: "You don't have the ores to smelt anything.",
          type: "error",
        });
      }
      return;
    }

    // Emit event with available bars for UI to display
    // Use SMELTING_INTERFACE_OPEN (not SMELTING_INTERACT) to avoid infinite recursion
    this.emitTypedEvent(EventType.SMELTING_INTERFACE_OPEN, {
      playerId,
      furnaceId,
      availableBars: availableBars.map((bar) => ({
        barItemId: bar.barItemId,
        levelRequired: bar.levelRequired,
        primaryOre: bar.primaryOre,
        secondaryOre: bar.secondaryOre,
        coalRequired: bar.coalRequired,
      })),
    });
  }

  /**
   * Start smelting a specific bar type
   */
  private startSmelting(data: {
    playerId: string;
    barItemId: string;
    furnaceId: string;
    quantity: number;
    requestId?: string;
  }): void {
    const { playerId, barItemId, furnaceId, quantity, requestId } = data;

    if (requestId && quantity !== 1) {
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smelting",
        "invalid_request",
      );
      return;
    }

    if (
      this.authorizedFurnaces.get(playerId) !== furnaceId ||
      !this.canPlayerUseFurnace(playerId, furnaceId)
    ) {
      this.authorizedFurnaces.delete(playerId);
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Use a nearby furnace before selecting a bar to smelt.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smelting",
        "not_authorized",
      );
      return;
    }

    // Check if already smelting
    if (this.activeSessions.has(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are already smelting.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smelting",
        "busy",
        true,
      );
      return;
    }

    // Validate smelting data exists
    const smeltingData = processingDataProvider.getSmeltingData(barItemId);
    if (!smeltingData) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Invalid bar type.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smelting",
        "invalid_request",
      );
      return;
    }

    // Check level requirement
    const smithingLevel = this.getSmithingLevel(playerId);
    if (smithingLevel < smeltingData.levelRequired) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `You need level ${smeltingData.levelRequired} Smithing to smelt that.`,
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smelting",
        "requirements_not_met",
      );
      return;
    }

    // Get current tick for tick-based timing
    const currentTick = this.world.currentTick ?? 0;

    // Create session with tick-based completion
    const session: SmeltingSession = {
      playerId,
      barItemId,
      furnaceId,
      startTime: Date.now(),
      quantity: Math.max(1, quantity),
      smelted: 0,
      failed: 0,
      completionTick: currentTick + smeltingData.ticks, // First smelt completes after smeltingData.ticks
      requestId,
    };

    this.activeSessions.set(playerId, session);
    publishProcessingInteractionPresentation(this.world, {
      playerId,
      skill: "smelting",
      targetEntityId: furnaceId,
    });
    this.reportProcessingRequestProgress(
      playerId,
      requestId,
      "smelting",
      "accepted",
      true,
    );
    // Show start message
    const barName = barItemId.replace("_bar", " bar");
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId,
      message: `You begin smelting ${barName}s.`,
      type: "info",
    });

    // Emit start event
    this.emitTypedEvent(EventType.SMELTING_START, {
      playerId,
      barItemId,
      furnaceId,
    });
  }

  /**
   * Schedule the next smelt action for a session.
   * Called after each smelt (success or failure) to queue the next one.
   */
  private scheduleNextSmelt(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    if (!this.canPlayerUseFurnace(playerId, session.furnaceId)) {
      this.authorizedFurnaces.delete(playerId);
      this.completeSmelting(playerId);
      return;
    }

    // Check if we've reached the target quantity
    if (session.smelted + session.failed >= session.quantity) {
      this.completeSmelting(playerId);
      return;
    }

    // Get smelting data for tick timing
    const smeltingData = processingDataProvider.getSmeltingData(
      session.barItemId,
    );
    if (!smeltingData) {
      this.completeSmelting(playerId);
      return;
    }

    // Check materials
    if (!this.hasRequiredMaterials(playerId, session.barItemId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You have run out of materials.",
        type: "info",
      });
      this.completeSmelting(playerId);
      return;
    }

    // Set completion tick for next smelt action (tick-based timing)
    const currentTick = this.world.currentTick ?? 0;
    session.completionTick = currentTick + smeltingData.ticks;
  }

  /**
   * Complete a single smelt action
   */
  private completeSmelt(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    if (this.pendingActions.has(playerId)) return;

    if (!this.canPlayerUseFurnace(playerId, session.furnaceId)) {
      this.authorizedFurnaces.delete(playerId);
      this.completeSmelting(playerId);
      return;
    }

    const smeltingData = processingDataProvider.getSmeltingData(
      session.barItemId,
    );
    if (!smeltingData) {
      this.completeSmelting(playerId);
      return;
    }

    const success = Math.random() < smeltingData.successRate;
    const pending: PendingSmeltingAction = {
      operationId:
        getProcessingRequestOperationId("smelting", session.requestId) ??
        `smelting-action:${uuid()}${uuid()}`,
      playerId,
      barItemId: session.barItemId,
      success,
      retryCount: 0,
      retryAtTick: 0,
      state: "in_flight",
      receipt: null,
      stopAfterCommit: false,
    };
    this.pendingActions.set(playerId, pending);
    this.launchSmeltingCommit(pending, smeltingData);
  }

  private launchSmeltingCommit(
    pending: PendingSmeltingAction,
    smeltingData: {
      primaryOre: string;
      secondaryOre: string | null;
      coalRequired: number;
      xp: number;
    },
  ): void {
    const inventory = this.world.getSystem("inventory") as
      InventorySystem | undefined;
    if (!inventory?.commitProcessingActionAtomic) {
      pending.retryCount++;
      pending.retryAtTick =
        (this.world.currentTick ?? 0) +
        Math.min(2 ** Math.min(pending.retryCount, 6), 50);
      pending.state = "retry_wait";
      return;
    }
    pending.state = "in_flight";
    void inventory
      .commitProcessingActionAtomic(pending.playerId, pending.operationId, {
        skill: "smithing",
        xpAmount: pending.success ? smeltingData.xp : 0,
        inputs: this.processingInputs(smeltingData),
        requiredItems: [],
        consumables: [],
        outputs: pending.success
          ? [{ itemId: pending.barItemId, quantity: 1 }]
          : [],
      })
      .then((receipt) => {
        if (
          this.destroyed ||
          this.pendingActions.get(pending.playerId) !== pending
        ) {
          return;
        }
        pending.receipt = receipt;
        pending.state = "settled";
      })
      .catch(() => {
        if (
          this.destroyed ||
          this.pendingActions.get(pending.playerId) !== pending
        ) {
          return;
        }
        pending.retryCount++;
        pending.retryAtTick =
          (this.world.currentTick ?? 0) +
          Math.min(2 ** Math.min(pending.retryCount, 6), 50);
        pending.state = "retry_wait";
      });
  }

  private processingInputs(smeltingData: {
    primaryOre: string;
    secondaryOre: string | null;
    coalRequired: number;
  }): Array<{ itemId: string; quantity: number }> {
    const inputs = [{ itemId: smeltingData.primaryOre, quantity: 1 }];
    if (smeltingData.secondaryOre) {
      inputs.push({ itemId: smeltingData.secondaryOre, quantity: 1 });
    }
    if (smeltingData.coalRequired > 0) {
      inputs.push({ itemId: "coal", quantity: smeltingData.coalRequired });
    }
    return inputs;
  }

  private processPendingActions(currentTick: number): void {
    for (const pending of this.pendingActions.values()) {
      const smeltingData = processingDataProvider.getSmeltingData(
        pending.barItemId,
      );
      if (!smeltingData) {
        this.pendingActions.delete(pending.playerId);
        this.completeSmelting(pending.playerId);
        continue;
      }
      if (
        pending.state === "retry_wait" &&
        currentTick >= pending.retryAtTick
      ) {
        this.launchSmeltingCommit(pending, smeltingData);
        continue;
      }
      if (pending.state !== "settled" || !pending.receipt) continue;

      const receipt = pending.receipt;
      if (!receipt.ok) {
        if (receipt.retryable) {
          pending.retryCount++;
          pending.retryAtTick =
            currentTick + Math.min(2 ** Math.min(pending.retryCount, 6), 50);
          pending.receipt = null;
          pending.state = "retry_wait";
          continue;
        }
        this.pendingActions.delete(pending.playerId);
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message:
            receipt.reason === "inventory_full"
              ? "Your inventory is too full to hold the smelted bar."
              : receipt.reason === "insufficient_items"
                ? "You have run out of materials."
                : "That smelting action could not be validated.",
          type: "warning",
        });
        const session = this.activeSessions.get(pending.playerId);
        this.rejectProcessingRequest(
          pending.playerId,
          session?.requestId,
          "smelting",
          receipt.reason === "inventory_full"
            ? "capacity_unavailable"
            : receipt.reason === "insufficient_items"
              ? "resources_unavailable"
              : "persistence_rejected",
        );
        this.completeSmelting(pending.playerId);
        continue;
      }

      if (receipt.xpAmount > 0) {
        this.emitTypedEvent(EventType.SKILLS_PROGRESS_COMMITTED, {
          playerId: receipt.playerId,
          operationId: receipt.operationId,
          replayed: receipt.replayed,
          skill: receipt.skill,
          xpAmount: receipt.xpAmount,
          awardedXp: receipt.awardedXp,
          operationCommittedXp: receipt.operationCommittedXp,
          currentXp: receipt.currentXp,
          currentLevel: receipt.currentLevel,
        });
      }
      this.pendingActions.delete(pending.playerId);
      const session = this.activeSessions.get(pending.playerId);
      if (!session || session.barItemId !== pending.barItemId) continue;

      if (!pending.stopAfterCommit) {
        this.emitTypedEvent(EventType.ANIMATION_PLAY, {
          entityId: pending.playerId,
          animation: "smelting",
          loop: false,
        });
      }
      if (pending.success) {
        session.smelted++;
        const barName = session.barItemId.replace("_bar", " bar");
        if (!pending.stopAfterCommit) {
          this.emitTypedEvent(EventType.UI_MESSAGE, {
            playerId: pending.playerId,
            message: `You smelt a ${barName}.`,
            type: "success",
          });
        }
        this.emitTypedEvent(EventType.SMELTING_SUCCESS, {
          playerId: pending.playerId,
          barItemId: session.barItemId,
          xpGained: receipt.awardedXp,
        });
      } else {
        session.failed++;
        if (!pending.stopAfterCommit) {
          this.emitTypedEvent(EventType.UI_MESSAGE, {
            playerId: pending.playerId,
            message: "The ore is too impure and you fail to smelt it.",
            type: "warning",
          });
        }
        this.emitTypedEvent(EventType.SMELTING_FAILURE, {
          playerId: pending.playerId,
          barItemId: session.barItemId,
        });
      }
      if (!receipt.liveInventoryApplied) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message:
            "Your smelting result is safely recorded, but the live inventory view needs to resynchronize.",
          type: "warning",
        });
      }
      if (pending.stopAfterCommit) this.completeSmelting(pending.playerId);
      else this.scheduleNextSmelt(pending.playerId);
    }
  }

  /**
   * Complete the smelting session
   */
  private completeSmelting(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    this.activeSessions.delete(playerId);
    clearProcessingInteractionPresentation(this.world, playerId, "smelting");

    // Emit completion event
    this.finishProcessingRequest(session.requestId);
    this.emitTypedEvent(EventType.SMELTING_COMPLETE, {
      playerId,
      barItemId: session.barItemId,
      totalSmelted: session.smelted,
      totalFailed: session.failed,
      totalXp:
        session.smelted *
        (processingDataProvider.getSmeltingXP(session.barItemId) || 0),
      ...(session.requestId ? { requestId: session.requestId } : {}),
    });
  }

  /**
   * Cancel smelting for a player
   */
  private cancelSmelting(playerId: string): void {
    clearProcessingInteractionPresentation(this.world, playerId, "smelting");
    const pending = this.pendingActions.get(playerId);
    if (pending) {
      pending.stopAfterCommit = true;
      return;
    }
    const session = this.activeSessions.get(playerId);
    if (session) {
      this.completeSmelting(playerId);
    }
  }

  /**
   * Check if player has required materials for smelting
   */
  private hasRequiredMaterials(playerId: string, barItemId: string): boolean {
    const smeltingData = processingDataProvider.getSmeltingData(barItemId);
    if (!smeltingData) return false;

    const inventory = this.world.getInventory?.(playerId);
    if (!inventory || !Array.isArray(inventory)) return false;

    // Build item counts using type-safe guard
    const itemCounts = new Map<string, number>();
    for (const item of inventory) {
      if (!isLooseInventoryItem(item)) continue;
      itemCounts.set(
        item.itemId,
        (itemCounts.get(item.itemId) || 0) + getItemQuantity(item),
      );
    }

    // Check primary ore
    if ((itemCounts.get(smeltingData.primaryOre) || 0) < 1) {
      return false;
    }

    // Check secondary ore (bronze)
    if (smeltingData.secondaryOre) {
      if ((itemCounts.get(smeltingData.secondaryOre) || 0) < 1) {
        return false;
      }
    }

    // Check coal
    if (smeltingData.coalRequired > 0) {
      if ((itemCounts.get("coal") || 0) < smeltingData.coalRequired) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get player's smithing level using type-safe access
   */
  private getSmithingLevel(playerId: string): number {
    // Check cached skills first
    const cachedSkills = this.playerSkills.get(playerId);
    if (cachedSkills?.smithing?.level) {
      return cachedSkills.smithing.level;
    }

    // Fall back to player entity using type-safe getter
    const player = this.world.getPlayer(playerId);
    return getSmithingLevelSafe(player, 1);
  }

  canPlayerUseFurnace(playerId: string, furnaceId: string): boolean {
    return canPlayerUseProcessingStation(
      this.world,
      playerId,
      furnaceId,
      "furnace",
    );
  }

  canPlayerUseActiveFurnace(playerId: string): boolean {
    const furnaceId = this.authorizedFurnaces.get(playerId);
    return !!furnaceId && this.canPlayerUseFurnace(playerId, furnaceId);
  }

  /**
   * Check if player is currently smelting
   */
  isPlayerSmelting(playerId: string): boolean {
    return this.activeSessions.has(playerId);
  }

  requestPlayerProcessingQuiescence(playerId: string): void {
    this.authorizedFurnaces.delete(playerId);
    this.cancelSmelting(playerId);
  }

  isPlayerProcessingQuiescent(playerId: string): boolean {
    return (
      !this.activeSessions.has(playerId) && !this.pendingActions.has(playerId)
    );
  }

  getSmeltingCustodyStats(): {
    activeSessions: number;
    pendingActions: number;
    inFlight: number;
    retryWaiting: number;
    maxRetryCount: number;
  } {
    let inFlight = 0;
    let retryWaiting = 0;
    let maxRetryCount = 0;
    for (const pending of this.pendingActions.values()) {
      if (pending.state === "in_flight") inFlight++;
      if (pending.state === "retry_wait") retryWaiting++;
      maxRetryCount = Math.max(maxRetryCount, pending.retryCount);
    }
    return {
      activeSessions: this.activeSessions.size,
      pendingActions: this.pendingActions.size,
      inFlight,
      retryWaiting,
      maxRetryCount,
    };
  }

  /**
   * Update method - processes tick-based smelting sessions.
   * Called each frame, but only processes once per game tick.
   */
  update(_dt: number): void {
    // Server-only processing
    if (!this.world.isServer) return;

    const currentTick = this.world.currentTick ?? 0;

    // Only process once per tick (avoid duplicate processing)
    if (currentTick === this.lastProcessedTick) {
      return;
    }
    this.lastProcessedTick = currentTick;

    for (const session of this.activeSessions.values()) {
      const pending = this.pendingActions.get(session.playerId);
      this.reportProcessingRequestProgress(
        session.playerId,
        session.requestId,
        "smelting",
        pending?.state === "retry_wait" ? "reconciling" : "working",
      );
    }

    this.processPendingActions(currentTick);

    // Process all active sessions that have reached their completion tick
    // OPTIMIZATION: Use pre-allocated array to avoid allocation per tick
    this._completedPlayers.length = 0; // Clear without reallocating
    for (const [playerId, session] of this.activeSessions) {
      if (
        !this.pendingActions.has(playerId) &&
        currentTick >= session.completionTick
      ) {
        this._completedPlayers.push(playerId);
      }
    }
    for (const playerId of this._completedPlayers) {
      this.completeSmelt(playerId);
    }
  }

  destroy(): void {
    this.destroyed = true;
    // Complete all active sessions
    for (const playerId of this.activeSessions.keys()) {
      this.completeSmelting(playerId);
    }
    this.activeSessions.clear();
    this.authorizedFurnaces.clear();
    this.pendingActions.clear();
    this.playerSkills.clear(); // Memory cleanup
  }
}
