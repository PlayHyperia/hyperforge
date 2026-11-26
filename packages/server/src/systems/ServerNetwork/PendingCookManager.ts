/**
 * PendingCookManager - Server-Authoritative Cooking
 *
 * Modeled after PendingGatherManager for resource gathering.
 * Handles the movement-to-cook flow when a player clicks a fire.
 *
 * SERVER-AUTHORITATIVE FLOW:
 * 1. Player clicks fire → client sends cookingSourceInteract with fireId
 * 2. Server looks up fire's TRUE position from injected FireRegistry
 * 3. Server calculates best cardinal tile using GATHERING_CONSTANTS.GATHERING_RANGE
 * 4. Server paths player to that tile via movePlayerToward()
 * 5. Every tick, server checks if player arrived at cardinal tile
 * 6. When arrived, server starts cooking via PROCESSING_COOKING_REQUEST event
 *
 * DEPENDENCY INJECTION:
 * FireRegistry is injected via constructor instead of looked up via getSystem().
 * This improves testability and follows the Dependency Inversion Principle.
 *
 * @see PendingGatherManager - resource gathering equivalent
 * @see PendingAttackManager - combat equivalent
 */

import type { World } from "@hyperforge/shared";
import {
  EventType,
  worldToTileInto,
  tilesWithinMeleeRange,
  type TileCoord,
  GATHERING_CONSTANTS,
  canPlayerPerformPreparationAction,
} from "@hyperforge/shared";
import type { TileMovementManager } from "./tile-movement";

/**
 * Fire type - matches the Fire interface from resource-processing-types
 */
type Fire = {
  id: string;
  position: { x: number; y: number; z: number };
  playerId: string;
  createdAt: number;
  duration: number;
  isActive: boolean;
  mesh?: unknown;
};

/**
 * FireRegistry interface for dependency injection.
 * Allows PendingCookManager to access fire data without
 * directly coupling to ProcessingSystem.
 */
export interface FireRegistry {
  getActiveFires(): Map<string, Fire>;
}

/**
 * Cooking source - either a fire or a permanent range entity
 */
interface CookingSource {
  id: string;
  position: { x: number; y: number; z: number };
  isActive: boolean;
  sourceType: "fire" | "range";
}

/**
 * Pending cook request data
 */
interface PendingCook {
  playerId: string;
  sourceId: string;
  sourceType: "fire" | "range";
  /** Source tile position */
  sourceTile: TileCoord;
  /** Source world position */
  sourcePosition: { x: number; y: number; z: number };
  /** Last known player tile (for detecting arrival) */
  lastPlayerTile: TileCoord;
  /** When this pending cook was created (for timeout) */
  createdTick: number;
  /** Specific inventory slot to cook from (-1 = find first raw_shrimp) */
  fishSlot: number;
  /** Optional validated caller UUID echoed by the cooking completion. */
  requestId?: string;
}

/** Timeout for pending cooks (in ticks) - 20 ticks = 12 seconds at 600ms/tick */
const PENDING_COOK_TIMEOUT_TICKS = 20;

export class PendingCookManager {
  private world: World;
  private tileMovementManager: TileMovementManager;
  private fireRegistry: FireRegistry;

  /** Map of playerId → pending cook data */
  private pendingCooks: Map<string, PendingCook> = new Map();

  /** Pre-allocated tile buffers (zero-allocation hot path) */
  private readonly _playerTile: TileCoord = { x: 0, z: 0 };
  private readonly _fireTile: TileCoord = { x: 0, z: 0 };

  /**
   * Create a new PendingCookManager.
   *
   * @param world - World instance for player lookups
   * @param tileMovementManager - Movement manager for pathing
   * @param fireRegistry - Injected fire registry for dependency inversion
   */
  constructor(
    world: World,
    tileMovementManager: TileMovementManager,
    fireRegistry: FireRegistry,
  ) {
    this.world = world;
    this.tileMovementManager = tileMovementManager;
    this.fireRegistry = fireRegistry;
  }

