/**
 * PendingGatherManager - Server-Authoritative Resource Gathering
 *
 * Modeled after PendingAttackManager for combat.
 * Handles the movement-to-gather flow when a player clicks a resource.
 *
 * SERVER-AUTHORITATIVE FLOW:
 * 1. Player clicks resource → client sends resourceInteract with resourceId
 * 2. Server looks up resource's TRUE position from ResourceSystem
 * 3. Server calculates best cardinal tile using GATHERING_CONSTANTS.GATHERING_RANGE
 * 4. Server paths player to that tile via movePlayerToward()
 * 5. Every tick, server checks if player arrived at cardinal tile
 * 6. When arrived, server sets face target via FaceDirectionManager and starts gathering
 * 7. At end of tick, FaceDirectionManager applies rotation (rules-accurate deferred facing)
 *
 * KEY DIFFERENCES FROM OLD APPROACH:
 * - Uses movePlayerToward() with GATHERING_RANGE (like combat's MELEE_RANGE_STANDARD)
 * - Tick-based processing (like PendingAttackManager) instead of setInterval
 * - Uses FaceDirectionManager for rotation (rules-accurate deferred face direction)
 * - No client-side position calculations
 *
 * @see PendingAttackManager - combat equivalent
 * @see FaceDirectionManager - handles rules-accurate rotation
 */

import type { World } from "@hyperforge/shared";
import {
  EventType,
  worldToTileInto,
  tileToWorld,
  tilesWithinMeleeRange,
  type TileCoord,
  type ResourceFootprint,
  FOOTPRINT_SIZES,
  GATHERING_CONSTANTS,
  canPlayerPerformPreparationAction,
  getGatheringRewardOperationIdForAttempt,
} from "@hyperforge/shared";
import type { TileMovementManager } from "./tile-movement";

/**
 * Pending gather request data
 */
interface PendingGather {
  playerId: string;
  resourceId: string;
  /** Resource anchor tile (SW corner for multi-tile resources) */
  resourceAnchorTile: TileCoord;
  /** Resource footprint size */
  footprintX: number;
  footprintZ: number;
  /** Last known player tile (for detecting arrival) */
  lastPlayerTile: TileCoord;
  /** When this pending gather was created (for timeout) */
  createdTick: number;
  /** Whether this is a fishing spot (uses tile-based shore arrival) */
  isFishing: boolean;
  /** Resource world position (for face direction) */
  resourcePosition: { x: number; y: number; z: number };
  /** Target shore tile for fishing (player must arrive at this exact tile) */
  targetShoreTile?: TileCoord;
  /** Reserved non-overlapping approach tile for trees and rocks. */
  targetApproachTile?: TileCoord;
  /** Preserve the caller's movement mode when a moving fishing spot replans. */
  runMode: boolean;
  /** Immutable autonomous action awaiting the first durable reward. */
  completionAttemptId?: string;
  /** Skill label for exact failure completion before ResourceSystem admission. */
  skill: string;
}

/**
 * Resource data from ResourceSystem
 */
interface ResourceData {
  id: string;
  position: { x: number; y: number; z: number };
  footprint?: ResourceFootprint;
  isAvailable?: boolean;
  skillRequired?: string;
  levelRequired?: number;
  type?: string;
}

/** Timeout for pending gathers (in ticks) - 20 ticks = 12 seconds at 600ms/tick */
const PENDING_GATHER_TIMEOUT_TICKS = 20;

export class PendingGatherManager {
  private world: World;
  private tileMovementManager: TileMovementManager;
  private sendFn: (name: string, data: unknown) => void;

  /** Map of playerId → pending gather data */
  private pendingGathers: Map<string, PendingGather> = new Map();
  /** One pending gatherer may own an approach tile at a time. */
  private approachReservations = new Map<
    string,
    { playerId: string; resourceId: string }
  >();
  /** Fishing spots can move while an agent is walking to shore. Replan only
   * after the current map iteration so delete/reinsert cannot be revisited in
   * the same pending-gather pass. */
  private fishingReplans = new Map<
    string,
    {
      resourceId: string;
      runMode: boolean;
      completionAttemptId?: string;
      skill: string;
    }
  >();

