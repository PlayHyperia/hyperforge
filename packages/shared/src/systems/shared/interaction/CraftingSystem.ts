/**
 * CraftingSystem - Handles Crafting Skills
 *
 * rules-accurate crafting implementation:
 * - Leather/dragonhide: use needle + thread + hides
 * - Jewelry: use mould + gold bar at furnace
 * - Gem cutting: use chisel on uncut gems
 * - Thread has 5 uses per item (consumed every 5 crafts)
 * - Always succeeds (no failure rate)
 * - Grants crafting XP per item made
 * - Auto-crafting continues until out of materials
 *
 * @see ProcessingDataProvider for crafting recipes from manifest
 */

import {
  isLooseInventoryItem,
  getItemQuantity,
  hasSkills,
} from "../../../constants/SmithingConstants";
import { processingDataProvider } from "../../../data/ProcessingDataProvider";
import type { CraftingRecipeData } from "../../../data/ProcessingDataProvider";
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
import {
  canPlayerPerformPreparationAction,
  canPlayerUseProcessingStation,
} from "./ProcessingStationAuthority";
import {
  clearProcessingInteractionPresentation,
  publishProcessingInteractionPresentation,
} from "./ProcessingInteractionPresentation";
import type { PlayerProcessingQuiescenceSystem } from "./ProcessingQuiescence";

/** Active crafting session for a player */
interface CraftingSession {
  playerId: string;
  recipeId: string; // Output item ID (e.g., "leather_body")
  station: string;
  stationId: string | null;
  quantity: number;
  crafted: number;
  /** Tick when current craft action completes (tick-based timing) */
  completionTick: number;
  requestId?: string;
}

interface CraftingInteractionSession {
  triggerType: "needle" | "chisel" | "furnace";
  stationId: string | null;
  allowedRecipeIds: Set<string>;
}

