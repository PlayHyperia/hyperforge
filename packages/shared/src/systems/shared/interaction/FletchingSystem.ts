/**
 * FletchingSystem - Handles Fletching Skill
 *
 * rules-accurate fletching implementation:
 * - Knife + logs → arrow shafts (multi-output) or unstrung bows
 * - Bowstring + unstrung bow → strung bow (item-on-item)
 * - Arrowtips + headless arrows → finished arrows (item-on-item, multi-output)
 * - Arrow shafts + feathers → headless arrows (item-on-item, multi-output)
 * - Always succeeds (no failure rate)
 * - Grants fletching XP per action
 * - Auto-fletching continues until out of materials
 *
 * @see ProcessingDataProvider for fletching recipes from manifest
 */

import {
  isLooseInventoryItem,
  getItemQuantity,
  hasSkills,
} from "../../../constants/SmithingConstants";
import { processingDataProvider } from "../../../data/ProcessingDataProvider";
import type { FletchingRecipeData } from "../../../data/ProcessingDataProvider";
import {
  EventType,
  getProcessingRequestOperationId,
} from "../../../types/events";
import { Logger } from "../../../utils/Logger";
import { uuid } from "../../../utils";
import { SystemBase } from "../infrastructure/SystemBase";
import type { World } from "../../../types/index";
import type {
  AtomicProcessingActionReceipt,
  InventorySystem,
} from "../character/InventorySystem";
import { canPlayerPerformPreparationAction } from "./ProcessingStationAuthority";
import {
  clearProcessingInteractionPresentation,
  publishProcessingInteractionPresentation,
} from "./ProcessingInteractionPresentation";
import type { PlayerProcessingQuiescenceSystem } from "./ProcessingQuiescence";

/** Active fletching session for a player */
interface FletchingSession {
  playerId: string;
  /** Unique recipe ID (output:primaryInput) */
  recipeId: string;
  /** Total actions to perform */
  quantity: number;
  /** Actions already completed */
  crafted: number;
  /** Tick when current fletch action completes */
  completionTick: number;
  requestId?: string;
}

interface PendingFletchingAction {
  operationId: string;
  playerId: string;
  recipeId: string;
  retryCount: number;
  retryAtTick: number;
  state: "in_flight" | "retry_wait" | "settled";
  receipt: AtomicProcessingActionReceipt | null;
  stopAfterCommit: boolean;
}

/** Pre-built inventory state to avoid redundant scans */
interface InventoryState {
  counts: Map<string, number>;
  itemIds: Set<string>;
}