  /** Pre-allocated tile buffers (zero-allocation hot path) */
  private readonly _playerTile: TileCoord = { x: 0, z: 0 };
  private readonly _resourceTile: TileCoord = { x: 0, z: 0 };
  /** Pre-allocated tile for footprint iteration to avoid per-check allocations */
  private readonly _tempFootprintTile: TileCoord = { x: 0, z: 0 };

  private tileKey(tile: TileCoord): string {
    return `${tile.x},${tile.z}`;
  }

  private releaseApproachReservation(playerId: string): void {
    for (const [key, reservation] of this.approachReservations) {
      if (reservation.playerId === playerId) {
        this.approachReservations.delete(key);
      }
    }
  }

  private approachIsAvailable(playerId: string, tile: TileCoord): boolean {
    const reservation = this.approachReservations.get(this.tileKey(tile));
    if (reservation && reservation.playerId !== playerId) return false;
    const movement = this.tileMovementManager as TileMovementManager & {
      isTileAvailableForPlayer?: (playerId: string, tile: TileCoord) => boolean;
    };
    return movement.isTileAvailableForPlayer?.(playerId, tile) ?? true;
  }

  private reserveApproach(
    playerId: string,
    resourceId: string,
    tile: TileCoord,
  ): void {
    this.releaseApproachReservation(playerId);
    this.approachReservations.set(this.tileKey(tile), {
      playerId,
      resourceId,
    });
  }

  private findCardinalApproach(
    playerId: string,
    playerTile: TileCoord,
    resourceAnchor: TileCoord,
    footprintX: number,
    footprintZ: number,
  ): TileCoord | null {
    const footprint = new Set<string>();
    for (let ox = 0; ox < footprintX; ox++) {
      for (let oz = 0; oz < footprintZ; oz++) {
        footprint.add(`${resourceAnchor.x + ox},${resourceAnchor.z + oz}`);
      }
    }
    const candidates = new Map<string, TileCoord>();
    const directions = [
      { x: -1, z: 0 },
      { x: 0, z: -1 },
      { x: 0, z: 1 },
      { x: 1, z: 0 },
    ];
    for (let ox = 0; ox < footprintX; ox++) {
      for (let oz = 0; oz < footprintZ; oz++) {
        const occupiedX = resourceAnchor.x + ox;
        const occupiedZ = resourceAnchor.z + oz;
        for (const direction of directions) {
          const tile = {
            x: occupiedX + direction.x,
            z: occupiedZ + direction.z,
          };
          const key = this.tileKey(tile);
          if (!footprint.has(key)) candidates.set(key, tile);
        }
      }
    }
    return (
      [...candidates.values()]
        .filter((tile) => this.approachIsAvailable(playerId, tile))
        .sort((left, right) => {
          const leftDistance =
            (left.x - playerTile.x) ** 2 + (left.z - playerTile.z) ** 2;
          const rightDistance =
            (right.x - playerTile.x) ** 2 + (right.z - playerTile.z) ** 2;
          return (
            leftDistance - rightDistance || left.x - right.x || left.z - right.z
          );
        })[0] ?? null
    );
  }

  constructor(
    world: World,
    tileMovementManager: TileMovementManager,
    sendFn: (name: string, data: unknown) => void,
  ) {
    this.world = world;
    this.tileMovementManager = tileMovementManager;
    this.sendFn = sendFn;
  }

  /**
   * Get a player's skill level for a given skill.
   * Used to check level requirements before setting arrival emote.
   *
   * @param playerId - The player ID
   * @param skillName - The skill name (e.g., "fishing", "woodcutting", "mining")
   * @returns The player's level in that skill, or 1 if not found
   */
  private getPlayerSkillLevel(playerId: string, skillName: string): number {
    const player = this.world.getPlayer?.(playerId) as {
      skills?: Record<string, { level: number; xp: number }>;
      getComponent?: (type: string) => {
        [key: string]: { level: number; xp: number } | unknown;
      } | null;
    } | null;
    if (!player) return 1;

    // Try player.skills first (common pattern)
    if (player.skills?.[skillName]) {
      return player.skills[skillName].level ?? 1;
    }

    // Try stats component
    const stats = player.getComponent?.("stats");
    if (stats) {
      const skill = stats[skillName] as
        { level: number; xp: number } | undefined;
      return skill?.level ?? 1;
    }

    return 1;
  }

