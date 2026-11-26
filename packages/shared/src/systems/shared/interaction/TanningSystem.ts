/**
 * TanningSystem - authoritative hide-to-leather conversion at Tanner NPCs.
 *
 * A tanning action is instant from the player's perspective, but custody is
 * not exposed until one durable receipt commits its hide debit, money-pouch
 * debit, and leather output. Every caller must first establish an exact,
 * physically valid Tanner session through TANNING_INTERACT.
 */

import {
  getItemQuantity,
  isLooseInventoryItem,
} from "../../../constants/SmithingConstants";
import {
  processingDataProvider,
  type TanningRecipeData,
} from "../../../data/ProcessingDataProvider";
import {
  EventType,
  getProcessingRequestOperationId,
} from "../../../types/events";
import type { World } from "../../../types/index";
import { uuid } from "../../../utils";
import { Logger } from "../../../utils/Logger";
import type { CoinPouchSystem } from "../character/CoinPouchSystem";
import type {
  AtomicProcessingActionReceipt,
  InventorySystem,
} from "../character/InventorySystem";
import { SystemBase } from "../infrastructure/SystemBase";
import {
  clearProcessingInteractionPresentation,
  publishProcessingInteractionPresentation,
} from "./ProcessingInteractionPresentation";
import type { PlayerProcessingQuiescenceSystem } from "./ProcessingQuiescence";
import { canPlayerPerformPreparationAction } from "./ProcessingStationAuthority";

interface PositionLike {
  x: number;
  y: number;
  z: number;
}

interface TannerSession {
  npcId: string;
  npcEntityId: string;
}

interface PendingTanningAction {
  operationId: string;
  playerId: string;
  npcId: string;
  npcEntityId: string;
  inputItemId: string;
  outputItemId: string;
  itemName: string;
  quantity: number;
  totalCost: number;
  retryCount: number;
  retryAtTick: number;
  state: "in_flight" | "retry_wait" | "settled";
  receipt: AtomicProcessingActionReceipt | null;
  disconnected: boolean;
  presentationCancelled: boolean;
  requestId?: string;
}

interface TannerEntityLike {
  position?: unknown;
  getPosition?: () => unknown;
  config?: {
    npcType?: unknown;
    npcId?: unknown;
    interactionDistance?: unknown;
  };
  data?: {
    npcType?: unknown;
    npcId?: unknown;
    interactionDistance?: unknown;
    inStreamingDuel?: unknown;
  };
}