  /**
   * Queue a pending cook for a player.
   * Called when player clicks a fire/range OR uses raw food on fire/range.
   *
   * SERVER-AUTHORITATIVE: Server looks up cooking source position and paths player.
   *
   * @param playerId - The player ID
   * @param sourceId - The fire or range ID
   * @param sourcePosition - Source world position from client (validated against server)
   * @param currentTick - Current game tick
   * @param runMode - Player's run mode preference from client
   * @param fishSlot - Specific inventory slot to cook from (-1 = find first raw_shrimp)
   */
  queuePendingCook(
    playerId: string,
    sourceId: string,
    sourcePosition: { x: number; y: number; z: number },
    currentTick: number,
    runMode?: boolean,
    fishSlot: number = -1,
    requestId?: string,
  ): void {
    // Cancel any existing pending cook
    this.cancelPendingCook(playerId, "interrupted");

    if (!canPlayerPerformPreparationAction(this.world, playerId)) {
      this.rejectPendingCook(playerId, requestId, "not_authorized", false);
      return;
    }

    // Look up cooking source - could be fire or range
    const cookingSource = this.getCookingSource(sourceId);

    if (!cookingSource) {
      console.log(
        `[PendingCook] Cooking source ${sourceId} not found or inactive`,
      );
      this.rejectPendingCook(playerId, requestId, "not_authorized", false);
      return;
    }

    // Get player entity
    const player = this.world.getPlayer?.(playerId);
    if (!player?.position) {
      console.warn(`[PendingCook] Player ${playerId} not found`);
      this.rejectPendingCook(playerId, requestId, "not_authorized", false);
      return;
    }

    // Calculate tiles
    worldToTileInto(player.position.x, player.position.z, this._playerTile);
    worldToTileInto(
      cookingSource.position.x,
      cookingSource.position.z,
      this._fireTile,
    );

    console.log(
      `[PendingCook] SERVER-AUTHORITATIVE: Player ${playerId} wants to cook at ${cookingSource.sourceType} ${sourceId}`,
    );
    console.log(
      `[PendingCook]   Source at tile (${this._fireTile.x}, ${this._fireTile.z})`,
    );
    console.log(
      `[PendingCook]   Player at tile (${this._playerTile.x}, ${this._playerTile.z})`,
    );

    // Check if already on a cardinal tile adjacent to source
    if (
      tilesWithinMeleeRange(
        this._playerTile,
        this._fireTile,
        GATHERING_CONSTANTS.GATHERING_RANGE,
      )
    ) {
      console.log(
        `[PendingCook]   Already on cardinal tile - starting cook immediately`,
      );
      this.startCooking(
        playerId,
        sourceId,
        cookingSource.sourceType,
        fishSlot,
        requestId,
      );
      return;
    }

    // Walk to cardinal tile adjacent to source
    const isRunning =
      runMode ?? this.tileMovementManager.getIsRunning(playerId);

    console.log(
      `[PendingCook]   Movement mode: ${isRunning ? "running" : "walking"}`,
    );

    // Use GATHERING_RANGE (1) for cardinal-only positioning
    this.tileMovementManager.movePlayerToward(
      playerId,
      cookingSource.position,
      isRunning,
      GATHERING_CONSTANTS.GATHERING_RANGE,
    );

    // Store pending cook
    this.pendingCooks.set(playerId, {
      playerId,
      sourceId,
      sourceType: cookingSource.sourceType,
      sourceTile: { x: this._fireTile.x, z: this._fireTile.z },
      sourcePosition: { ...cookingSource.position },
      lastPlayerTile: { x: this._playerTile.x, z: this._playerTile.z },
      createdTick: currentTick,
      fishSlot,
      ...(requestId ? { requestId } : {}),
    });

    console.log(
      `[PendingCook]   Queued pending cook, waiting for player to arrive`,
    );
  }

  /**
   * Look up a cooking source by ID - handles both fires and permanent ranges
   */
  private getCookingSource(sourceId: string): CookingSource | null {
    // First check fire registry
    const fires = this.fireRegistry.getActiveFires();
    const fire = fires.get(sourceId);
    if (fire && fire.isActive) {
      return {
        id: fire.id,
        position: fire.position,
        isActive: true,
        sourceType: "fire",
      };
    }

    // Check if it's a range entity
    const entity = this.world.entities.get(sourceId);
    if (entity && (entity as { entityType?: string }).entityType === "range") {
      const position = (
        entity as { position?: { x: number; y: number; z: number } }
      ).position;
      if (position) {
        return {
          id: sourceId,
          position,
          isActive: true,
          sourceType: "range",
        };
      }
    }

    return null;
  }

  /**
   * Cancel pending cook for a player
   */
  cancelPendingCook(
    playerId: string,
    reason: "interrupted" | "not_authorized" = "interrupted",
  ): void {
    const pending = this.pendingCooks.get(playerId);
    if (pending) {
      this.pendingCooks.delete(playerId);
      this.rejectPendingCook(playerId, pending.requestId, reason, true);
      console.log(`[PendingCook] Cancelled pending cook for ${playerId}`);
    }
  }

  /**
   * Clean up when a player disconnects.
   * Prevents memory leak from orphaned pending cook entries.
   */
  onPlayerDisconnect(playerId: string): void {
    if (this.pendingCooks.has(playerId)) {
      this.pendingCooks.delete(playerId);
      console.log(
        `[PendingCook] Cleaned up pending cook for disconnected player ${playerId}`,
      );
    }
  }