  /**
   * Check if a player meets the level requirement for a resource.
   *
   * @param playerId - The player ID
   * @param resource - The resource to check
   * @returns true if player meets requirements, false otherwise
   */
  private playerMeetsLevelRequirement(
    playerId: string,
    resource: ResourceData,
  ): boolean {
    if (!resource.skillRequired || resource.levelRequired === undefined) {
      return true; // No requirement specified
    }

    const playerLevel = this.getPlayerSkillLevel(
      playerId,
      resource.skillRequired,
    );
    return playerLevel >= resource.levelRequired;
  }

  /**
   * Queue a pending gather for a player.
   * Called when player clicks a resource.
   *
   * SERVER-AUTHORITATIVE: Server looks up resource position and paths player.
   *
   * @param playerId - The player ID
   * @param resourceId - The resource to gather
   * @param currentTick - Current game tick
   * @param runMode - Player's run mode preference from client (true = run, false = walk)
   */
  queuePendingGather(
    playerId: string,
    resourceId: string,
    currentTick: number,
    runMode?: boolean,
    completionAttemptId?: string,
  ): boolean {
    if (
      completionAttemptId !== undefined &&
      !getGatheringRewardOperationIdForAttempt(completionAttemptId)
    ) {
      return false;
    }
    if (!canPlayerPerformPreparationAction(this.world, playerId)) {
      this.cancelPendingGather(playerId);
      return false;
    }

    // PERF: Skip if player is already gathering this exact resource (avoids object allocations)
    const resourceSystem = this.world.getSystem("resource") as {
      getResource?: (id: string) => ResourceData | null;
      playerHasRequiredToolForResource?: (
        playerId: string,
        resourceId: string,
      ) => boolean;
      isPlayerGatheringResource?: (
        playerId: string,
        resourceId: string,
      ) => boolean;
      bindGatheringCompletionAttempt?: (
        playerId: string,
        resourceId: string,
        attemptId: string,
      ) => boolean;
      requestGathering?: (data: {
        playerId: string;
        resourceId: string;
        playerPosition: { x: number; y: number; z: number };
        completionAttemptId?: string;
      }) => boolean;
    } | null;

    // Early out if already gathering same resource (prevents repeated event emissions)
    if (resourceSystem?.isPlayerGatheringResource?.(playerId, resourceId)) {
      return completionAttemptId === undefined
        ? true
        : resourceSystem.bindGatheringCompletionAttempt?.(
            playerId,
            resourceId,
            completionAttemptId,
          ) === true;
    }

    if (!resourceSystem?.getResource) {
      console.warn("[PendingGather] No resource system available");
      return false;
    }
    if (completionAttemptId !== undefined && !resourceSystem.requestGathering) {
      return false;
    }

    const resource = resourceSystem.getResource(resourceId);
    if (!resource) {
      console.warn(`[PendingGather] Resource ${resourceId} not found`);
      return false;
    }

    if (!resource.isAvailable) {
      // Resource is depleted - silently ignore
      return false;
    }

    // Get player entity
    const player = this.world.getPlayer?.(playerId);
    if (!player?.position) {
      console.warn(`[PendingGather] Player ${playerId} not found`);
      return false;
    }

    // Get resource footprint
    const footprint: ResourceFootprint = resource.footprint || "standard";
    const size = FOOTPRINT_SIZES[footprint];

    // Detect if this is a fishing spot (uses distance check instead of tile adjacency)
    const isFishing =
      resource.skillRequired === "fishing" || resource.type === "fishing_spot";

    // Calculate tiles
    worldToTileInto(player.position.x, player.position.z, this._playerTile);
    worldToTileInto(
      resource.position.x,
      resource.position.z,
      this._resourceTile,
    );

    // PERF: Reduced logging - only log on actual state changes, not every tick

    // FISHING: Find shore tile FIRST, then check if player is already there
    // classic MMORPG behavior: Player ALWAYS walks to shore before fishing (not just "in range")
    if (isFishing) {
      // Find the closest walkable shore tile to the fishing spot
      const shoreTile = this.tileMovementManager.findClosestWalkableTile(
        resource.position,
        10, // Search up to 10 tiles away from fishing spot
        (tile) => this.approachIsAvailable(playerId, tile),
      );

      if (!shoreTile) {
        console.warn(
          `[PendingGather]   🎣 No walkable shore tile found near fishing spot!`,
        );
        return false;
      }

      // Only replace a valid pending gather after the new target has passed
      // authoritative resource, player, and shoreline validation.
      this.cancelPendingGather(playerId);
      this.reserveApproach(playerId, resourceId, shoreTile);

      // Check if player is ALREADY on the shore tile (exact match, not distance)
      if (
        this._playerTile.x === shoreTile.x &&
        this._playerTile.z === shoreTile.z
      ) {
        // PERF: Removed log - this happens every tick when agent spams gather
        this.setFaceTargetViaManager(
          playerId,
          this._resourceTile,
          size.x,
          size.z,
        );
        const started = this.startGathering(
          playerId,
          resourceId,
          completionAttemptId,
        );
        this.releaseApproachReservation(playerId);
        return started;
      }

      // Player not on shore tile - walk there
      console.log(
        `[PendingGather]   🎣 Walking to shore tile (${shoreTile.x}, ${shoreTile.z})`,
      );

      // Use run mode from client if provided, otherwise fall back to server state
      const isRunning =
        runMode ?? this.tileMovementManager.getIsRunning(playerId);

      // CRITICAL: Only set arrival emote if player meets ALL requirements (level + tool)
      // Without this, the fishing animation plays even when the player lacks the required tool
      const meetsLevel = this.playerMeetsLevelRequirement(playerId, resource);
      const hasTool =
        resourceSystem?.playerHasRequiredToolForResource?.(
          playerId,
          resourceId,
        ) !== false;
      if (meetsLevel && hasTool) {
        this.tileMovementManager.setArrivalEmote(playerId, "fishing");
      } else {
        console.log(
          `[PendingGather]   🎣 Player ${playerId} doesn't meet requirements (level: ${meetsLevel}, tool: ${hasTool}) - no fishing emote`,
        );
      }

      const shoreWorld = tileToWorld(shoreTile);
      this.tileMovementManager.movePlayerToward(
        playerId,
        { x: shoreWorld.x, y: 0, z: shoreWorld.z },
        isRunning,
        0, // Non-combat movement - go directly to tile
      );

      // Store pending gather WITH target shore tile
      this.pendingGathers.set(playerId, {
        playerId,
        resourceId,
        resourceAnchorTile: {
          x: this._resourceTile.x,
          z: this._resourceTile.z,
        },
        footprintX: size.x,
        footprintZ: size.z,
        lastPlayerTile: { x: this._playerTile.x, z: this._playerTile.z },
        createdTick: currentTick,
        isFishing: true,
        resourcePosition: { ...resource.position },
        targetShoreTile: { x: shoreTile.x, z: shoreTile.z },
        runMode: isRunning,
        completionAttemptId,
        skill: resource.skillRequired ?? "unknown",
      });

      console.log(
        `[PendingGather]   Queued fishing gather, waiting for player to arrive at shore`,
      );
      return true;
    } else {
      const approachTile = this.findCardinalApproach(
        playerId,
        this._playerTile,
        this._resourceTile,
        size.x,
        size.z,
      );
      if (!approachTile) {
        return false;
      }
      // Only replace a valid pending gather after the new target and its
      // non-overlapping physical approach have both been validated.
      this.cancelPendingGather(playerId);
      this.reserveApproach(playerId, resourceId, approachTile);

      // NON-FISHING: Check if already on the exact reserved approach tile.
      if (
        this._playerTile.x === approachTile.x &&
        this._playerTile.z === approachTile.z
      ) {
        // PERF: Removed log - this happens every tick when agent spams gather
        this.setFaceTargetViaManager(
          playerId,
          this._resourceTile,
          size.x,
          size.z,
        );
        const started = this.startGathering(
          playerId,
          resourceId,
          completionAttemptId,
        );
        this.releaseApproachReservation(playerId);
        return started;
      }

      this._tempFootprintTile.x = approachTile.x;
      this._tempFootprintTile.z = approachTile.z;
    }

    // NON-FISHING: Walk to cardinal tile adjacent to resource
    // (Fishing is handled above and returns early)

    // Use run mode from client if provided, otherwise fall back to server state
    const isRunning =
      runMode ?? this.tileMovementManager.getIsRunning(playerId);

    // CRITICAL: Set arrival emote BEFORE pathing (like fishing)
    // This bundles the emote with tileMovementEnd packet for atomic delivery
    // Only set if player meets ALL requirements (level + tool) to prevent
    // animation playing when gathering will fail validation
    const meetsLevelNonFish = this.playerMeetsLevelRequirement(
      playerId,
      resource,
    );
    const hasToolNonFish =
      resourceSystem?.playerHasRequiredToolForResource?.(
        playerId,
        resourceId,
      ) !== false;
    if (meetsLevelNonFish && hasToolNonFish) {
      // Map skill to emote name
      const skillToEmote: Record<string, string> = {
        woodcutting: "chopping",
        mining: "mining",
      };
      const emote = skillToEmote[resource.skillRequired ?? ""] ?? null;
      if (emote) {
        this.tileMovementManager.setArrivalEmote(playerId, emote);
        console.log(
          `[PendingGather]   🎬 Set arrival emote "${emote}" for ${resource.skillRequired}`,
        );
      }
    } else {
      console.log(
        `[PendingGather]   Player ${playerId} doesn't meet requirements (level: ${meetsLevelNonFish}, tool: ${hasToolNonFish}) - no gathering emote`,
      );
    }

    // Path to the exact cardinal approach reserved for this gatherer.
    const approachWorld = tileToWorld(this._tempFootprintTile);
    this.tileMovementManager.movePlayerToward(
      playerId,
      { x: approachWorld.x, y: resource.position.y, z: approachWorld.z },
      isRunning,
      0,
    );

    // Store pending gather (non-fishing only, fishing returns early)
    this.pendingGathers.set(playerId, {
      playerId,
      resourceId,
      resourceAnchorTile: { x: this._resourceTile.x, z: this._resourceTile.z },
      footprintX: size.x,
      footprintZ: size.z,
      lastPlayerTile: { x: this._playerTile.x, z: this._playerTile.z },
      createdTick: currentTick,
      isFishing: false,
      resourcePosition: { ...resource.position },
      targetApproachTile: {
        x: this._tempFootprintTile.x,
        z: this._tempFootprintTile.z,
      },
      runMode: isRunning,
      completionAttemptId,
      skill: resource.skillRequired ?? "unknown",
    });

    console.log(
      `[PendingGather]   Queued pending gather, waiting for player to arrive`,
    );
    return true;
  }