export class FletchingSystem
  extends SystemBase
  implements PlayerProcessingQuiescenceSystem
{
  private readonly activeSessions = new Map<string, FletchingSession>();
  private readonly pendingActions = new Map<string, PendingFletchingAction>();
  private readonly playerSkills = new Map<
    string,
    Record<string, { level: number; xp: number }>
  >();

  /** Track last processed tick to ensure once-per-tick processing */
  private lastProcessedTick = -1;

  private destroyed = false;

  /** Reusable array for update loop to avoid allocating per tick */
  private readonly completedPlayerIds: string[] = [];

  constructor(world: World) {
    super(world, {
      name: "fletching",
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

    // Listen for fletching interaction (player used knife on logs, or item-on-item)
    this.subscribe(
      EventType.FLETCHING_INTERACT,
      (data: {
        playerId: string;
        triggerType: string;
        inputItemId: string;
        secondaryItemId?: string;
      }) => {
        this.handleFletchingInteract(data);
      },
    );

    // Listen for fletching request (player selected recipe and quantity)
    this.subscribe(
      EventType.PROCESSING_FLETCHING_REQUEST,
      (data: {
        playerId: string;
        recipeId: string;
        quantity: number;
        requestId?: string;
      }) => {
        this.startFletching(data);
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

    // Cancel fletching on movement (classic MMORPG: any click cancels skilling)
    this.subscribe<{
      playerId: string;
      targetPosition: { x: number; y: number; z: number };
    }>(EventType.MOVEMENT_CLICK_TO_MOVE, (data) => {
      if (this.activeSessions.has(data.playerId)) {
        this.cancelFletching(data.playerId);
      }
    });

    // Cancel fletching on combat start
    this.subscribe(
      EventType.COMBAT_STARTED,
      (data: { attackerId: string; targetId: string }) => {
        if (this.activeSessions.has(data.attackerId)) {
          this.cancelFletching(data.attackerId);
        }
        if (this.activeSessions.has(data.targetId)) {
          this.cancelFletching(data.targetId);
        }
      },
    );

    // Clean up on player disconnect
    this.subscribe(
      EventType.PLAYER_UNREGISTERED,
      (data: { playerId: string }) => {
        this.cancelFletching(data.playerId);
        this.playerSkills.delete(data.playerId);
      },
    );
  }

  /**
   * Handle fletching interaction - show available recipes to player
   */
  private handleFletchingInteract(data: {
    playerId: string;
    triggerType: string;
    inputItemId: string;
    secondaryItemId?: string;
  }): void {
    const { playerId, inputItemId, secondaryItemId } = data;

    if (!canPlayerPerformPreparationAction(this.world, playerId)) return;

    // Check if already fletching
    if (this.activeSessions.has(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are already fletching.",
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

    // Get player fletching level
    const fletchingLevel = this.getFletchingLevel(playerId);

    // Build inventory lookup
    const inventoryCounts = new Map<string, number>();
    for (const item of inventory) {
      if (!isLooseInventoryItem(item)) continue;
      const count = inventoryCounts.get(item.itemId) || 0;
      inventoryCounts.set(item.itemId, count + getItemQuantity(item));
    }

    // Get matching recipes based on input item(s)
    let filteredRecipes: FletchingRecipeData[];

    if (secondaryItemId) {
      // Item-on-item: find recipes that use BOTH items as inputs
      filteredRecipes = processingDataProvider.getFletchingRecipesForInputPair(
        inputItemId,
        secondaryItemId,
      );
    } else {
      // Knife + item: find all recipes that use this input
      filteredRecipes =
        processingDataProvider.getFletchingRecipesForInput(inputItemId);
    }

    if (filteredRecipes.length === 0) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You can't fletch anything with that.",
        type: "error",
      });
      return;
    }

    // Check availability for each recipe
    const availableRecipes = filteredRecipes.map((recipe) => {
      const meetsLevel = fletchingLevel >= recipe.level;
      const hasInputs = recipe.inputs.every((input) => {
        const count = inventoryCounts.get(input.item) || 0;
        return count >= input.amount;
      });
      const hasTools = recipe.tools.every((tool) => inventoryCounts.has(tool));

      return {
        recipeId: recipe.recipeId,
        output: recipe.output,
        name: recipe.name,
        category: recipe.category,
        outputQuantity: recipe.outputQuantity,
        inputs: recipe.inputs,
        tools: recipe.tools,
        level: recipe.level,
        xp: recipe.xp,
        meetsLevel,
        hasInputs: hasInputs && hasTools,
      };
    });

    // Emit event with available recipes for UI to display
    this.emitTypedEvent(EventType.FLETCHING_INTERFACE_OPEN, {
      playerId,
      availableRecipes,
    });
  }

  /**
   * Start fletching a specific recipe
   */
  private startFletching(data: {
    playerId: string;
    recipeId: string;
    quantity: number;
    requestId?: string;
  }): void {
    const { playerId, recipeId, quantity, requestId } = data;

    if (!canPlayerPerformPreparationAction(this.world, playerId)) {
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "fletching",
        "not_authorized",
      );
      return;
    }

    if (requestId && quantity !== 1) {
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "fletching",
        "invalid_request",
      );
      return;
    }

    // Check if already fletching
    if (this.activeSessions.has(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are already fletching.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "fletching",
        "busy",
        true,
      );
      return;
    }

    // Validate recipe exists
    const recipe = processingDataProvider.getFletchingRecipe(recipeId);
    if (!recipe) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Invalid fletching recipe.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "fletching",
        "invalid_request",
      );
      return;
    }

    // Check level requirement
    const fletchingLevel = this.getFletchingLevel(playerId);
    if (fletchingLevel < recipe.level) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `You need level ${recipe.level} Fletching to make that.`,
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "fletching",
        "requirements_not_met",
      );
      return;
    }

    // Build inventory state once for all checks
    const invState = this.getInventoryState(playerId);
    if (!invState) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You have no items.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "fletching",
        "resources_unavailable",
      );
      return;
    }

    // Check tools
    if (!this.hasRequiredTools(invState, recipe)) {
      const toolNames = recipe.tools.join(", ").replace(/_/g, " ");
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `You need a ${toolNames} to fletch that.`,
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "fletching",
        "requirements_not_met",
      );
      return;
    }

    // Check materials
    if (!this.hasRequiredInputs(invState, recipe)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You don't have the required materials.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "fletching",
        "resources_unavailable",
      );
      return;
    }

    // Get current tick for tick-based timing
    const currentTick = this.world.currentTick ?? 0;
    const normalizedQuantity = Number.isFinite(quantity)
      ? Math.floor(Math.max(1, Math.min(quantity, 10_000)))
      : 1;

    // Create session with tick-based completion
    const session: FletchingSession = {
      playerId,
      recipeId,
      quantity: normalizedQuantity,
      crafted: 0,
      completionTick: currentTick + recipe.ticks,
      requestId,
    };

    this.activeSessions.set(playerId, session);
    publishProcessingInteractionPresentation(this.world, {
      playerId,
      skill: "fletching",
    });
    this.reportProcessingRequestProgress(
      playerId,
      requestId,
      "fletching",
      "accepted",
      true,
    );
    // Show start message
    const itemName = recipe.name || recipe.output.replace(/_/g, " ");
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId,
      message: `You begin fletching ${itemName}s.`,
      type: "info",
    });

    // Emit start event
    this.emitTypedEvent(EventType.FLETCHING_START, {
      playerId,
      recipeId,
    });
  }

  /**
   * Schedule the next fletch action for a session.
   * Called after each successful fletch to queue the next one.
   */
  private scheduleNextFletch(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    // Check if we've reached the target quantity
    if (session.crafted >= session.quantity) {
      this.completeFletching(playerId);
      return;
    }

    const recipe = processingDataProvider.getFletchingRecipe(session.recipeId);
    if (!recipe) {
      this.completeFletching(playerId);
      return;
    }

    // Build inventory state once for all checks
    const invState = this.getInventoryState(playerId);
    if (!invState) {
      this.completeFletching(playerId);
      return;
    }

    // Check materials for next fletch
    if (!this.hasRequiredInputs(invState, recipe)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You have run out of materials.",
        type: "info",
      });
      this.completeFletching(playerId);
      return;
    }

    // Check tools still present
    if (!this.hasRequiredTools(invState, recipe)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You no longer have the required tools.",
        type: "info",
      });
      this.completeFletching(playerId);
      return;
    }

    // Set completion tick for next fletch action
    const currentTick = this.world.currentTick ?? 0;
    session.completionTick = currentTick + recipe.ticks;
  }

  /**
   * Complete a single fletch action.
   * Handles multi-output recipes (e.g., 15 arrow shafts per log).
   */
  private completeFletch(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    if (this.pendingActions.has(playerId)) return;

    if (!canPlayerPerformPreparationAction(this.world, playerId)) {
      this.activeSessions.delete(playerId);
      this.rejectProcessingRequest(
        playerId,
        session.requestId,
        "fletching",
        "not_authorized",
      );
      return;
    }

    const recipe = processingDataProvider.getFletchingRecipe(session.recipeId);
    if (!recipe) {
      this.completeFletching(playerId);
      return;
    }

    const pending: PendingFletchingAction = {
      operationId:
        getProcessingRequestOperationId("fletching", session.requestId) ??
        `fletching-action:${uuid()}${uuid()}`,
      playerId,
      recipeId: session.recipeId,
      retryCount: 0,
      retryAtTick: 0,
      state: "in_flight",
      receipt: null,
      stopAfterCommit: false,
    };
    this.pendingActions.set(playerId, pending);
    this.launchFletchingCommit(pending, recipe);
  }

  private launchFletchingCommit(
    pending: PendingFletchingAction,
    recipe: FletchingRecipeData,
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
        skill: "fletching",
        xpAmount: recipe.xp,
        inputs: recipe.inputs.map((input) => ({
          itemId: input.item,
          quantity: input.amount,
        })),
        requiredItems: recipe.tools.map((itemId) => ({
          itemId,
          quantity: 1,
        })),
        consumables: [],
        outputs: [{ itemId: recipe.output, quantity: recipe.outputQuantity }],
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
      const recipe = processingDataProvider.getFletchingRecipe(
        pending.recipeId,
      );
      if (!recipe) {
        this.pendingActions.delete(pending.playerId);
        this.completeFletching(pending.playerId);
        continue;
      }
      if (
        pending.state === "retry_wait" &&
        currentTick >= pending.retryAtTick
      ) {
        this.launchFletchingCommit(pending, recipe);
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
              ? "Your inventory is too full to hold the fletched items."
              : receipt.reason === "insufficient_items"
                ? "You have run out of required materials or tools."
                : "That fletching action could not be validated.",
          type: "warning",
        });
        const session = this.activeSessions.get(pending.playerId);
        this.rejectProcessingRequest(
          pending.playerId,
          session?.requestId,
          "fletching",
          receipt.reason === "inventory_full"
            ? "capacity_unavailable"
            : receipt.reason === "insufficient_items"
              ? "resources_unavailable"
              : "persistence_rejected",
        );
        this.completeFletching(pending.playerId);
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
          animation: "crafting",
          loop: false,
        });
      }
      session.crafted++;
      Logger.system("FletchingSystem", "fletch_complete", {
        playerId: pending.playerId,
        recipeId: session.recipeId,
        operationId: pending.operationId,
        output: recipe.output,
        outputQuantity: recipe.outputQuantity,
        inputsConsumed: recipe.inputs.map(
          (input) => `${input.amount}x${input.item}`,
        ),
        xpAwarded: receipt.awardedXp,
        crafted: session.crafted,
        batchTotal: session.quantity,
      });
      const itemName = recipe.name || recipe.output.replace(/_/g, " ");
      if (!pending.stopAfterCommit) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message:
            recipe.outputQuantity > 1
              ? `You fletch ${recipe.outputQuantity} ${itemName}s.`
              : `You fletch a ${itemName}.`,
          type: "success",
        });
      }
      if (!receipt.liveInventoryApplied) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message:
            "Your fletched items are safely recorded, but the live inventory view needs to resynchronize.",
          type: "warning",
        });
      }
      if (pending.stopAfterCommit) this.completeFletching(pending.playerId);
      else this.scheduleNextFletch(pending.playerId);
    }
  }

  /**
   * Complete the fletching session
   */
  private completeFletching(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    this.activeSessions.delete(playerId);
    clearProcessingInteractionPresentation(this.world, playerId, "fletching");

    const recipe = processingDataProvider.getFletchingRecipe(session.recipeId);

    // Emit completion event
    this.finishProcessingRequest(session.requestId);
    this.emitTypedEvent(EventType.FLETCHING_COMPLETE, {
      playerId,
      recipeId: session.recipeId,
      outputItemId: recipe?.output || session.recipeId,
      totalCrafted: session.crafted,
      totalXp: session.crafted * (recipe?.xp || 0),
      ...(session.requestId ? { requestId: session.requestId } : {}),
    });
  }

  /**
   * Cancel fletching for a player
   */
  private cancelFletching(playerId: string): void {
    clearProcessingInteractionPresentation(this.world, playerId, "fletching");
    const pending = this.pendingActions.get(playerId);
    if (pending) {
      pending.stopAfterCommit = true;
      return;
    }
    const session = this.activeSessions.get(playerId);
    if (session) {
      this.completeFletching(playerId);
    }
  }

  /**
   * Build inventory state once for use across multiple checks.
   */
  private getInventoryState(playerId: string): InventoryState | null {
    const inventory = this.world.getInventory?.(playerId);
    if (!inventory || !Array.isArray(inventory)) return null;

    const counts = new Map<string, number>();
    const itemIds = new Set<string>();
    for (const item of inventory) {
      if (!isLooseInventoryItem(item)) continue;
      itemIds.add(item.itemId);
      const count = counts.get(item.itemId) || 0;
      counts.set(item.itemId, count + getItemQuantity(item));
    }
    return { counts, itemIds };
  }

  /**
   * Check if player has required tools in inventory
   */
  private hasRequiredTools(
    state: InventoryState,
    recipe: FletchingRecipeData,
  ): boolean {
    if (recipe.tools.length === 0) return true;
    return recipe.tools.every((tool) => state.itemIds.has(tool));
  }

  /**
   * Check if player has required input materials
   */
  private hasRequiredInputs(
    state: InventoryState,
    recipe: FletchingRecipeData,
  ): boolean {
    return recipe.inputs.every((input) => {
      const count = state.counts.get(input.item) || 0;
      return count >= input.amount;
    });
  }

  /**
   * Get player's fletching level using type-safe access
   */
  private getFletchingLevel(playerId: string): number {
    // Check cached skills first
    const cachedSkills = this.playerSkills.get(playerId);
    if (cachedSkills?.fletching?.level != null) {
      return cachedSkills.fletching.level;
    }

    // Fall back to player entity using type-safe guard
    const player = this.world.getPlayer(playerId);
    if (!hasSkills(player)) return 1;
    const fletchingSkill =
      player.skills?.["fletching" as keyof typeof player.skills];
    return fletchingSkill?.level ?? 1;
  }

  /**
   * Check if player is currently fletching
   */
  isPlayerFletching(playerId: string): boolean {
    return this.activeSessions.has(playerId);
  }

  requestPlayerProcessingQuiescence(playerId: string): void {
    this.cancelFletching(playerId);
  }

  isPlayerProcessingQuiescent(playerId: string): boolean {
    return (
      !this.activeSessions.has(playerId) && !this.pendingActions.has(playerId)
    );
  }

  getFletchingCustodyStats(): {
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
   * Update method - processes tick-based fletching sessions.
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
        "fletching",
        pending?.state === "retry_wait" ? "reconciling" : "working",
      );
    }

    this.processPendingActions(currentTick);

    // Collect completed session IDs first, then process (avoids Map snapshot allocation)
    this.completedPlayerIds.length = 0;
    for (const [playerId, session] of this.activeSessions) {
      if (
        !this.pendingActions.has(playerId) &&
        currentTick >= session.completionTick
      ) {
        this.completedPlayerIds.push(playerId);
      }
    }
    for (const playerId of this.completedPlayerIds) {
      this.completeFletch(playerId);
    }
  }

  destroy(): void {
    this.destroyed = true;
    // Complete all active sessions
    for (const playerId of this.activeSessions.keys()) {
      this.completeFletching(playerId);
    }
    this.activeSessions.clear();
    this.pendingActions.clear();
    this.playerSkills.clear();
  }
}