interface PendingCraftingAction {
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

export class CraftingSystem
  extends SystemBase
  implements PlayerProcessingQuiescenceSystem
{
  private readonly activeSessions = new Map<string, CraftingSession>();
  private readonly interactionSessions = new Map<
    string,
    CraftingInteractionSession
  >();
  private readonly pendingActions = new Map<string, PendingCraftingAction>();
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
      name: "crafting",
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

    // Listen for crafting interaction (player used needle/chisel/gold bar on furnace)
    this.subscribe(
      EventType.CRAFTING_INTERACT,
      (data: {
        playerId: string;
        triggerType: string;
        stationId?: string;
        inputItemId?: string;
      }) => {
        this.handleCraftingInteract(data);
      },
    );

    // Listen for crafting request (player selected item to craft)
    this.subscribe(
      EventType.PROCESSING_CRAFTING_REQUEST,
      (data: {
        playerId: string;
        recipeId: string;
        quantity: number;
        requestId?: string;
      }) => {
        this.startCrafting(data);
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

    // Cancel crafting on movement (classic MMORPG: any click cancels skilling)
    this.subscribe<{
      playerId: string;
      targetPosition: { x: number; y: number; z: number };
    }>(EventType.MOVEMENT_CLICK_TO_MOVE, (data) => {
      this.interactionSessions.delete(data.playerId);
      this.cancelCrafting(data.playerId);
    });

    // Cancel crafting on combat start
    this.subscribe(
      EventType.COMBAT_STARTED,
      (data: { attackerId: string; targetId: string }) => {
        this.interactionSessions.delete(data.attackerId);
        this.interactionSessions.delete(data.targetId);
        this.cancelCrafting(data.attackerId);
        this.cancelCrafting(data.targetId);
      },
    );

    // Clean up on player disconnect
    this.subscribe(
      EventType.PLAYER_UNREGISTERED,
      (data: { playerId: string }) => {
        this.interactionSessions.delete(data.playerId);
        this.cancelCrafting(data.playerId);
        this.playerSkills.delete(data.playerId); // Memory cleanup
      },
    );
  }

  /**
   * Handle crafting interaction - show available items to craft
   */
  private handleCraftingInteract(data: {
    playerId: string;
    triggerType: string;
    stationId?: string;
    inputItemId?: string;
  }): void {
    const { playerId, inputItemId } = data;
    const triggerType = data.triggerType as "needle" | "chisel" | "furnace";

    if (
      !["needle", "chisel", "furnace"].includes(triggerType) ||
      !canPlayerPerformPreparationAction(this.world, playerId)
    ) {
      this.interactionSessions.delete(playerId);
      return;
    }

    const stationId =
      triggerType === "furnace" ? String(data.stationId ?? "") : null;
    if (
      triggerType === "furnace" &&
      !this.canPlayerUseCraftingFurnace(playerId, stationId ?? "")
    ) {
      this.interactionSessions.delete(playerId);
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You must be next to that furnace to craft jewelry.",
        type: "error",
      });
      return;
    }

    // Check if already crafting
    if (this.activeSessions.has(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are already crafting.",
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

    // Get player crafting level
    const craftingLevel = this.getCraftingLevel(playerId);

    // Determine station type based on trigger
    const station = triggerType === "furnace" ? "furnace" : "none";

    // Build inventory lookup first (needed for recipe filtering and availability)
    const inventoryCounts = new Map<string, number>();
    for (const item of inventory) {
      if (!isLooseInventoryItem(item)) continue;
      const count = inventoryCounts.get(item.itemId) || 0;
      inventoryCounts.set(item.itemId, count + getItemQuantity(item));
    }

    // Get crafting recipes filtered by station
    let filteredRecipes =
      processingDataProvider.getCraftingRecipesByStation(station);

    // Filter by specific input item if provided (rules-accurate: only show relevant recipes)
    if (inputItemId) {
      filteredRecipes = filteredRecipes.filter((recipe) =>
        recipe.inputs.some((inp) => inp.item === inputItemId),
      );
    }

    // For furnace (jewelry): only show recipes where player has required moulds
    if (station === "furnace") {
      filteredRecipes = filteredRecipes.filter((recipe) =>
        recipe.tools.every((tool) => inventoryCounts.has(tool)),
      );
    }

    if (filteredRecipes.length === 0) {
      this.interactionSessions.delete(playerId);
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "There are no crafting recipes available.",
        type: "error",
      });
      return;
    }

    // Check availability for each recipe
    const availableRecipes = filteredRecipes.map((recipe) => {
      const meetsLevel = craftingLevel >= recipe.level;
      const hasInputs = recipe.inputs.every((input) => {
        const count = inventoryCounts.get(input.item) || 0;
        return count >= input.amount;
      });
      const hasTools = recipe.tools.every((tool) => inventoryCounts.has(tool));
      const hasConsumables = recipe.consumables.every((c) =>
        inventoryCounts.has(c.item),
      );

      return {
        output: recipe.output,
        name: recipe.name,
        category: recipe.category,
        inputs: recipe.inputs,
        tools: recipe.tools,
        level: recipe.level,
        xp: recipe.xp,
        meetsLevel,
        hasInputs: hasInputs && hasTools && hasConsumables,
      };
    });

    this.interactionSessions.set(playerId, {
      triggerType,
      stationId,
      allowedRecipeIds: new Set(filteredRecipes.map((recipe) => recipe.output)),
    });

    // Emit event with available recipes for UI to display
    this.emitTypedEvent(EventType.CRAFTING_INTERFACE_OPEN, {
      playerId,
      availableRecipes,
      station,
    });
  }