  /**
   * Cancel pending gather for a player
   */
  cancelPendingGather(playerId: string, publishFailure = true): void {
    this.fishingReplans.delete(playerId);
    this.releaseApproachReservation(playerId);
    const pending = this.pendingGathers.get(playerId);
    if (pending) {
      this.pendingGathers.delete(playerId);
      if (publishFailure) this.publishPendingGatherFailure(pending);
      console.log(`[PendingGather] Cancelled pending gather for ${playerId}`);
    }
  }

  private publishPendingGatherFailure(
    pending: Pick<
      PendingGather,
      "playerId" | "resourceId" | "completionAttemptId" | "skill"
    >,
  ): void {
    const operationId = getGatheringRewardOperationIdForAttempt(
      pending.completionAttemptId,
    );
    if (!operationId) return;
    this.world.emit(EventType.RESOURCE_GATHERING_COMPLETED, {
      playerId: pending.playerId,
      resourceId: pending.resourceId,
      successful: false,
      skill: pending.skill,
      operationId,
    });
  }

  /**
   * Clean up when a player disconnects.
   * Prevents memory leak from orphaned pending gather entries.
   */
  onPlayerDisconnect(playerId: string): void {
    this.fishingReplans.delete(playerId);
    this.releaseApproachReservation(playerId);
    const pending = this.pendingGathers.get(playerId);
    if (pending) {
      this.pendingGathers.delete(playerId);
      this.publishPendingGatherFailure(pending);
      console.log(
        `[PendingGather] Cleaned up pending gather for disconnected player ${playerId}`,
      );
    }
  }