export class TanningSystem
  extends SystemBase
  implements PlayerProcessingQuiescenceSystem
{
  private readonly activeSessions = new Map<string, TannerSession>();
  private readonly pendingActions = new Map<string, PendingTanningAction>();
  private lastProcessedTick = -1;
  private destroyed = false;

  constructor(world: World) {
    super(world, {
      name: "tanning",
      dependencies: {
        required: [],
        optional: ["inventory", "coin-pouch"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    if (!this.world.isServer) return;

    this.subscribe(
      EventType.TANNING_INTERACT,
      (data: { playerId: string; npcId: string; npcEntityId?: string }) => {
        this.handleTanningInteract(data);
      },
    );
    this.subscribe(
      EventType.TANNING_REQUEST,
      (data: {
        playerId: string;
        inputItemId: string;
        quantity: number;
        requestId?: string;
      }) => {
        this.handleTanningRequest(data);
      },
    );
    this.subscribe<{
      playerId: string;
      targetPosition: { x: number; y: number; z: number };
    }>(EventType.MOVEMENT_CLICK_TO_MOVE, (data) => {
      this.activeSessions.delete(data.playerId);
      const pending = this.pendingActions.get(data.playerId);
      if (pending) {
        pending.presentationCancelled = true;
        clearProcessingInteractionPresentation(
          this.world,
          data.playerId,
          "tanning",
        );
      }
    });
    this.subscribe(
      EventType.COMBAT_STARTED,
      (data: { attackerId: string; targetId: string }) => {
        this.activeSessions.delete(data.attackerId);
        this.activeSessions.delete(data.targetId);
        const attackerPending = this.pendingActions.get(data.attackerId);
        const targetPending = this.pendingActions.get(data.targetId);
        if (attackerPending) {
          attackerPending.presentationCancelled = true;
          clearProcessingInteractionPresentation(
            this.world,
            data.attackerId,
            "tanning",
          );
        }
        if (targetPending) {
          targetPending.presentationCancelled = true;
          clearProcessingInteractionPresentation(
            this.world,
            data.targetId,
            "tanning",
          );
        }
      },
    );
    this.subscribe(
      EventType.PLAYER_UNREGISTERED,
      (data: { playerId: string }) => {
        this.activeSessions.delete(data.playerId);
        clearProcessingInteractionPresentation(
          this.world,
          data.playerId,
          "tanning",
        );
        const pending = this.pendingActions.get(data.playerId);
        if (pending) pending.disconnected = true;
      },
    );
  }

  private handleTanningInteract(data: {
    playerId: string;
    npcId: string;
    npcEntityId?: string;
  }): void {
    const playerId = String(data.playerId ?? "").trim();
    const npcId = String(data.npcId ?? "").trim();
    const npcEntityId = String(data.npcEntityId ?? "").trim();
    if (!this.canPlayerUseTanner(playerId, npcEntityId, npcId)) {
      this.activeSessions.delete(playerId);
      Logger.system("TanningSystem", "tanner_interaction_rejected", {
        playerId,
        npcId,
        npcEntityId,
      });
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You must be next to a Tanner to use that service.",
        type: "error",
      });
      return;
    }

    this.activeSessions.set(playerId, { npcId, npcEntityId });
    const inventory = this.world.getInventory?.(playerId);
    if (!inventory || !Array.isArray(inventory)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You have no items.",
        type: "error",
      });
      return;
    }

    const inventoryCounts = new Map<string, number>();
    for (const item of inventory) {
      if (!isLooseInventoryItem(item)) continue;
      inventoryCounts.set(
        item.itemId,
        (inventoryCounts.get(item.itemId) ?? 0) + getItemQuantity(item),
      );
    }
    const allRecipes = processingDataProvider.getAllTanningRecipes();
    if (allRecipes.length === 0) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "There are no tanning recipes available.",
        type: "error",
      });
      return;
    }

    this.emitTypedEvent(EventType.TANNING_INTERFACE_OPEN, {
      playerId,
      availableRecipes: allRecipes.map((recipe) => {
        const hideCount = inventoryCounts.get(recipe.input) ?? 0;
        return {
          input: recipe.input,
          output: recipe.output,
          cost: recipe.cost,
          name: recipe.name,
          hasHide: hideCount > 0,
          hideCount,
        };
      }),
    });
  }

  private handleTanningRequest(data: {
    playerId: string;
    inputItemId: string;
    quantity: number;
    requestId?: string;
  }): void {
    const playerId = String(data.playerId ?? "").trim();
    const inputItemId = String(data.inputItemId ?? "").trim();
    if (this.pendingActions.has(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Your previous tanning action is still being verified.",
        type: "info",
      });
      this.rejectProcessingRequest(
        playerId,
        data.requestId,
        "tanning",
        "busy",
        true,
      );
      return;
    }

    const session = this.activeSessions.get(playerId);
    if (
      !session ||
      !this.canPlayerUseTanner(playerId, session.npcEntityId, session.npcId)
    ) {
      this.activeSessions.delete(playerId);
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You must remain next to the Tanner to tan hides.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        data.requestId,
        "tanning",
        "not_authorized",
      );
      return;
    }

    const requestedQuantity = Number(data.quantity);
    const recipe = processingDataProvider.getTanningRecipe(inputItemId);
    if (
      !recipe ||
      !Number.isSafeInteger(requestedQuantity) ||
      requestedQuantity <= 0 ||
      requestedQuantity > 10_000 ||
      !this.isValidRecipe(recipe)
    ) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Invalid tanning request.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        data.requestId,
        "tanning",
        "invalid_request",
      );
      return;
    }

    const inventory = this.world.getInventory?.(playerId);
    if (!inventory || !Array.isArray(inventory)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You have no items.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        data.requestId,
        "tanning",
        "resources_unavailable",
      );
      return;
    }
    let hideCount = 0;
    for (const item of inventory) {
      if (isLooseInventoryItem(item) && item.itemId === inputItemId) {
        hideCount += getItemQuantity(item);
      }
    }
    if (hideCount <= 0) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "You don't have any hides to tan.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        data.requestId,
        "tanning",
        "resources_unavailable",
      );
      return;
    }

    const coinPouch = this.world.getSystem("coin-pouch") as
      CoinPouchSystem | undefined;
    if (!coinPouch?.isPlayerInitialized(playerId)) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Your money pouch is not ready yet.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        data.requestId,
        "tanning",
        "not_authorized",
        true,
      );
      return;
    }
    const affordableQuantity =
      recipe.cost === 0
        ? requestedQuantity
        : Math.floor(coinPouch.getCoins(playerId) / recipe.cost);
    const quantity = Math.min(requestedQuantity, hideCount, affordableQuantity);
    if (quantity <= 0) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: `You need ${recipe.cost} coins per hide. You don't have enough coins.`,
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        data.requestId,
        "tanning",
        "resources_unavailable",
      );
      return;
    }
    const totalCost = quantity * recipe.cost;
    if (!Number.isSafeInteger(totalCost) || totalCost < 0) {
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: "Invalid tanning request.",
        type: "error",
      });
      this.rejectProcessingRequest(
        playerId,
        data.requestId,
        "tanning",
        "invalid_request",
      );
      return;
    }

    const pending: PendingTanningAction = {
      operationId:
        getProcessingRequestOperationId("tanning", data.requestId) ??
        `tanning-action:${uuid()}${uuid()}`,
      playerId,
      npcId: session.npcId,
      npcEntityId: session.npcEntityId,
      inputItemId: recipe.input,
      outputItemId: recipe.output,
      itemName: recipe.name || recipe.output.replace(/_/g, " "),
      quantity,
      totalCost,
      retryCount: 0,
      retryAtTick: 0,
      state: "in_flight",
      receipt: null,
      disconnected: false,
      presentationCancelled: false,
      requestId: data.requestId,
    };
    this.pendingActions.set(playerId, pending);
    publishProcessingInteractionPresentation(this.world, {
      playerId,
      skill: "tanning",
      targetEntityId: pending.npcEntityId,
    });
    this.reportProcessingRequestProgress(
      playerId,
      data.requestId,
      "tanning",
      "accepted",
      true,
    );
    this.launchCommit(pending);
  }

  private launchCommit(pending: PendingTanningAction): void {
    const inventory = this.world.getSystem("inventory") as
      InventorySystem | undefined;
    if (!inventory?.commitProcessingActionAtomic) {
      this.scheduleRetry(pending);
      return;
    }
    pending.state = "in_flight";
    void inventory
      .commitProcessingActionAtomic(pending.playerId, pending.operationId, {
        skill: "crafting",
        xpAmount: 0,
        inputs: [{ itemId: pending.inputItemId, quantity: pending.quantity }],
        outputs: [{ itemId: pending.outputItemId, quantity: pending.quantity }],
        coinCost: pending.totalCost,
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

  private scheduleRetry(pending: PendingTanningAction): void {
    pending.retryCount++;
    pending.retryAtTick =
      (this.world.currentTick ?? 0) +
      Math.min(2 ** Math.min(pending.retryCount, 6), 50);
    pending.receipt = null;
    pending.state = "retry_wait";
    this.reportProcessingRequestProgress(
      pending.playerId,
      pending.requestId,
      "tanning",
      "reconciling",
      true,
    );
  }

  private processPendingActions(currentTick: number): void {
    for (const pending of this.pendingActions.values()) {
      this.reportProcessingRequestProgress(
        pending.playerId,
        pending.requestId,
        "tanning",
        pending.state === "retry_wait" ? "reconciling" : "working",
      );
      if (
        pending.state === "retry_wait" &&
        currentTick >= pending.retryAtTick
      ) {
        this.launchCommit(pending);
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
          "tanning",
        );
        this.rejectProcessingRequest(
          pending.playerId,
          pending.requestId,
          "tanning",
          receipt.reason === "inventory_full"
            ? "capacity_unavailable"
            : receipt.reason === "insufficient_items" ||
                receipt.reason === "insufficient_coins"
              ? "resources_unavailable"
              : "persistence_rejected",
        );
        if (pending.disconnected) continue;
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: pending.playerId,
          message:
            receipt.reason === "inventory_full"
              ? "Your inventory is too full to hold the tanned leather."
              : receipt.reason === "insufficient_coins"
                ? "You no longer have enough coins for that tanning request."
                : receipt.reason === "insufficient_items"
                  ? "You no longer have enough hides to tan."
                  : "That tanning action could not be validated.",
          type: "warning",
        });
        continue;
      }

      if (!receipt.liveInventoryApplied) {
        if (pending.disconnected) {
          this.pendingActions.delete(pending.playerId);
          clearProcessingInteractionPresentation(
            this.world,
            pending.playerId,
            "tanning",
          );
        } else {
          this.scheduleRetry(pending);
        }
        continue;
      }

      this.pendingActions.delete(pending.playerId);
      clearProcessingInteractionPresentation(
        this.world,
        pending.playerId,
        "tanning",
      );
      this.finishProcessingRequest(pending.requestId);
      Logger.system("TanningSystem", "tanning_complete", {
        playerId: pending.playerId,
        operationId: pending.operationId,
        input: pending.inputItemId,
        output: pending.outputItemId,
        quantity: pending.quantity,
        coinCost: pending.totalCost,
        currentCoins: receipt.currentCoins,
        replayed: receipt.replayed,
      });
      if (!pending.disconnected) {
        this.emitTypedEvent(EventType.TANNING_COMPLETE, {
          playerId: pending.playerId,
          inputItemId: pending.inputItemId,
          outputItemId: pending.outputItemId,
          totalTanned: pending.quantity,
          totalCost: pending.totalCost,
          ...(pending.requestId ? { requestId: pending.requestId } : {}),
        });
      }
      if (pending.disconnected || pending.presentationCancelled) continue;
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId: pending.playerId,
        message:
          pending.quantity === 1
            ? `The Tanner turns your hide into ${pending.itemName}.`
            : `The Tanner turns ${pending.quantity} hides into ${pending.itemName}.`,
        type: "success",
      });
    }
  }

  /** Shared, authoritative Tanner authorization for every caller. */
  canPlayerUseTanner(
    playerId: string,
    npcEntityId: string,
    expectedNpcId?: string,
  ): boolean {
    if (!canPlayerPerformPreparationAction(this.world, playerId)) return false;
    const player =
      this.world.getPlayer(playerId) ?? this.world.entities.get(playerId);
    const tanner = this.world.entities.get(npcEntityId) as unknown as
      TannerEntityLike | undefined;
    if (!player || !tanner || this.isPlayerInDuel(playerId, player)) {
      return false;
    }

    const npcType = tanner.config?.npcType ?? tanner.data?.npcType;
    const npcId = tanner.config?.npcId ?? tanner.data?.npcId;
    if (
      npcType !== "tanner" ||
      typeof npcId !== "string" ||
      !npcId ||
      (expectedNpcId !== undefined && npcId !== expectedNpcId)
    ) {
      return false;
    }
    const playerPosition = this.getFinitePosition(player);
    const tannerPosition = this.getFinitePosition(tanner);
    if (!playerPosition || !tannerPosition) return false;

    const configuredDistance = Number(
      tanner.config?.interactionDistance ??
        tanner.data?.interactionDistance ??
        3,
    );
    if (
      !Number.isFinite(configuredDistance) ||
      configuredDistance <= 0 ||
      configuredDistance > 10
    ) {
      return false;
    }
    return (
      Math.max(
        Math.abs(playerPosition.x - tannerPosition.x),
        Math.abs(playerPosition.z - tannerPosition.z),
      ) <= configuredDistance
    );
  }

  canPlayerUseActiveTanner(playerId: string): boolean {
    const session = this.activeSessions.get(playerId);
    return (
      !!session &&
      this.canPlayerUseTanner(playerId, session.npcEntityId, session.npcId)
    );
  }

  /** Return only the exact currently authorized Tanner identity. */
  getActiveTannerSession(
    playerId: string,
  ): { npcId: string; npcEntityId: string } | null {
    const session = this.activeSessions.get(playerId);
    if (
      !session ||
      !this.canPlayerUseTanner(playerId, session.npcEntityId, session.npcId)
    ) {
      return null;
    }
    return { ...session };
  }

  getTanningCustodyStats(): {
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

  requestPlayerProcessingQuiescence(playerId: string): void {
    this.activeSessions.delete(playerId);
    const pending = this.pendingActions.get(playerId);
    if (!pending) return;
    pending.presentationCancelled = true;
    clearProcessingInteractionPresentation(this.world, playerId, "tanning");
  }

  isPlayerProcessingQuiescent(playerId: string): boolean {
    return (
      !this.activeSessions.has(playerId) && !this.pendingActions.has(playerId)
    );
  }

  update(_dt: number): void {
    if (!this.world.isServer) return;
    const currentTick = this.world.currentTick ?? 0;
    if (currentTick === this.lastProcessedTick) return;
    this.lastProcessedTick = currentTick;
    this.processPendingActions(currentTick);
  }

  destroy(): void {
    this.destroyed = true;
    for (const playerId of this.pendingActions.keys()) {
      clearProcessingInteractionPresentation(this.world, playerId, "tanning");
    }
    this.activeSessions.clear();
    this.pendingActions.clear();
  }

  private isValidRecipe(recipe: TanningRecipeData): boolean {
    return (
      typeof recipe.input === "string" &&
      recipe.input.length > 0 &&
      typeof recipe.output === "string" &&
      recipe.output.length > 0 &&
      Number.isSafeInteger(recipe.cost) &&
      recipe.cost >= 0 &&
      recipe.cost <= 2_147_483_647
    );
  }

  private isPlayerInDuel(playerId: string, player: unknown): boolean {
    const playerData = (player as TannerEntityLike).data;
    if (playerData?.inStreamingDuel === true) return true;
    const duel = this.world.getSystem("duel") as
      { isPlayerInDuel?: (id: string) => boolean } | undefined;
    try {
      return duel?.isPlayerInDuel?.(playerId) === true;
    } catch {
      return true;
    }
  }

  private getFinitePosition(entity: unknown): PositionLike | null {
    if (!entity || typeof entity !== "object") return null;
    const candidate = entity as TannerEntityLike;
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
}
