/**
 * SmithingSystem - Handles Smithing at Anvils
 *
 * rules-accurate smithing implementation:
 * - Use bars on anvil to smith items
 * - Requires hammer in inventory (not consumed)
 * - Consumes bars based on recipe
 * - Always succeeds (no failure rate)
 * - Grants smithing XP per item made
 * - Auto-smithing continues until out of bars
 *
 * @see ProcessingDataProvider for smithing recipes from manifest
 */

import {
  SMITHING_CONSTANTS,
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

/** Active smithing session for a player */
interface SmithingSession {
  playerId: string;
  recipeId: string; // Output item ID (e.g., "bronze_sword")
  anvilId: string;
  startTime: number;
  quantity: number;
  smithed: number;
  /** Tick when current smith action completes (tick-based timing) */
  completionTick: number;
  requestId?: string;
}

interface PendingSmithingAction {
  operationId: string;
  playerId: string;
  recipeId: string;
  retryCount: number;
  retryAtTick: number;
  state: "in_flight" | "retry_wait" | "settled";
  receipt: AtomicProcessingActionReceipt | null;
  stopAfterCommit: boolean;
}

/** Hammer item ID required for smithing (from centralized constants) */
const HAMMER_ITEM_ID = SMITHING_CONSTANTS.HAMMER_ITEM_ID;

export class SmithingSystem
  extends SystemBase
  implements PlayerProcessingQuiescenceSystem
{
  private readonly activeSessions = new Map<string, SmithingSession>();
  private readonly authorizedAnvils = new Map<string, string>();
  private readonly pendingActions = new Map<string, PendingSmithingAction>();
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
      name: "smithing",
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

    // Listen for smithing interaction (player clicked anvil)
    this.subscribe(
      EventType.SMITHING_INTERACT,
      (data: { playerId: string; anvilId: string }) => {
        this.handleAnvilInteract(data);
      },
    );

    // Listen for smithing request (player selected item to smith)
    this.subscribe(
      EventType.PROCESSING_SMITHING_REQUEST,
      (data: {
        playerId: string;
        recipeId: string;
        anvilId: string;
        quantity: number;
        requestId?: string;
      }) => {
        this.startSmithing(data);
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

    this.subscribe<{
      playerId: string;
      targetPosition: { x: number; y: number; z: number };
    }>(EventType.MOVEMENT_CLICK_TO_MOVE, (data) => {
      this.authorizedAnvils.delete(data.playerId);
      this.cancelSmithing(data.playerId);
    });

    this.subscribe(
      EventType.COMBAT_STARTED,
      (data: { attackerId: string; targetId: string }) => {
        this.authorizedAnvils.delete(data.attackerId);
        this.authorizedAnvils.delete(data.targetId);
        this.cancelSmithing(data.attackerId);
        this.cancelSmithing(data.targetId);
      },
    );

    // Clean up on player disconnect
    this.subscribe(
      EventType.PLAYER_UNREGISTERED,
      (data: { playerId: string }) => {
        this.authorizedAnvils.delete(data.playerId);
        this.cancelSmithing(data.playerId);
        this.playerSkills.delete(data.playerId); // Memory cleanup
      },
    );
  }

  /**
   * Handle anvil interaction - show available items to smith
   */
  private handleAnvilInteract(data: {
    playerId: string;
    anvilId: string;
  }): void {
    const { playerId, anvilId } = data;

    if (!this.canPlayerUseAnvil(playerId, anvilId)) {
      this.authorizedAnvils.delete(playerId);
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You must be next to that anvil to smith.",
        type: "error",
      });
      return;
    }
    this.authorizedAnvils.set(playerId, anvilId);

    // Check if already smithing
    if (this.activeSessions.has(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are already smithing.",
        type: "error",
      });
      return;
    }

    // Check for hammer
    if (!this.hasHammer(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You need a hammer to work the metal on this anvil.",
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

    // Get all recipes for bar types the player has, with availability info
    const availableRecipes =
      processingDataProvider.getSmithableItemsWithAvailability(
        inventory.map((item: { itemId: string; quantity?: number }) => ({
          itemId: item.itemId,
          quantity: item.quantity || 1,
        })),
        smithingLevel,
      );

    if (availableRecipes.length === 0) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You don't have the bars to smith anything.",
        type: "error",
      });
      return;
    }

    // Emit event with available recipes for UI to display
    // Includes meetsLevel and hasBars flags for greying out unavailable items
    // Use SMITHING_INTERFACE_OPEN (not SMITHING_INTERACT) to avoid infinite recursion
    this.emitTypedEvent(EventType.SMITHING_INTERFACE_OPEN, {
      playerId,
      anvilId,
      availableRecipes: availableRecipes.map((recipe) => ({
        itemId: recipe.itemId,
        name: recipe.name,
        barType: recipe.barType,
        barsRequired: recipe.barsRequired,
        levelRequired: recipe.levelRequired,
        xp: recipe.xp,
        category: recipe.category,
        outputQuantity: recipe.outputQuantity,
        meetsLevel: recipe.meetsLevel,
        hasBars: recipe.hasBars,
      })),
    });
  }

  /**
   * Start smithing a specific item
   */
  private startSmithing(data: {
    playerId: string;
    recipeId: string;
    anvilId: string;
    quantity: number;
    requestId?: string;
  }): void {
    const { playerId, recipeId, anvilId, quantity, requestId } = data;

    if (requestId && quantity !== 1) {
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smithing",
        "invalid_request",
      );
      return;
    }

    if (
      this.authorizedAnvils.get(playerId) !== anvilId ||
      !this.canPlayerUseAnvil(playerId, anvilId)
    ) {
      this.authorizedAnvils.delete(playerId);
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Use a nearby anvil before selecting an item to smith.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smithing",
        "not_authorized",
      );
      return;
    }

    // Check if already smithing
    if (this.activeSessions.has(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are already smithing.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smithing",
        "busy",
        true,
      );
      return;
    }

    // Check for hammer
    if (!this.hasHammer(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You need a hammer to work the metal on this anvil.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smithing",
        "requirements_not_met",
      );
      return;
    }

    // Validate recipe exists
    const recipe = processingDataProvider.getSmithingRecipe(recipeId);
    if (!recipe) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Invalid smithing recipe.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smithing",
        "invalid_request",
      );
      return;
    }

    // Check level requirement
    const smithingLevel = this.getSmithingLevel(playerId);
    if (smithingLevel < recipe.levelRequired) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `You need level ${recipe.levelRequired} Smithing to make that.`,
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "smithing",
        "requirements_not_met",
      );
      return;
    }

    // Get current tick for tick-based timing
    const currentTick = this.world.currentTick ?? 0;

    // Create session with tick-based completion
    const session: SmithingSession = {
      playerId,
      recipeId,
      anvilId,
      startTime: Date.now(),
      quantity: Math.max(1, quantity),
      smithed: 0,
      completionTick: currentTick + recipe.ticks, // First smith completes after recipe.ticks
      requestId,
    };

    this.activeSessions.set(playerId, session);
    publishProcessingInteractionPresentation(this.world, {
      playerId,
      skill: "smithing",
      targetEntityId: anvilId,
    });
    this.reportProcessingRequestProgress(
      playerId,
      requestId,
      "smithing",
      "accepted",
      true,
    );
    // Show start message
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId,
      message: `You begin smithing ${recipe.name}s.`,
      type: "info",
    });

    // Emit start event
    this.emitTypedEvent(EventType.SMITHING_START, {
      playerId,
      recipeId,
      anvilId,
    });
  }

  /**
   * Schedule the next smith action for a session.
   * Called after each successful smith to queue the next one.
   */
  private scheduleNextSmith(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    if (!this.canPlayerUseAnvil(playerId, session.anvilId)) {
      this.authorizedAnvils.delete(playerId);
      this.completeSmithing(playerId);
      return;
    }

    // Check if we've reached the target quantity
    if (session.smithed >= session.quantity) {
      this.completeSmithing(playerId);
      return;
    }

    const recipe = processingDataProvider.getSmithingRecipe(session.recipeId);
    if (!recipe) {
      this.completeSmithing(playerId);
      return;
    }

    // Check materials (bars)
    if (!this.hasRequiredBars(playerId, recipe.barType, recipe.barsRequired)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You have run out of bars.",
        type: "info",
      });
      this.completeSmithing(playerId);
      return;
    }

    // Set completion tick for next smith action (tick-based timing)
    const currentTick = this.world.currentTick ?? 0;
    session.completionTick = currentTick + recipe.ticks;
  }

  /**
   * Complete a single smith action
   */
  private completeSmith(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    if (this.pendingActions.has(playerId)) return;

    if (!this.canPlayerUseAnvil(playerId, session.anvilId)) {
      this.authorizedAnvils.delete(playerId);
      this.completeSmithing(playerId);
      return;
    }

    const recipe = processingDataProvider.getSmithingRecipe(session.recipeId);
    if (!recipe) {
      this.completeSmithing(playerId);
      return;
    }

    const qty = recipe.outputQuantity || 1;
    const pending: PendingSmithingAction = {
      operationId:
        getProcessingRequestOperationId("smithing", session.requestId) ??
        `smithing-action:${uuid()}${uuid()}`,
      playerId,
      recipeId: session.recipeId,
      retryCount: 0,
      retryAtTick: 0,
      state: "in_flight",
      receipt: null,
      stopAfterCommit: false,
    };
    this.pendingActions.set(playerId, pending);
    this.launchSmithingCommit(pending, {
      barType: recipe.barType,
      barsRequired: recipe.barsRequired,
      itemId: recipe.itemId,
      outputQuantity: qty,
      xp: recipe.xp,
    });
  }

  private launchSmithingCommit(
    pending: PendingSmithingAction,
    recipe: {
      barType: string;
      barsRequired: number;
      itemId: string;
      outputQuantity: number;
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
        xpAmount: recipe.xp,
        inputs: [{ itemId: recipe.barType, quantity: recipe.barsRequired }],
        requiredItems: [{ itemId: HAMMER_ITEM_ID, quantity: 1 }],
        consumables: [],
        outputs: [{ itemId: recipe.itemId, quantity: recipe.outputQuantity }],
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

  private processPendingActions(currentTick: number): void {
    for (const pending of this.pendingActions.values()) {
      const recipe = processingDataProvider.getSmithingRecipe(pending.recipeId);
      if (!recipe) {
        this.pendingActions.delete(pending.playerId);
        this.completeSmithing(pending.playerId);
        continue;
      }
      const commitRecipe = {
        barType: recipe.barType,
        barsRequired: recipe.barsRequired,
        itemId: recipe.itemId,
        outputQuantity: recipe.outputQuantity || 1,
        xp: recipe.xp,
      };
      if (
        pending.state === "retry_wait" &&
        currentTick >= pending.retryAtTick
      ) {
        this.launchSmithingCommit(pending, commitRecipe);
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
              ? "Your inventory is too full to hold the smithed item."
              : receipt.reason === "insufficient_items"
                ? "You have run out of bars."
                : "That smithing action could not be validated.",
          type: "warning",
        });
        const session = this.activeSessions.get(pending.playerId);
        this.rejectProcessingRequest(
          pending.playerId,
          session?.requestId,
          "smithing",
          receipt.reason === "inventory_full"
            ? "capacity_unavailable"
            : receipt.reason === "insufficient_items"
              ? "resources_unavailable"
              : "persistence_rejected",
        );
        this.completeSmithing(pending.playerId);
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
      if (!session || session.recipeId !== pending.recipeId) continue;
      if (!pending.stopAfterCommit) {
        this.emitTypedEvent(EventType.ANIMATION_PLAY, {
          entityId: pending.playerId,
          animation: "smithing",
          loop: false,
        });
      }
      session.smithed++;
      const qtyText =
        commitRecipe.outputQuantity > 1
          ? `${commitRecipe.outputQuantity} ${recipe.name}`
          : `a ${recipe.name}`;
      if (!pending.stopAfterCommit) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message: `You hammer the ${recipe.barType.replace("_bar", "")} and make ${qtyText}.`,
          type: "success",
        });
      }
      if (!receipt.liveInventoryApplied) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message:
            "Your smithed item is safely recorded, but the live inventory view needs to resynchronize.",
          type: "warning",
        });
      }
      if (pending.stopAfterCommit) this.completeSmithing(pending.playerId);
      else this.scheduleNextSmith(pending.playerId);
    }
  }

  /**
   * Complete the smithing session
   */
  private completeSmithing(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    this.activeSessions.delete(playerId);
    clearProcessingInteractionPresentation(this.world, playerId, "smithing");

    const recipe = processingDataProvider.getSmithingRecipe(session.recipeId);

    // Emit completion event
    this.finishProcessingRequest(session.requestId);
    this.emitTypedEvent(EventType.SMITHING_COMPLETE, {
      playerId,
      recipeId: session.recipeId,
      outputItemId: recipe?.itemId || session.recipeId,
      totalSmithed: session.smithed,
      totalXp: session.smithed * (recipe?.xp || 0),
      ...(session.requestId ? { requestId: session.requestId } : {}),
    });
  }

  /**
   * Cancel smithing for a player
   */
  private cancelSmithing(playerId: string): void {
    clearProcessingInteractionPresentation(this.world, playerId, "smithing");
    const pending = this.pendingActions.get(playerId);
    if (pending) {
      pending.stopAfterCommit = true;
      return;
    }
    const session = this.activeSessions.get(playerId);
    if (session) {
      this.completeSmithing(playerId);
    }
  }

  /**
   * Check if player has a hammer in inventory
   */
  private hasHammer(playerId: string): boolean {
    const inventory = this.world.getInventory?.(playerId);
    if (!inventory || !Array.isArray(inventory)) return false;

    return inventory.some(
      (item) => isLooseInventoryItem(item) && item.itemId === HAMMER_ITEM_ID,
    );
  }

  /**
   * Check if player has required bars
   */
  private hasRequiredBars(
    playerId: string,
    barType: string,
    barsRequired: number,
  ): boolean {
    const inventory = this.world.getInventory?.(playerId);
    if (!inventory || !Array.isArray(inventory)) return false;

    let totalBars = 0;
    for (const item of inventory) {
      if (!isLooseInventoryItem(item)) continue;
      if (item.itemId === barType) {
        totalBars += getItemQuantity(item);
      }
    }

    return totalBars >= barsRequired;
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

  /**
   * Check if player is currently smithing
   */
  isPlayerSmithing(playerId: string): boolean {
    return this.activeSessions.has(playerId);
  }

  requestPlayerProcessingQuiescence(playerId: string): void {
    this.authorizedAnvils.delete(playerId);
    this.cancelSmithing(playerId);
  }

  isPlayerProcessingQuiescent(playerId: string): boolean {
    return (
      !this.activeSessions.has(playerId) && !this.pendingActions.has(playerId)
    );
  }

  canPlayerUseAnvil(playerId: string, anvilId: string): boolean {
    return canPlayerUseProcessingStation(
      this.world,
      playerId,
      anvilId,
      "anvil",
    );
  }

  canPlayerUseActiveAnvil(playerId: string): boolean {
    const anvilId = this.authorizedAnvils.get(playerId);
    return !!anvilId && this.canPlayerUseAnvil(playerId, anvilId);
  }

  getSmithingCustodyStats(): {
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
   * Update method - processes tick-based smithing sessions.
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
        "smithing",
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
      this.completeSmith(playerId);
    }
  }

  destroy(): void {
    this.destroyed = true;
    // Complete all active sessions
    for (const playerId of this.activeSessions.keys()) {
      this.completeSmithing(playerId);
    }
    this.activeSessions.clear();
    this.authorizedAnvils.clear();
    this.pendingActions.clear();
    this.playerSkills.clear(); // Memory cleanup
  }
}