  /**
   * Process all pending gathers - called every tick
   * Checks if players have arrived at cardinal tiles and starts gathering
   *
   * ROBUSTNESS: Each player is processed independently with try/catch.
   * If one player's processing fails, others continue normally.
   */
  processTick(currentTick: number): void {
    for (const [playerId, pending] of this.pendingGathers) {
      try {
        this.processPlayerPendingGather(playerId, pending, currentTick);
      } catch (error) {
        // Log error with context for debugging
        console.error(
          `[PendingGather] Error processing player ${playerId} for resource ${pending.resourceId}:`,
          error,
        );
        // Fail-safe cleanup: remove from pending to prevent infinite error loops
        this.pendingGathers.delete(playerId);
        this.releaseApproachReservation(playerId);
        this.publishPendingGatherFailure(pending);
      }
    }

    if (this.fishingReplans.size > 0) {
      const replans = [...this.fishingReplans];
      this.fishingReplans.clear();
      for (const [playerId, replan] of replans) {
        const accepted = this.queuePendingGather(
          playerId,
          replan.resourceId,
          currentTick,
          replan.runMode,
          replan.completionAttemptId,
        );
        if (!accepted) {
          this.publishPendingGatherFailure({
            playerId,
            resourceId: replan.resourceId,
            completionAttemptId: replan.completionAttemptId,
            skill: replan.skill,
          });
        }
      }
    }
  }