  /**
   * Start crafting a specific item
   */
  private startCrafting(data: {
    playerId: string;
    recipeId: string;
    quantity: number;
    requestId?: string;
  }): void {
    const { playerId, recipeId, quantity, requestId } = data;
    if (requestId && quantity !== 1) {
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "crafting",
        "invalid_request",
      );
      return;
    }
    if (!canPlayerPerformPreparationAction(this.world, playerId)) {
      this.interactionSessions.delete(playerId);
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "crafting",
        "not_authorized",
      );
      return;
    }
    // Check if already crafting
    if (this.activeSessions.has(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You are already crafting.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "crafting",
        "busy",
        true,
      );
      return;
    }

    // Validate recipe exists
    const recipe = processingDataProvider.getCraftingRecipe(recipeId);
    if (!recipe) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Invalid crafting recipe.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "crafting",
        "invalid_request",
      );
      return;
    }

    const interaction = this.interactionSessions.get(playerId);
    if (
      recipe.station === "furnace" &&
      (!interaction ||
        interaction.triggerType !== "furnace" ||
        !interaction.stationId ||
        !interaction.allowedRecipeIds.has(recipeId) ||
        !this.canPlayerUseCraftingFurnace(playerId, interaction.stationId))
    ) {
      this.interactionSessions.delete(playerId);
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Use a nearby furnace before selecting jewelry to craft.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "crafting",
        "not_authorized",
      );
      return;
    }

    // Check level requirement
    const craftingLevel = this.getCraftingLevel(playerId);
    if (craftingLevel < recipe.level) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `You need level ${recipe.level} Crafting to make that.`,
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "crafting",
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
        "crafting",
        "resources_unavailable",
      );
      return;
    }

    // Check tools
    if (!this.hasRequiredTools(invState, recipe)) {
      const toolNames = recipe.tools.join(", ").replace(/_/g, " ");
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `You need a ${toolNames} to craft that.`,
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "crafting",
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
        "crafting",
        "resources_unavailable",
      );
      return;
    }

    // Check consumables (e.g., thread)
    if (!this.hasRequiredConsumables(invState, recipe)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You need thread to craft that.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "crafting",
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
    const session: CraftingSession = {
      playerId,
      recipeId,
      station: recipe.station,
      stationId:
        recipe.station === "furnace" ? (interaction?.stationId ?? null) : null,
      quantity: normalizedQuantity,
      crafted: 0,
      completionTick: currentTick + recipe.ticks,
      requestId,
    };

    this.activeSessions.set(playerId, session);
    publishProcessingInteractionPresentation(this.world, {
      playerId,
      skill: "crafting",
      targetEntityId: session.stationId,
    });
    this.reportProcessingRequestProgress(
      playerId,
      requestId,
      "crafting",
      "accepted",
      true,
    );
    // Show start message
    const itemName = recipe.name || recipe.output.replace(/_/g, " ");
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId,
      message: `You begin crafting ${itemName}s.`,
      type: "info",
    });

    // Emit start event
    this.emitTypedEvent(EventType.CRAFTING_START, {
      playerId,
      recipeId,
    });
  }

  /**
   * Schedule the next craft action for a session.
   * Called after each successful craft to queue the next one.
   */
  private scheduleNextCraft(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    if (
      session.station === "furnace" &&
      (!session.stationId ||
        !this.canPlayerUseCraftingFurnace(playerId, session.stationId))
    ) {
      this.interactionSessions.delete(playerId);
      this.completeCrafting(playerId);
      return;
    }

    // Check if we've reached the target quantity
    if (session.crafted >= session.quantity) {
      this.completeCrafting(playerId);
      return;
    }

    const recipe = processingDataProvider.getCraftingRecipe(session.recipeId);
    if (!recipe) {
      this.completeCrafting(playerId);
      return;
    }

    // Build inventory state once for all checks
    const invState = this.getInventoryState(playerId);
    if (!invState) {
      this.completeCrafting(playerId);
      return;
    }

    // Check materials for next craft
    if (!this.hasRequiredInputs(invState, recipe)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You have run out of materials.",
        type: "info",
      });
      this.completeCrafting(playerId);
      return;
    }

    // Check tools still present
    if (!this.hasRequiredTools(invState, recipe)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You no longer have the required tools.",
        type: "info",
      });
      this.completeCrafting(playerId);
      return;
    }

    if (!this.hasRequiredConsumables(invState, recipe)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You have run out of recipe consumables.",
        type: "info",
      });
      this.completeCrafting(playerId);
      return;
    }

    // Set completion tick for next craft action
    const currentTick = this.world.currentTick ?? 0;
    session.completionTick = currentTick + recipe.ticks;
  }

  /**
   * Complete a single craft action
   */
  private completeCraft(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    if (this.pendingActions.has(playerId)) return;

    if (
      session.station === "furnace" &&
      (!session.stationId ||
        !this.canPlayerUseCraftingFurnace(playerId, session.stationId))
    ) {
      this.interactionSessions.delete(playerId);
      this.completeCrafting(playerId);
      return;
    }

    const recipe = processingDataProvider.getCraftingRecipe(session.recipeId);
    if (!recipe) {
      this.completeCrafting(playerId);
      return;
    }

    const pending: PendingCraftingAction = {
      operationId:
        getProcessingRequestOperationId("crafting", session.requestId) ??
        `crafting-action:${uuid()}${uuid()}`,
      playerId,
      recipeId: session.recipeId,
      retryCount: 0,
      retryAtTick: 0,
      state: "in_flight",
      receipt: null,
      stopAfterCommit: false,
    };
    this.pendingActions.set(playerId, pending);
    this.launchCraftingCommit(pending, recipe);
  }

  private launchCraftingCommit(
    pending: PendingCraftingAction,
    recipe: CraftingRecipeData,
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
        skill: "crafting",
        xpAmount: recipe.xp,
        inputs: recipe.inputs.map((input) => ({
          itemId: input.item,
          quantity: input.amount,
        })),
        requiredItems: recipe.tools.map((itemId) => ({
          itemId,
          quantity: 1,
        })),
        consumables: recipe.consumables.map((consumable) => ({
          itemId: consumable.item,
          usesPerItem: consumable.uses,
        })),
        outputs: [{ itemId: recipe.output, quantity: 1 }],
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
      const recipe = processingDataProvider.getCraftingRecipe(pending.recipeId);
      if (!recipe) {
        this.pendingActions.delete(pending.playerId);
        this.completeCrafting(pending.playerId);
        continue;
      }
      if (
        pending.state === "retry_wait" &&
        currentTick >= pending.retryAtTick
      ) {
        this.launchCraftingCommit(pending, recipe);
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
              ? "Your inventory is too full to hold the crafted item."
              : receipt.reason === "insufficient_items"
                ? "You have run out of required materials, tools, or consumables."
                : "That crafting action could not be validated.",
          type: "warning",
        });
        const session = this.activeSessions.get(pending.playerId);
        this.rejectProcessingRequest(
          pending.playerId,
          session?.requestId,
          "crafting",
          receipt.reason === "inventory_full"
            ? "capacity_unavailable"
            : receipt.reason === "insufficient_items"
              ? "resources_unavailable"
              : "persistence_rejected",
        );
        this.completeCrafting(pending.playerId);
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
      Logger.system("CraftingSystem", "craft_complete", {
        playerId: pending.playerId,
        recipeId: session.recipeId,
        operationId: pending.operationId,
        output: recipe.output,
        inputsConsumed: recipe.inputs.map(
          (input) => `${input.amount}x${input.item}`,
        ),
        consumableStates: receipt.consumableStates,
        xpAwarded: receipt.awardedXp,
        crafted: session.crafted,
        batchTotal: session.quantity,
      });
      const itemName = recipe.name || recipe.output.replace(/_/g, " ");
      if (!pending.stopAfterCommit) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message: `You craft a ${itemName}.`,
          type: "success",
        });
      }
      if (!receipt.liveInventoryApplied) {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message:
            "Your crafted item is safely recorded, but the live inventory view needs to resynchronize.",
          type: "warning",
        });
      }
      if (pending.stopAfterCommit) this.completeCrafting(pending.playerId);
      else this.scheduleNextCraft(pending.playerId);
    }
  }

  /**
   * Complete the crafting session
   */
  private completeCrafting(playerId: string): void {
    const session = this.activeSessions.get(playerId);
    if (!session) return;

    this.activeSessions.delete(playerId);
    clearProcessingInteractionPresentation(this.world, playerId, "crafting");

    const recipe = processingDataProvider.getCraftingRecipe(session.recipeId);

    // Emit completion event
    this.finishProcessingRequest(session.requestId);
    this.emitTypedEvent(EventType.CRAFTING_COMPLETE, {
      playerId,
      recipeId: session.recipeId,
      outputItemId: recipe?.output || session.recipeId,
      totalCrafted: session.crafted,
      totalXp: session.crafted * (recipe?.xp || 0),
      ...(session.requestId ? { requestId: session.requestId } : {}),
    });
  }

  /**
   * Cancel crafting for a player
   */
  private cancelCrafting(playerId: string): void {
    clearProcessingInteractionPresentation(this.world, playerId, "crafting");
    const pending = this.pendingActions.get(playerId);
    if (pending) {
      pending.stopAfterCommit = true;
      return;
    }
    const session = this.activeSessions.get(playerId);
    if (session) {
      this.completeCrafting(playerId);
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
    recipe: CraftingRecipeData,
  ): boolean {
    if (recipe.tools.length === 0) return true;
    return recipe.tools.every((tool) => state.itemIds.has(tool));
  }

  /**
   * Check if player has required input materials
   */
  private hasRequiredInputs(
    state: InventoryState,
    recipe: CraftingRecipeData,
  ): boolean {
    return recipe.inputs.every((input) => {
      const count = state.counts.get(input.item) || 0;
      return count >= input.amount;
    });
  }

  /**
   * Check if player has required consumables (e.g., thread)
   */
  private hasRequiredConsumables(
    state: InventoryState,
    recipe: CraftingRecipeData,
  ): boolean {
    if (recipe.consumables.length === 0) return true;
    return recipe.consumables.every((c) => state.itemIds.has(c.item));
  }

  /**
   * Get player's crafting level using type-safe access
   */
  private getCraftingLevel(playerId: string): number {
    // Check cached skills first
    const cachedSkills = this.playerSkills.get(playerId);
    if (cachedSkills?.crafting?.level != null) {
      return cachedSkills.crafting.level;
    }

    // Fall back to player entity using type-safe guard
    const player = this.world.getPlayer(playerId);
    if (!hasSkills(player)) return 1;
    const craftingSkill =
      player.skills?.["crafting" as keyof typeof player.skills];
    return craftingSkill?.level ?? 1;
  }

  /**
   * Check if player is currently crafting
   */
  isPlayerCrafting(playerId: string): boolean {
    return this.activeSessions.has(playerId);
  }

  requestPlayerProcessingQuiescence(playerId: string): void {
    this.interactionSessions.delete(playerId);
    this.cancelCrafting(playerId);
  }

  isPlayerProcessingQuiescent(playerId: string): boolean {
    return (
      !this.activeSessions.has(playerId) &&
      !this.interactionSessions.has(playerId) &&
      !this.pendingActions.has(playerId)
    );
  }

  canPlayerUseCraftingFurnace(playerId: string, furnaceId: string): boolean {
    return canPlayerUseProcessingStation(
      this.world,
      playerId,
      furnaceId,
      "furnace",
    );
  }

  canPlayerUseActiveCraftingFurnace(playerId: string): boolean {
    const session = this.interactionSessions.get(playerId);
    return (
      session?.triggerType === "furnace" &&
      !!session.stationId &&
      this.canPlayerUseCraftingFurnace(playerId, session.stationId)
    );
  }

  getRecipeStation(recipeId: string): "none" | "furnace" | null {
    const recipe = processingDataProvider.getCraftingRecipe(recipeId);
    if (!recipe) return null;
    return recipe.station === "furnace" ? "furnace" : "none";
  }

  getCraftingCustodyStats(): {
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
   * Update method - processes tick-based crafting sessions.
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
        "crafting",
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
      this.completeCraft(playerId);
    }
  }

  destroy(): void {
    this.destroyed = true;
    // Complete all active sessions
    for (const playerId of this.activeSessions.keys()) {
      this.completeCrafting(playerId);
    }
    this.activeSessions.clear();
    this.interactionSessions.clear();
    this.pendingActions.clear();
    this.playerSkills.clear(); // Memory cleanup
  }
}
