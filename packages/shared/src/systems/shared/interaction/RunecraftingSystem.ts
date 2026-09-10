/**
 * RunecraftingSystem - Instant Essence-to-Rune Conversion at Altars
 *
 * rules-accurate runecrafting implementation:
 * - Click altar to instantly convert all carried essence into runes
 * - Two essence types: rune_essence (basic runes), pure_essence (all runes)
 * - Multi-rune crafting at higher levels (e.g., 2x air runes at level 11)
 * - Grants runecrafting XP per essence consumed
 *
 * Unlike smelting/smithing, runecrafting is INSTANT (no tick-based sessions).
 * One click converts all valid essence in inventory at once.
 *
 * @see ProcessingDataProvider for runecrafting recipes from manifest
 */

import {
  isLooseInventoryItem,
  getItemQuantity,
  hasSkills,
} from "../../../constants/SmithingConstants";
import { processingDataProvider } from "../../../data/ProcessingDataProvider";
import {
  EventType,
  getProcessingRequestOperationId,
} from "../../../types/events";
import type { InventoryDebitRequirement } from "../../../types/network/database";
import { uuid } from "../../../utils";
import { Logger } from "../../../utils/Logger";
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

interface PendingRunecraftingAction {
  operationId: string;
  playerId: string;
  altarId: string;
  runeType: string;
  runeItemId: string;
  runeName: string;
  inputs: InventoryDebitRequirement[];
  essenceConsumed: number;
  runesProduced: number;
  multiplier: number;
  xpAwarded: number;
  retryCount: number;
  retryAtTick: number;
  state: "in_flight" | "retry_wait" | "settled";
  receipt: AtomicProcessingActionReceipt | null;
  disconnected: boolean;
  presentationCancelled: boolean;
  requestId?: string;
}

interface PositionLike {
  x: number;
  y: number;
  z: number;
}

interface RunecraftingAltarLike {
  entityType?: unknown;
  runeType?: unknown;
  isPlayerInRange?: (position: PositionLike) => boolean;
}