  /**
   * Process a single player's pending gather check
   * Extracted for error isolation - errors here won't break other players' tick processing
   */
  private processPlayerPendingGather(
    playerId: string,
    pending: PendingGather,
    currentTick: number,
  ): void {
    // Check timeout
    if (currentTick - pending.createdTick > PENDING_GATHER_TIMEOUT_TICKS) {
      console.log(`[PendingGather] Timeout for ${playerId}`);
      this.pendingGathers.delete(playerId);
      this.releaseApproachReservation(playerId);
      this.publishPendingGatherFailure(pending);
      return;
    }

    // Get player entity
    const player = this.world.getPlayer?.(playerId);
    if (!player?.position) {
      this.pendingGathers.delete(playerId);
      this.releaseApproachReservation(playerId);
      this.publishPendingGatherFailure(pending);
      return;
    }

    // Check if resource still exists and is available
    const resourceSystem = this.world.getSystem("resource") as {
      getResource?: (id: string) => ResourceData | null;
    } | null;

    const resource = resourceSystem?.getResource?.(pending.resourceId);
    if (!resource || !resource.isAvailable) {
      console.log(
        `[PendingGather] Resource ${pending.resourceId} no longer available`,
      );
      this.pendingGathers.delete(playerId);
      this.releaseApproachReservation(playerId);
      this.publishPendingGatherFailure(pending);
      return;
    }

    if (pending.isFishing) {
      worldToTileInto(
        resource.position.x,
        resource.position.z,
        this._resourceTile,
      );
      const moved =
        this._resourceTile.x !== pending.resourceAnchorTile.x ||
        this._resourceTile.z !== pending.resourceAnchorTile.z ||
        resource.position.x !== pending.resourcePosition.x ||
        resource.position.z !== pending.resourcePosition.z;
      if (moved) {
        this.pendingGathers.delete(playerId);
        this.releaseApproachReservation(playerId);
        this.tileMovementManager.clearArrivalEmote?.(playerId);
        this.fishingReplans.set(playerId, {
          resourceId: pending.resourceId,
          runMode: pending.runMode,
          completionAttemptId: pending.completionAttemptId,
          skill: pending.skill,
        });
        return;
      }
    }

    // Get current player tile
    worldToTileInto(player.position.x, player.position.z, this._playerTile);

    // Check arrival at target tile
    let hasArrived = false;

    if (pending.isFishing && pending.targetShoreTile) {
      // FISHING: Exact tile match on shore tile
      // Player must be standing on the specific shore tile we pathed them to
      hasArrived =
        this._playerTile.x === pending.targetShoreTile.x &&
        this._playerTile.z === pending.targetShoreTile.z;

      if (hasArrived) {
        console.log(
          `[PendingGather] 🎣 Player ${playerId} arrived at shore tile (${pending.targetShoreTile.x}, ${pending.targetShoreTile.z}) - starting gather`,
        );
      }
    } else {
      // NON-FISHING: Exact ownership of the preflighted approach tile.
      hasArrived = pending.targetApproachTile
        ? this._playerTile.x === pending.targetApproachTile.x &&
          this._playerTile.z === pending.targetApproachTile.z
        : this.isOnCardinalTile(
            this._playerTile,
            pending.resourceAnchorTile,
            pending.footprintX,
            pending.footprintZ,
          );

      if (hasArrived) {
        console.log(
          `[PendingGather] Player ${playerId} arrived at cardinal tile - starting gather`,
        );
      }
    }

    if (hasArrived) {
      // NOTE: Fishing emote is set via setArrivalEmote() in queuePendingGather()
      // and bundled with tileMovementEnd packet for atomic delivery to client.
      // This prevents race condition where client sets "idle" before emote arrives.

      // Use FaceDirectionManager for rules-accurate rotation (like other resources)
      this.setFaceTargetViaManager(
        playerId,
        pending.resourceAnchorTile,
        pending.footprintX,
        pending.footprintZ,
      );

      // Start gathering
      this.startGathering(
        playerId,
        pending.resourceId,
        pending.completionAttemptId,
      );
      // A valid completion-bound ResourceSystem request publishes its own exact
      // terminal rejection. PendingGatherManager owns only pre-admission
      // failures such as timeout, disappearance, and failed replanning.

      // Remove from pending
      this.pendingGathers.delete(playerId);
      this.releaseApproachReservation(playerId);
    }
  }