  /**
   * Process all pending cooks - called every tick
   * Checks if players have arrived at cardinal tiles and starts cooking
   */
  processTick(currentTick: number): void {
    for (const [playerId, pending] of this.pendingCooks) {
      try {
        this.processPlayerPendingCook(playerId, pending, currentTick);
      } catch (error) {
        console.error(
          `[PendingCook] Error processing player ${playerId} for ${pending.sourceType} ${pending.sourceId}:`,
          error,
        );
        this.pendingCooks.delete(playerId);
        this.rejectPendingCook(
          playerId,
          pending.requestId,
          "interrupted",
          true,
        );
      }
    }
  }

  /**
   * Process a single player's pending cook check
   */
  private processPlayerPendingCook(
    playerId: string,
    pending: PendingCook,
    currentTick: number,
  ): void {
    // Check timeout
    if (currentTick - pending.createdTick > PENDING_COOK_TIMEOUT_TICKS) {
      console.log(`[PendingCook] Timeout for ${playerId}`);
      this.pendingCooks.delete(playerId);
      this.rejectPendingCook(playerId, pending.requestId, "interrupted", true);
      return;
    }

    // Get player entity
    const player = this.world.getPlayer?.(playerId);
    if (
      !player?.position ||
      !canPlayerPerformPreparationAction(this.world, playerId)
    ) {
      this.pendingCooks.delete(playerId);
      this.rejectPendingCook(
        playerId,
        pending.requestId,
        "not_authorized",
        false,
      );
      return;
    }

    // Check if cooking source still exists and is active
    const cookingSource = this.getCookingSource(pending.sourceId);

    if (!cookingSource) {
      console.log(
        `[PendingCook] Source ${pending.sourceId} no longer available`,
      );
      this.pendingCooks.delete(playerId);
      this.rejectPendingCook(
        playerId,
        pending.requestId,
        "not_authorized",
        true,
      );
      return;
    }

    // Get current player tile
    worldToTileInto(player.position.x, player.position.z, this._playerTile);

    // Check if player arrived at cardinal tile adjacent to source
    const hasArrived = tilesWithinMeleeRange(
      this._playerTile,
      pending.sourceTile,
      GATHERING_CONSTANTS.GATHERING_RANGE,
    );

    if (hasArrived) {
      console.log(
        `[PendingCook] Player ${playerId} arrived at cardinal tile - starting cook`,
      );

      // Start cooking with the stored fishSlot
      this.startCooking(
        playerId,
        pending.sourceId,
        pending.sourceType,
        pending.fishSlot,
        pending.requestId,
      );

      // Remove from pending
      this.pendingCooks.delete(playerId);
    }
  }

  /**
   * Start the cooking process
   * @param sourceType - "fire" or "range"
   * @param fishSlot - Specific inventory slot to cook from (-1 = find first raw_shrimp)
   */
  private startCooking(
    playerId: string,
    sourceId: string,
    sourceType: "fire" | "range",
    fishSlot: number,
    requestId?: string,
  ): void {
    // Emit PROCESSING_COOKING_REQUEST event via EventBus - ProcessingSystem subscribes to EventBus
    // fishSlot = -1 means server should find first raw_shrimp slot
    const eventData = {
      playerId,
      fireId: sourceType === "fire" ? sourceId : undefined,
      rangeId: sourceType === "range" ? sourceId : undefined,
      sourceType,
      fishSlot,
      ...(requestId ? { requestId } : {}),
    };

    // Use EventBus (world.$eventBus) instead of EventEmitter (world.emit)
    // ProcessingSystem uses SystemBase.subscribe() which listens to EventBus
    if (this.world.$eventBus) {
      this.world.$eventBus.emitEvent(
        EventType.PROCESSING_COOKING_REQUEST,
        eventData,
        "PendingCookManager",
      );
    } else {
      // Fallback to EventEmitter if EventBus not available
      this.world.emit(EventType.PROCESSING_COOKING_REQUEST, eventData);
    }
  }

  private rejectPendingCook(
    playerId: string,
    requestId: string | undefined,
    reason: "interrupted" | "not_authorized",
    retryable: boolean,
  ): void {
    if (!requestId) return;
    const eventData = {
      playerId,
      requestId,
      skill: "cooking" as const,
      reason,
      retryable,
    };
    if (this.world.$eventBus) {
      this.world.$eventBus.emitEvent(
        EventType.PROCESSING_REQUEST_REJECTED,
        eventData,
        "PendingCookManager",
      );
    } else {
      this.world.emit(EventType.PROCESSING_REQUEST_REJECTED, eventData);
    }
  }
}