export class RunecraftingSystem
  extends SystemBase
  implements PlayerProcessingQuiescenceSystem
{
  private readonly pendingActions = new Map<
    string,
    PendingRunecraftingAction
  >();

  /** Cache player skill levels to avoid repeated lookups */
  private readonly playerSkills = new Map<
    string,
    Record<string, { level: number; xp: number }>
  >();

  private destroyed = false;

  constructor(world: World) {
    super(world, {
      name: "runecrafting",
      dependencies: {
        required: [],
        optional: ["inventory", "skills"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // Server-only system
    if (!this.world.isServer) return;

    // Listen for altar interactions
    this.subscribe(
      EventType.RUNECRAFTING_INTERACT,
      (data: {
        playerId: string;
        altarId: string;
        runeType: string;
        requestId?: string;
      }) => {
        this.handleRunecraftingInteract(data);
      },
    );

    // Cache skill updates
    this.subscribe(
      EventType.SKILLS_UPDATED,
      (data: {
        playerId: string;
        skills: Record<string, { level: number; xp: number }>;
      }) => {
        this.playerSkills.set(data.playerId, data.skills);
      },
    );

    // Clean up on player disconnect
    this.subscribe(
      EventType.PLAYER_UNREGISTERED,
      (data: { playerId: string }) => {
        this.playerSkills.delete(data.playerId);
        clearProcessingInteractionPresentation(
          this.world,
          data.playerId,
          "runecrafting",
        );
        const pending = this.pendingActions.get(data.playerId);
        if (pending) pending.disconnected = true;
      },
    );
    this.subscribe<{
      playerId: string;
      targetPosition: { x: number; y: number; z: number };
    }>(EventType.MOVEMENT_CLICK_TO_MOVE, (data) => {
      const pending = this.pendingActions.get(data.playerId);
      if (pending) {
        pending.presentationCancelled = true;
        clearProcessingInteractionPresentation(
          this.world,
          data.playerId,
          "runecrafting",
        );
      }
    });
    this.subscribe(
      EventType.COMBAT_STARTED,
      (data: { attackerId: string; targetId: string }) => {
        const attackerPending = this.pendingActions.get(data.attackerId);
        const targetPending = this.pendingActions.get(data.targetId);
        if (attackerPending) {
          attackerPending.presentationCancelled = true;
          clearProcessingInteractionPresentation(
            this.world,
            data.attackerId,
            "runecrafting",
          );
        }
        if (targetPending) {
          targetPending.presentationCancelled = true;
          clearProcessingInteractionPresentation(
            this.world,
            data.targetId,
            "runecrafting",
          );
        }
      },
    );
  }

  /**
   * Handle altar interaction — instantly convert all essence into runes.
   */
  private handleRunecraftingInteract(data: {
    playerId: string;
    altarId: string;
    runeType: string;
    requestId?: string;
  }): void {
    const { playerId, altarId, runeType, requestId } = data;

    if (this.pendingActions.has(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Your previous runecrafting action is still being verified.",
        type: "info",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "runecrafting",
        "busy",
        true,
      );
      return;
    }

    // This shared server boundary is authoritative for every caller (network,
    // autonomous agent, or another server system). Do not trust a caller to
    // pair a rune type with the correct altar or to enforce physical range.
    if (!this.isAuthorizedAltarInteraction(playerId, altarId, runeType)) {
      Logger.system("RunecraftingSystem", "altar_interaction_rejected", {
        playerId,
        altarId,
        runeType,
      });
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You must be next to the correct altar to craft those runes.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "runecrafting",
        "not_authorized",
      );
      return;
    }

    // Get recipe data
    const recipe = processingDataProvider.getRunecraftingRecipe(runeType);
    if (!recipe) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Nothing interesting happens.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "runecrafting",
        "invalid_request",
      );
      return;
    }

    // Get player's runecrafting level
    const rcLevel = this.getRunecraftingLevel(playerId);

    // Check level requirement
    if (rcLevel < recipe.levelRequired) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `You need a Runecrafting level of ${recipe.levelRequired} to craft ${recipe.name}s.`,
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "runecrafting",
        "requirements_not_met",
      );
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
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "runecrafting",
        "resources_unavailable",
      );
      return;
    }

    // Count valid essence in inventory
    const essenceSet = new Set(recipe.essenceTypes);
    let totalEssence = 0;
    const essenceCounts = new Map<string, number>();

    for (const item of inventory) {
      if (!isLooseInventoryItem(item)) continue;
      if (essenceSet.has(item.itemId)) {
        const qty = getItemQuantity(item);
        totalEssence += qty;
        essenceCounts.set(
          item.itemId,
          (essenceCounts.get(item.itemId) || 0) + qty,
        );
      }
    }

    if (totalEssence === 0) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You don't have any essence to craft runes.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "runecrafting",
        "resources_unavailable",
      );
      return;
    }

    // Calculate multi-rune multiplier
    const multiplier = processingDataProvider.getRunecraftingMultiplier(
      runeType,
      rcLevel,
    );
    const runesProduced = totalEssence * multiplier;
    const xpAwarded = totalEssence * recipe.xpPerEssence;

    if (
      !Number.isSafeInteger(totalEssence) ||
      totalEssence <= 0 ||
      !Number.isSafeInteger(runesProduced) ||
      runesProduced <= 0 ||
      !Number.isFinite(xpAwarded) ||
      xpAwarded < 0
    ) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "That runecrafting action could not be validated.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        requestId,
        "runecrafting",
        "invalid_request",
      );
      return;
    }

    const pending: PendingRunecraftingAction = {
      operationId:
        getProcessingRequestOperationId("runecrafting", requestId) ??
        `runecrafting-action:${uuid()}${uuid()}`,
      playerId,
      altarId,
      runeType,
      runeItemId: recipe.runeItemId,
      runeName: recipe.name,
      inputs: [...essenceCounts.entries()]
        .map(([itemId, quantity]) => ({ itemId, quantity }))
        .sort((left, right) => left.itemId.localeCompare(right.itemId)),
      essenceConsumed: totalEssence,
      runesProduced,
      multiplier,
      xpAwarded,
      retryCount: 0,
      retryAtTick: 0,
      state: "in_flight",
      receipt: null,
      disconnected: false,
      presentationCancelled: false,
      requestId,
    };
    this.pendingActions.set(playerId, pending);
    publishProcessingInteractionPresentation(this.world, {
      playerId,
      skill: "runecrafting",
      targetEntityId: altarId,
    });
    this.reportProcessingRequestProgress(
      playerId,
      requestId,
      "runecrafting",
      "accepted",
      true,
    );
    this.launchRunecraftingCommit(pending);
  }

  private launchRunecraftingCommit(pending: PendingRunecraftingAction): void {
    const inventory = this.world.getSystem("inventory") as
      InventorySystem | undefined;
    if (!inventory?.commitProcessingActionAtomic) {
      this.scheduleRetry(pending);
      return;
    }

    pending.state = "in_flight";
    void inventory
      .commitProcessingActionAtomic(pending.playerId, pending.operationId, {
        skill: "runecrafting",
        xpAmount: pending.xpAwarded,
        inputs: pending.inputs,
        requiredItems: [],
        consumables: [],
        outputs: [
          { itemId: pending.runeItemId, quantity: pending.runesProduced },
        ],
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
        this.scheduleRetry(pending);
      });
  }

  private scheduleRetry(pending: PendingRunecraftingAction): void {
    pending.retryCount++;
    pending.retryAtTick =
      (this.world.currentTick ?? 0) +
      Math.min(2 ** Math.min(pending.retryCount, 6), 50);
    pending.receipt = null;
    pending.state = "retry_wait";
    this.reportProcessingRequestProgress(
      pending.playerId,
      pending.requestId,
      "runecrafting",
      "reconciling",
      true,
    );
  }

  private processPendingActions(currentTick: number): void {
    for (const pending of this.pendingActions.values()) {
      this.reportProcessingRequestProgress(
        pending.playerId,
        pending.requestId,
        "runecrafting",
        pending.state === "retry_wait" ? "reconciling" : "working",
      );
      if (
        pending.state === "retry_wait" &&
        currentTick >= pending.retryAtTick
      ) {
        this.launchRunecraftingCommit(pending);
        continue;
      }
      if (pending.state !== "settled" || !pending.receipt) continue;

      const receipt = pending.receipt;
      if (!receipt.ok) {
        if (receipt.retryable) {
          this.scheduleRetry(pending);
          continue;
        }
        this.pendingActions.delete(pending.playerId);
        clearProcessingInteractionPresentation(
          this.world,
          pending.playerId,
          "runecrafting",
        );
        this.rejectProcessingRequest(
          pending.playerId,
          pending.requestId,
          "runecrafting",
          receipt.reason === "inventory_full"
            ? "capacity_unavailable"
            : receipt.reason === "insufficient_items"
              ? "resources_unavailable"
              : "persistence_rejected",
        );
        if (!pending.disconnected) {
          this.emitTypedEvent(EventType.UI_MESSAGE, {
            playerId: pending.playerId,
            message:
              receipt.reason === "inventory_full"
                ? "Your inventory is too full to hold the crafted runes."
                : receipt.reason === "insufficient_items"
                  ? "You no longer have the required essence."
                  : "That runecrafting action could not be validated.",
            type: "warning",
          });
        }
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
      clearProcessingInteractionPresentation(
        this.world,
        pending.playerId,
        "runecrafting",
      );
      this.finishProcessingRequest(pending.requestId);
      this.emitTypedEvent(EventType.RUNECRAFTING_COMPLETE, {
        playerId: pending.playerId,
        runeType: pending.runeType,
        runeItemId: pending.runeItemId,
        essenceConsumed: pending.essenceConsumed,
        runesProduced: pending.runesProduced,
        multiplier: pending.multiplier,
        xpAwarded: receipt.awardedXp,
        ...(pending.requestId ? { requestId: pending.requestId } : {}),
      });

      Logger.system("RunecraftingSystem", "runecrafting_complete", {
        playerId: pending.playerId,
        altarId: pending.altarId,
        runeType: pending.runeType,
        operationId: pending.operationId,
        replayed: receipt.replayed,
        essenceConsumed: pending.essenceConsumed,
        runesProduced: pending.runesProduced,
        multiplier: pending.multiplier,
        xpAwarded: receipt.awardedXp,
      });

      if (!pending.disconnected && !pending.presentationCancelled) {
        const multiplierText =
          pending.multiplier > 1 ? ` (${pending.multiplier}x multiplier)` : "";
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message: `You craft ${pending.runesProduced} ${pending.runeName}${pending.runesProduced !== 1 ? "s" : ""}${multiplierText}.`,
          type: "success",
        });
        if (!receipt.liveInventoryApplied) {
          this.emitTypedEvent(EventType.UI_MESSAGE, {
            playerId: pending.playerId,
            message:
              "Your runes are safely recorded, but the live inventory view needs to resynchronize.",
            type: "warning",
          });
        }
      }
    }
  }

  private isAuthorizedAltarInteraction(
    playerId: string,
    altarId: string,
    runeType: string,
  ): boolean {
    const altar = this.world.entities.get(altarId) as
      RunecraftingAltarLike | undefined;
    if (
      !canPlayerPerformPreparationAction(this.world, playerId) ||
      !altar ||
      altar.entityType !== "runecrafting_altar" ||
      typeof altar.runeType !== "string" ||
      altar.runeType !== runeType ||
      typeof altar.isPlayerInRange !== "function"
    ) {
      return false;
    }

    const player =
      this.world.getPlayer(playerId) ?? this.world.entities.get(playerId);
    const position = this.getFinitePosition(player);
    if (!position) return false;

    try {
      return altar.isPlayerInRange(position) === true;
    } catch {
      return false;
    }
  }

  private getFinitePosition(entity: unknown): PositionLike | null {
    if (!entity || typeof entity !== "object") return null;
    const candidate = entity as {
      position?: unknown;
      getPosition?: () => unknown;
    };
    let raw = candidate.position;
    if (!raw && typeof candidate.getPosition === "function") {
      try {
        raw = candidate.getPosition();
      } catch {
        return null;
      }
    }
    if (!raw || typeof raw !== "object") return null;
    const position = raw as Partial<PositionLike>;
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      return null;
    }
    return {
      x: position.x as number,
      y: position.y as number,
      z: position.z as number,
    };
  }

  /**
   * Get the player's runecrafting level from cached skills or entity.
   */
  private getRunecraftingLevel(playerId: string): number {
    // Try cached skills first
    const cached = this.playerSkills.get(playerId);
    if (cached?.runecrafting?.level != null) {
      return cached.runecrafting.level;
    }

    // Fall back to player entity using type-safe guard
    const player = this.world.getPlayer(playerId);
    if (!hasSkills(player)) return 1;
    const runecraftingSkill =
      player.skills?.["runecrafting" as keyof typeof player.skills];
    return runecraftingSkill?.level ?? 1;
  }

  getRunecraftingCustodyStats(): {
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
      pendingActions: this.pendingActions.size,
      inFlight,
      retryWaiting,
      maxRetryCount,
    };
  }

  requestPlayerProcessingQuiescence(playerId: string): void {
    const pending = this.pendingActions.get(playerId);
    if (!pending) return;
    pending.presentationCancelled = true;
    clearProcessingInteractionPresentation(
      this.world,
      playerId,
      "runecrafting",
    );
  }

  isPlayerProcessingQuiescent(playerId: string): boolean {
    return !this.pendingActions.has(playerId);
  }

  update(_dt: number): void {
    if (!this.world.isServer) return;
    this.processPendingActions(this.world.currentTick ?? 0);
  }

  destroy(): void {
    this.destroyed = true;
    for (const playerId of this.pendingActions.keys()) {
      clearProcessingInteractionPresentation(
        this.world,
        playerId,
        "runecrafting",
      );
    }
    this.pendingActions.clear();
    this.playerSkills.clear();
  }
}