  /**
   * Check if player tile is on a cardinal adjacent tile to resource
   * Uses tilesWithinMeleeRange with GATHERING_RANGE (cardinal-only, like standard melee)
   */
  private isOnCardinalTile(
    playerTile: TileCoord,
    resourceAnchor: TileCoord,
    footprintX: number,
    footprintZ: number,
  ): boolean {
    // For multi-tile resources, we need to check all tiles the resource occupies
    // Player must be cardinally adjacent to ANY tile of the resource
    // MEMORY FIX: Use pre-allocated tile to avoid per-iteration allocations
    for (let ox = 0; ox < footprintX; ox++) {
      for (let oz = 0; oz < footprintZ; oz++) {
        this._tempFootprintTile.x = resourceAnchor.x + ox;
        this._tempFootprintTile.z = resourceAnchor.z + oz;
        // tilesWithinMeleeRange with GATHERING_RANGE checks cardinal-only
        if (
          tilesWithinMeleeRange(
            playerTile,
            this._tempFootprintTile,
            GATHERING_CONSTANTS.GATHERING_RANGE,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Helper to set face target via FaceDirectionManager.
   * Avoids code duplication for the multiple places we need to set rotation.
   */
  private setFaceTargetViaManager(
    playerId: string,
    resourceAnchor: TileCoord,
    footprintX: number,
    footprintZ: number,
  ): void {
    const faceManager = (
      this.world as {
        faceDirectionManager?: {
          setCardinalFaceTarget: (
            playerId: string,
            anchorTile: TileCoord,
            footprintX: number,
            footprintZ: number,
          ) => void;
        };
      }
    ).faceDirectionManager;

    if (faceManager) {
      faceManager.setCardinalFaceTarget(
        playerId,
        resourceAnchor,
        footprintX,
        footprintZ,
      );
      // PERF: Removed log - this happens every tick when agent spams gather
    }
  }

  /**
   * Start the gathering process
   */
  private startGathering(
    playerId: string,
    resourceId: string,
    completionAttemptId?: string,
  ): boolean {
    const player = this.world.getPlayer?.(playerId);
    if (!player?.position) return false;

    const request = {
      playerId,
      resourceId,
      playerPosition: {
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
      },
      completionAttemptId,
    };
    if (completionAttemptId !== undefined) {
      const resourceSystem = this.world.getSystem("resource") as {
        requestGathering?: (data: typeof request) => boolean;
      } | null;
      return resourceSystem?.requestGathering?.(request) === true;
    }

    // Emit RESOURCE_GATHER event - ResourceSystem will handle the actual gathering
    this.world.emit(EventType.RESOURCE_GATHER, request);
    return true;
  }
}
