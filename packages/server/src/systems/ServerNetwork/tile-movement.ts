/**
 * Tile Movement Manager
 *
 * classic fantasy MMORPG-style tile-based movement system.
 * Players move discretely from tile to tile on server ticks (600ms).
 *
 * Key differences from the old continuous system:
 * - Movement happens on ticks, not frames
 * - Players move 1 tile (walk) or 2 tiles (run) per tick
 * - Uses BFS pathfinding for paths
 * - Client interpolates visually between tile positions
 */

import type { ServerSocket } from "../../shared/types";
import {
  THREE,
  TerrainSystem,
  World,
  EventType,
  DeathState,
  AttackType,
  // Tile movement utilities
  TILES_PER_TICK_WALK,
  TILES_PER_TICK_RUN,
  worldToTile,
  worldToTileInto,
  tileToWorld,
  tileToWorldInto,
  tilesEqual,
  tilesWithinMeleeRange,
  tilesWithinRange,
  createTileMovementState,
  BFSPathfinder,
  // Combat pathfinding: LoS and valid tile generation
  hasLineOfSight,
  getValidRangedTiles,
  getValidMeleeTiles,
  // Collision system
  CollisionMask,
  CollisionFlag,
  BuildingCollisionService,
  type EntityID,
} from "@hyperforge/shared";
import type {
  TileCoord,
  TileInteractionArrival,
  TileMovementState,
} from "@hyperforge/shared";

// Security: Input validation and anti-cheat
import {
  MovementInputValidator,
  MovementViolationSeverity,
} from "./movement/MovementInputValidator";
import {
  MovementAntiCheat,
  type AntiCheatKickCallback,
} from "./movement/MovementAntiCheat";
import {
  getTileMovementRateLimiter,
  getPathfindRateLimiter,
} from "./services/SlidingWindowRateLimiter";

// Agility XP constants (batched to prevent visual spam)
const AGILITY_TILES_PER_XP_GRANT = 100; // Tiles needed before XP is granted
const AGILITY_XP_PER_GRANT = 50; // XP granted per threshold (effectively 1 XP per 2 tiles)

type DuelMovementIntent = {
  targetId: string;
  startTile: TileCoord;
  steps: TileCoord[];
};

function tileSegmentsIntersect(
  leftStart: TileCoord,
  leftEnd: TileCoord,
  rightStart: TileCoord,
  rightEnd: TileCoord,
): boolean {
  const orientation = (first: TileCoord, second: TileCoord, third: TileCoord) =>
    (second.z - first.z) * (third.x - second.x) -
    (second.x - first.x) * (third.z - second.z);
  const onSegment = (first: TileCoord, middle: TileCoord, last: TileCoord) =>
    middle.x >= Math.min(first.x, last.x) &&
    middle.x <= Math.max(first.x, last.x) &&
    middle.z >= Math.min(first.z, last.z) &&
    middle.z <= Math.max(first.z, last.z);

  const leftToRightStart = orientation(leftStart, leftEnd, rightStart);
  const leftToRightEnd = orientation(leftStart, leftEnd, rightEnd);
  const rightToLeftStart = orientation(rightStart, rightEnd, leftStart);
  const rightToLeftEnd = orientation(rightStart, rightEnd, leftEnd);
  if (
    ((leftToRightStart > 0 && leftToRightEnd < 0) ||
      (leftToRightStart < 0 && leftToRightEnd > 0)) &&
    ((rightToLeftStart > 0 && rightToLeftEnd < 0) ||
      (rightToLeftStart < 0 && rightToLeftEnd > 0))
  ) {
    return true;
  }
  return (
    (leftToRightStart === 0 && onSegment(leftStart, rightStart, leftEnd)) ||
    (leftToRightEnd === 0 && onSegment(leftStart, rightEnd, leftEnd)) ||
    (rightToLeftStart === 0 && onSegment(rightStart, leftStart, rightEnd)) ||
    (rightToLeftEnd === 0 && onSegment(rightStart, leftEnd, rightEnd))
  );
}

function duelMovementIntentShouldYield(
  playerId: string,
  intent: DuelMovementIntent,
  opponentIntent: DuelMovementIntent,
): boolean {
  if (intent.steps.length === 0) return false;

  let ownFrom = intent.startTile;
  for (const ownTo of intent.steps) {
    if (tilesEqual(ownTo, opponentIntent.startTile)) return true;

    let opponentFrom = opponentIntent.startTile;
    for (const opponentTo of opponentIntent.steps) {
      if (tileSegmentsIntersect(ownFrom, ownTo, opponentFrom, opponentTo)) {
        // The opponent is trying to enter our start tile, so its reciprocal
        // check will yield. Let this path move away instead of stopping both.
        if (tilesEqual(opponentTo, intent.startTile)) {
          opponentFrom = opponentTo;
          continue;
        }
        return playerId > intent.targetId;
      }
      opponentFrom = opponentTo;
    }
    ownFrom = ownTo;
  }
  return false;
}

/**
 * Tile-based movement manager for classic fantasy MMORPG-style movement
 */
export class TileMovementManager {
  /** Bounded safety envelope for collision-free joins, respawns, and teleports. */
  private static readonly SPAWN_RELOCATION_RADIUS = 32;
  private playerStates: Map<string, TileMovementState> = new Map();
  private pathfinder: BFSPathfinder;

  /**
   * Agility XP tracking: tiles traveled per player (batched at 100 tiles = 50 XP)
   * Reset on death, cleared on disconnect
   */
  private tilesTraveledForXP: Map<string, number> = new Map();
  // Y-axis for stable yaw rotation calculation
  private _up = new THREE.Vector3(0, 1, 0);
  private _tempQuat = new THREE.Quaternion();
  /** Pre-allocated world position for walkability checks (zero allocation in BFS) */
  private _walkableWorldPos = { x: 0, y: 0, z: 0 };

  /**
   * Arrival emotes: When a player arrives at destination, use this emote instead of "idle"
   * Used by gathering systems (fishing, mining, etc.) to set the action emote atomically
   * with the movement end packet, preventing race conditions on the client.
   */
  private arrivalEmotes: Map<string, string> = new Map();
  private arrivalEmoteResolvers: Map<string, () => string | null> = new Map();

  private consumeArrivalEmote(
    playerId: string,
    reachedRequestedDestination: boolean,
  ): string {
    const fallback = this.arrivalEmotes.get(playerId) || "idle";
    const resolver = this.arrivalEmoteResolvers.get(playerId);
    this.arrivalEmotes.delete(playerId);
    this.arrivalEmoteResolvers.delete(playerId);
    if (!reachedRequestedDestination) return "idle";
    if (!resolver) return fallback;
    try {
      const resolved = resolver();
      return typeof resolved === "string" && resolved ? resolved : "idle";
    } catch {
      return "idle";
    }
  }

  /**
   * RULES-ACCURATE: Tick-start positions for all players
   * Captured at the VERY START of onTick(), BEFORE any movement processing.
   * Used by FollowManager to create the 1-tick delay effect.
   *
   * Key insight from classic MMORPG: "The important part is to set the previousTile
   * at the start (or the end) of the tick not when they actually move"
   */
  private tickStartTiles: Map<string, TileCoord> = new Map();
  /**
   * Bounded per-tick duel paths used to prevent two AI contestants from
   * swapping tiles or crossing diagonal segments in the same 600ms step.
   */
  private duelMovementIntents: Map<string, DuelMovementIntent> = new Map();

  // Security: Input validation and anti-cheat monitoring
  private readonly inputValidator = new MovementInputValidator();
  private readonly antiCheat = new MovementAntiCheat();
  private readonly movementRateLimiter = getTileMovementRateLimiter();
  private readonly pathfindRateLimiter = getPathfindRateLimiter();

  // ============================================================================
  // PRE-ALLOCATED BUFFERS (Zero-allocation hot path support)
  // ============================================================================

  /** Reusable tile coordinate for previous position in onTick/processPlayerTick */
  private readonly _prevTile: TileCoord = { x: 0, z: 0 };

  /** Reusable tile coordinate for target position calculations */
  private readonly _targetTile: TileCoord = { x: 0, z: 0 };

  /** Reusable tile coordinate for entity position sync */
  private readonly _actualEntityTile: TileCoord = { x: 0, z: 0 };

  /** Pre-allocated buffer for network path transmission (avoids .map() allocation) */
  private readonly _networkPathBuffer: Array<{ x: number; z: number }> = [];

  /** Pre-allocated world position for tileToWorldInto (zero-allocation) */
  private readonly _worldPos: { x: number; y: number; z: number } = {
    x: 0,
    y: 0,
    z: 0,
  };

  /** Pre-allocated world position for previous tile rotation calc */
  private readonly _prevWorldPos: { x: number; y: number; z: number } = {
    x: 0,
    y: 0,
    z: 0,
  };

  /** Pre-allocated tile for tick-start capture */
  private readonly _tickStartTile: TileCoord = { x: 0, z: 0 };

  constructor(
    private world: World,
    private sendFn: (
      name: string,
      data: unknown,
      ignoreSocketId?: string,
    ) => void,
  ) {
    this.pathfinder = new BFSPathfinder();
  }

  /**
   * Wire anti-cheat auto-kick callback.
   * Called by ServerNetwork after construction to provide socket-layer kick access.
   */
  setAntiCheatKickCallback(callback: AntiCheatKickCallback): void {
    this.antiCheat.setKickCallback(callback);
  }

  /**
   * Get terrain system
   */
  private getTerrain(): InstanceType<typeof TerrainSystem> | null {
    return this.world.getSystem("terrain") as InstanceType<
      typeof TerrainSystem
    > | null;
  }

  /**
   * Persist only settled open-world positions. Duel movement is intentionally
   * temporary: the duel authority owns crash recovery and returns contestants
   * to their saved open-world positions after the result phase.
   */
  private persistSettledPlayerPosition(
    playerId: string,
    position: { x: number; y: number; z: number },
  ): void {
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      return;
    }
    const entity = this.world.entities.get(playerId) as
      { data?: { inStreamingDuel?: boolean } } | undefined;
    if (entity?.data?.inStreamingDuel === true) return;

    const database = this.world.getSystem("database") as {
      savePlayer?: (
        id: string,
        update: {
          positionX: number;
          positionY: number;
          positionZ: number;
        },
      ) => void;
    } | null;
    database?.savePlayer?.(playerId, {
      positionX: position.x,
      positionY: position.y,
      positionZ: position.z,
    });
  }

  /**
   * Get bridge system for railing collision checks (cached after first lookup).
   */
  private _bridgeSystemRef: {
    getDeckHeightAt(x: number, z: number): number | null;
    isBridgeTransitionBlocked(
      fX: number,
      fZ: number,
      tX: number,
      tZ: number,
    ): boolean;
  } | null = null;
  private _bridgeSystemChecked = false;

  private getBridgeSystem(): {
    getDeckHeightAt(x: number, z: number): number | null;
    isBridgeTransitionBlocked(
      fX: number,
      fZ: number,
      tX: number,
      tZ: number,
    ): boolean;
  } | null {
    if (!this._bridgeSystemChecked) {
      const sys = this.world.getSystem("bridges");
      if (sys) {
        this._bridgeSystemRef = sys as unknown as {
          getDeckHeightAt(x: number, z: number): number | null;
          isBridgeTransitionBlocked(
            fX: number,
            fZ: number,
            tX: number,
            tZ: number,
          ): boolean;
        };
        this._bridgeSystemChecked = true;
      }
    }
    return this._bridgeSystemRef;
  }

  /**
   * Get dock system for deck height lookups (cached after first lookup).
   */
  private _dockSystemRef: {
    getDeckHeightAt(x: number, z: number): number | null;
  } | null = null;
  private _dockSystemChecked = false;

  private getDockSystem(): {
    getDeckHeightAt(x: number, z: number): number | null;
  } | null {
    if (!this._dockSystemChecked) {
      const sys = this.world.getSystem("docks");
      if (sys) {
        this._dockSystemRef = sys as unknown as {
          getDeckHeightAt(x: number, z: number): number | null;
        };
        this._dockSystemChecked = true;
      }
    }
    return this._dockSystemRef;
  }

  /**
   * Get building collision service
   */
  private getBuildingCollision(): BuildingCollisionService | null {
    // Only attempt to get it if it exists (it's in shared but registered on server World too)
    return (
      (this.world.getSystem(
        "buildingCollision",
      ) as unknown as BuildingCollisionService) || null
    );
  }

  /**
   * Check if a tile is walkable based on collision and terrain constraints.
   * Uses per-tick walkability cache: terrain/slope/biome results are cached
   * by tile key since they don't change within a tick. Directional collision
   * (from→to) is cached separately since it depends on movement direction.
   *
   * With 25 agents pathfinding in the same area, the cache makes subsequent
   * BFS calls nearly free for previously-checked tiles.
   */
  private isTileWalkable(
    tile: TileCoord,
    floorIndex: number = 0,
    fromTile?: TileCoord,
    playerBuildingId?: string | null,
  ): boolean {
    const buildingService = this.getBuildingCollision();

    let isTargetInBuilding = false;

    // Check building collision first (if available)
    if (buildingService) {
      const buildingCheck = buildingService.checkBuildingMovement(
        fromTile ?? null,
        tile,
        floorIndex,
        playerBuildingId ?? null,
      );

      // BuildingCollisionService handles all building-related blocking
      if (!buildingCheck.buildingAllowsMovement) {
        return false;
      }

      isTargetInBuilding = buildingCheck.targetInBuildingFootprint;
    }

    // Directional block from collision matrix (direction-dependent, cached separately)
    if (floorIndex === 0 && fromTile) {
      // Encode from→to direction into a single numeric key.
      // Direction (dx+1, dz+1) each ∈ [0,2], so direction occupies 4 bits (3×3=9 values).
      // fromTile coords are offset to positive, then z gets 21 bits before x.
      const dir =
        ((tile.x - fromTile.x + 1) | 0) * 3 + ((tile.z - fromTile.z + 1) | 0);
      const dirKey =
        ((fromTile.x + 1048576) | 0) * 18874368 +
        ((fromTile.z + 1048576) | 0) * 9 +
        dir;
      const cachedDir = this._directionalBlockCache.get(dirKey);
      if (cachedDir !== undefined) {
        if (cachedDir) return false;
      } else {
        const blocked = this.world.collision.isBlocked(
          fromTile.x,
          fromTile.z,
          tile.x,
          tile.z,
        );
        this._directionalBlockCache.set(dirKey, blocked);
        if (blocked) return false;
      }

      // Bridge railing enforcement: block all bridge↔non-bridge transitions
      // except at bridge endpoint tiles aligned with the bridge direction.
      // Wall flags provide defense-in-depth (set at init + terrain bake).
      const bridgeSys = this.getBridgeSystem();
      if (
        bridgeSys?.isBridgeTransitionBlocked(
          fromTile.x,
          fromTile.z,
          tile.x,
          tile.z,
        )
      ) {
        return false;
      }
    }

    // Static walkability check (tile-only, cached per tile)
    const tileKey =
      ((tile.x + 1048576) | 0) * 2097152 + ((tile.z + 1048576) | 0);
    const cached = this._walkabilityCache.get(tileKey);
    if (cached !== undefined) {
      return cached;
    }

    // Compute and cache
    let walkable: boolean;

    // Bridge/dock tiles override water — check deck height lookup directly
    // (same pattern as BuildingCollisionService) rather than relying on collision
    // flags which may not be baked yet if the terrain tile was just generated.
    if (floorIndex === 0) {
      const bridgeSysWalk = this.getBridgeSystem();
      if (bridgeSysWalk?.getDeckHeightAt(tile.x, tile.z) != null) {
        walkable = true;
        this._walkabilityCache.set(tileKey, walkable);
        return walkable;
      }
      const dockSysWalk = this.getDockSystem();
      if (dockSysWalk?.getDeckHeightAt(tile.x, tile.z) != null) {
        walkable = true;
        this._walkabilityCache.set(tileKey, walkable);
        return walkable;
      }
    }
    if (isTargetInBuilding) {
      // Building floor is walkable, overrides terrain
      walkable = true;
    } else if (
      floorIndex === 0 &&
      this.world.collision.hasFlags(tile.x, tile.z, CollisionMask.BLOCKS_WALK)
    ) {
      walkable = false;
    } else {
      // Collision flags (WATER, STEEP_SLOPE) are baked when terrain generates.
      // Runtime fallback catches any unbaked underwater tiles via height checks.
      const terrain = this.getTerrain();
      if (terrain) {
        tileToWorldInto(tile, this._walkableWorldPos);
        walkable = terrain.isPositionWalkableFast(
          this._walkableWorldPos.x,
          this._walkableWorldPos.z,
        );
      } else {
        walkable = true;
      }
    }

    this._walkabilityCache.set(tileKey, walkable);
    return walkable;
  }

  /**
   * Find the closest walkable tile to a target position using BFS.
   * Used for fishing where the target (fishing spot) is in water
   * and we need to find the nearest shore tile.
   *
   * @param targetPos - Target position in world coordinates
   * @param maxSearchRadius - Maximum tiles to search outward (default: 10)
   * @returns The closest walkable tile, or null if none found within radius
   */
  findClosestWalkableTile(
    targetPos: { x: number; z: number },
    maxSearchRadius: number = 10,
    acceptsTile?: (tile: TileCoord) => boolean,
  ): TileCoord | null {
    const targetTile = worldToTile(targetPos.x, targetPos.z);

    // For general closest tile search, assume ground floor (index 0)
    // Determining floor for arbitrary target pos is complex without context
    const floorIndex = 0;

    // If target tile is already walkable, return it
    if (
      this.isTileWalkable(targetTile, floorIndex) &&
      (acceptsTile?.(targetTile) ?? true)
    ) {
      return targetTile;
    }

    // BFS outward from target tile to find closest walkable tile
    // Search in expanding rings (distance 1, 2, 3, etc.)
    for (let radius = 1; radius <= maxSearchRadius; radius++) {
      // Check all tiles at this radius (ring around target)
      // Use a simple approach: check all tiles in a square, filter by distance
      const candidates: Array<{ tile: TileCoord; dist: number }> = [];

      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          // Only check tiles at exactly this radius (Chebyshev distance)
          const chebyshev = Math.max(Math.abs(dx), Math.abs(dz));
          if (chebyshev !== radius) continue;

          const tile: TileCoord = {
            x: targetTile.x + dx,
            z: targetTile.z + dz,
          };

          if (
            this.isTileWalkable(tile, floorIndex) &&
            (acceptsTile?.(tile) ?? true)
          ) {
            // Use Euclidean distance for sorting (more accurate than Chebyshev)
            const euclidean = Math.sqrt(dx * dx + dz * dz);
            candidates.push({ tile, dist: euclidean });
          }
        }
      }

      // If we found walkable tiles at this radius, return the closest one
      if (candidates.length > 0) {
        candidates.sort((a, b) => a.dist - b.dist);
        return candidates[0].tile;
      }
    }

    // No walkable tile found within search radius
    return null;
  }

  /** Ground-floor availability for server-owned interaction positioning. */
  isTileAvailableForPlayer(playerId: string, tile: TileCoord): boolean {
    return this.isTileTraversableForPlayer(playerId, tile, 0);
  }

  /**
   * Get or create movement state for a player
   */
  private getOrCreateState(playerId: string): TileMovementState {
    let state = this.playerStates.get(playerId);
    if (!state) {
      // Get current position and convert to tile
      const entity = this.world.entities.get(playerId);
      const currentTile: TileCoord = entity?.position
        ? worldToTile(entity.position.x, entity.position.z)
        : { x: 0, z: 0 };

      state = createTileMovementState(currentTile);
      this.playerStates.set(playerId, state);
    }
    this.ensurePlayerOccupancy(playerId, state.currentTile);
    return state;
  }

  private getEntityOccupancy(): World["entityOccupancy"] | null {
    return (
      (
        this.world as World & {
          entityOccupancy?: World["entityOccupancy"];
        }
      ).entityOccupancy ?? null
    );
  }

  /** Register a player's current authoritative tile without overwriting another actor. */
  private ensurePlayerOccupancy(playerId: string, tile: TileCoord): boolean {
    const occupancy = this.getEntityOccupancy();
    if (!occupancy) return true;
    const entityId = playerId as EntityID;
    const occupant = occupancy.getOccupant(tile);
    if (occupant?.entityId === entityId) return true;
    if (occupant) return false;
    occupancy.occupy(entityId, [tile], 1, "player", false);
    return occupancy.getOccupant(tile)?.entityId === entityId;
  }

  /**
   * Commit one already-validated player step to occupancy. A player whose
   * legacy/saved spawn overlaps another actor may leave that tile, but cannot
   * overwrite the actor that currently owns it.
   */
  private commitPlayerOccupancyStep(
    playerId: string,
    fromTile: TileCoord,
    nextTile: TileCoord,
  ): void {
    const occupancy = this.getEntityOccupancy();
    if (!occupancy) return;
    const entityId = playerId as EntityID;
    if (occupancy.getOccupant(fromTile)?.entityId === entityId) {
      occupancy.move(entityId, [nextTile], 1);
    } else {
      occupancy.occupy(entityId, [nextTile], 1, "player", false);
    }
  }

  /** Dynamic actors are deliberately excluded from the static walkability cache. */
  private isTileTraversableForPlayer(
    playerId: string,
    tile: TileCoord,
    floorIndex: number = 0,
    fromTile?: TileCoord,
    playerBuildingId?: string | null,
  ): boolean {
    if (!this.isTileWalkable(tile, floorIndex, fromTile, playerBuildingId)) {
      return false;
    }
    return (
      this.getEntityOccupancy()?.isBlocked(tile, playerId as EntityID) !== true
    );
  }

  /**
   * Handle move request from client
   *
   * Security: All input is validated before processing.
   * Rate limiting prevents spam attacks.
   * Anti-cheat monitors for suspicious patterns.
   */
  handleMoveRequest(socket: ServerSocket, data: unknown): void {
    const playerEntity = socket.player;
    if (!playerEntity) {
      console.warn("[Movement] handleMoveRequest: no player entity on socket");
      return;
    }

    // Death lock: Dead players cannot move
    const deathState = playerEntity.data?.deathState;
    if (deathState === DeathState.DYING || deathState === DeathState.DEAD) {
      return; // Expected — dead players clicking doesn't need logging
    }

    const playerId = playerEntity.id;

    // Duel lock: Check if player can move (frozen during countdown, or noMovement rule)
    const duelSystem = this.world.getSystem("duel") as {
      canMove?: (playerId: string) => boolean;
    } | null;
    if (duelSystem?.canMove && !duelSystem.canMove(playerId)) {
      return; // Silently reject - player frozen in duel
    }

    // Rate limit: prevent spam attacks
    if (!this.movementRateLimiter.check(playerId)) {
      return; // Silently drop - rate limiting is expected during fast clicking
    }

    // Get current state for validation context
    const state = this.getOrCreateState(playerId);

    // Validate input using MovementInputValidator
    const validation = this.inputValidator.validateMoveRequest(
      data,
      state.currentTile,
    );

    if (!validation.valid) {
      // Log violation to anti-cheat system
      this.antiCheat.recordViolation(
        playerId,
        "invalid_move_request",
        validation.severity ?? MovementViolationSeverity.MINOR,
        validation.error ?? "Unknown validation error",
        state.currentTile,
      );
      return;
    }

    const payload = validation.payload!;
    this._pendingObstructionReplans.delete(playerId);
    this._pendingNonCombatMoves.delete(playerId);
    this._precomputedPathSegments.delete(playerId);
    this._interactionApproachReservations.delete(playerId);

    // RULES ACCURACY: Emit click-to-move event for weak queue cancellation
    // This MUST happen before any early returns (same-tile, cancel, etc.)
    // ResourceSystem subscribes to this to cancel gathering when player clicks ground
    // In classic MMORPG, ANY click cancels weak queue actions like gathering
    this.world.emit(EventType.MOVEMENT_CLICK_TO_MOVE, {
      playerId: playerId,
      targetPosition: {
        x: payload.targetTile.x,
        y: 0,
        z: payload.targetTile.z,
      },
    });

    // Handle cancellation
    if (payload.cancel) {
      state.path.length = 0; // Zero-allocation clear
      state.pathIndex = 0;

      // modern MMORPG-style: Clear movement flag so combat can resume
      playerEntity.data.tileMovementActive = false;

      // Broadcast idle state
      const curr = playerEntity.position;
      this.sendFn("entityModified", {
        id: playerId,
        changes: {
          p: [curr.x, curr.y, curr.z],
          v: [0, 0, 0],
          e: "idle",
        },
      });
      return;
    }

    // Check if this is just a runMode toggle (target equals current tile)
    if (tilesEqual(payload.targetTile, state.currentTile)) {
      state.isRunning = payload.runMode;
      this.sendFn("entityModified", {
        id: playerId,
        changes: { e: payload.runMode ? "run" : "walk" },
      });
      return;
    }

    // Bridge/dock constraint: if player is on a bridge or dock and clicks a
    // water tile, reject the movement. Otherwise BFS reroutes through
    // endpoints to the bank, making the player walk off — not what the user intends.
    const bridgeSys = this.getBridgeSystem();
    const dockSys = this.getDockSystem();
    const onBridge =
      bridgeSys?.getDeckHeightAt(state.currentTile.x, state.currentTile.z) !=
      null;
    const onDock =
      dockSys?.getDeckHeightAt(state.currentTile.x, state.currentTile.z) !=
      null;
    if (onBridge || onDock) {
      if (
        this.world.collision.hasFlags(
          payload.targetTile.x,
          payload.targetTile.z,
          CollisionFlag.WATER,
        )
      ) {
        return; // On bridge/dock, clicked water — ignore
      }
    }

    // Rate limit pathfinding separately (CPU-expensive operation)
    if (!this.pathfindRateLimiter.check(playerId)) {
      return; // Too many pathfind requests
    }

    // Determine current floor index for floor-aware pathfinding
    const buildingService = this.getBuildingCollision();
    const currentFloor = buildingService
      ? buildingService.getPlayerFloor(playerId as EntityID)
      : 0;

    const currentBuildingId = buildingService
      ? buildingService.getBuildingAt(state.currentTile.x, state.currentTile.z)
      : null;

    // Calculate BFS path from current tile to target
    // Player clicks always pathfind (rate-limited above) but respect iteration budget
    const remainingBudget =
      TileMovementManager.MAX_BFS_ITERATIONS_PER_TICK -
      this._bfsIterationsThisTick;
    const path = this.pathfinder.findPath(
      state.currentTile,
      payload.targetTile,
      (tile, fromTile) =>
        this.isTileTraversableForPlayer(
          playerId,
          tile,
          currentFloor,
          fromTile,
          currentBuildingId,
        ),
      remainingBudget > 0 ? remainingBudget : undefined,
    );
    this._bfsIterationsThisTick += this.pathfinder.getLastIterationsUsed();

    // Store path and update state
    state.path = path;
    state.pathIndex = 0;
    state.isRunning = payload.runMode;
    // Increment movement sequence for packet ordering
    // Client uses this to ignore stale packets from previous movements
    state.moveSeq = (state.moveSeq || 0) + 1;

    // Track partial-path state per player so the path-continuation logic in onTick
    // can check without reading the shared BFSPathfinder flag (which may be overwritten
    // by another player's path before onTick runs).
    state.lastPathPartial = this.pathfinder.wasLastPathPartial();

    // Store original requested destination for seamless long-distance continuation.
    // Cleared when destination is reached or is definitively unreachable.
    state.requestedDestination = {
      x: payload.targetTile.x,
      z: payload.targetTile.z,
    };
    state.requestedInteractionArrival = null;

    // Any new click cancels a precomputed segment that hasn't been consumed yet.
    // The stale tileMovementStart (isContinuation) will be rejected client-side via moveSeq.
    state.nextSegmentPrecomputed = false;

    // Set movement flag for tracking active tile movement
    if (path.length > 0) {
      playerEntity.data.tileMovementActive = true;

      // rules-accurate: Clicking ground cancels your attack
      // Player is walking away - they're no longer attacking their target
      // The mob continues chasing them, and auto-retaliate can trigger if hit
      this.world.emit(EventType.COMBAT_PLAYER_DISENGAGE, {
        playerId: playerId,
      });

      // Cancel any pending attack - player chose a different destination
      // This handles the case where player was walking to a mob but changed their mind
      this.world.emit(EventType.PENDING_ATTACK_CANCEL, {
        playerId: playerId,
      });
    }

    // Immediately rotate player toward destination and send first tile update
    if (path.length > 0) {
      const nextTile = path[0];
      const nextWorld = tileToWorld(nextTile);
      const curr = playerEntity.position;
      const dx = nextWorld.x - curr.x;
      const dz = nextWorld.z - curr.z;

      // Calculate rotation to face movement direction using stable atan2 method
      if (Math.abs(dx) + Math.abs(dz) > 0.01) {
        // VRM faces -Z after factory rotation. Rotating -Z by yaw θ around Y gives:
        // (-sin(θ), 0, -cos(θ)). To face direction (dx, dz), solve:
        // -sin(θ) = dx, -cos(θ) = dz → θ = atan2(-dx, -dz)
        const yaw = Math.atan2(-dx, -dz);
        this._tempQuat.setFromAxisAngle(this._up, yaw);

        if (playerEntity.node) {
          playerEntity.node.quaternion.copy(this._tempQuat);
        }
        playerEntity.data.quaternion = [
          this._tempQuat.x,
          this._tempQuat.y,
          this._tempQuat.z,
          this._tempQuat.w,
        ];
      }

      // Broadcast movement started with path
      // Server sends COMPLETE authoritative path - client follows exactly, no recalculation
      // startTile: where server knows player IS (client uses this, not its visual position)
      // path: tiles to walk through (server's BFS result)
      // destinationTile: endpoint of this authoritative segment. Long routes
      // are continued server-side; clients must never append an unvalidated
      // straight-line jump from a partial path to the ultimate target.
      // moveSeq: packet ordering to ignore stale packets
      // emote: bundled animation (classic MMORPG-style, no separate packet)

      // Zero-allocation: copy path to pre-allocated network buffer
      this._networkPathBuffer.length = path.length;
      for (let i = 0; i < path.length; i++) {
        if (!this._networkPathBuffer[i]) {
          this._networkPathBuffer[i] = { x: 0, z: 0 };
        }
        this._networkPathBuffer[i].x = path[i].x;
        this._networkPathBuffer[i].z = path[i].z;
      }

      this.sendFn("tileMovementStart", {
        id: playerId,
        startTile: { x: state.currentTile.x, z: state.currentTile.z },
        path: this._networkPathBuffer,
        running: state.isRunning,
        destinationTile: {
          x: path[path.length - 1].x,
          z: path[path.length - 1].z,
        },
        moveSeq: state.moveSeq,
        emote: state.isRunning ? "run" : "walk",
      });
    } else {
      // No path found or already at destination
      console.warn(
        `[TileMovement] ⚠️ No path found from (${state.currentTile.x},${state.currentTile.z}) to (${payload.targetTile.x},${payload.targetTile.z})`,
      );
    }
  }

  /**
   * Handle legacy input packet (routes to move request)
   *
   * Security: Basic type validation before routing to validated handler.
   */
  handleInput(socket: ServerSocket, data: unknown): void {
    // Type guard: must be non-null object
    if (data === null || typeof data !== "object") {
      return;
    }

    const payload = data as Record<string, unknown>;

    // Route click events to validated move request handler
    if (payload.type === "click" && Array.isArray(payload.target)) {
      this.handleMoveRequest(socket, {
        target: payload.target,
        runMode: typeof payload.runMode === "boolean" ? payload.runMode : false,
      });
    }
  }

  /**
   * Max BFS path continuations per tick to prevent 25+ agents all pathfinding
   * simultaneously. The separate shared iteration budget remains the hard
   * ceiling when several continuations are individually inexpensive.
   * Remaining continuations will happen on the next tick.
   */
  private static readonly MAX_PATH_CONTINUATIONS_PER_TICK = 5;

  /**
   * Global BFS iteration budget per tick. ALL BFS callers share this budget.
   * Each BFS iteration costs 1 unit. Short paths (50 iterations) barely dent
   * the budget while long or obstructed paths cost proportionally. The 1,000-unit
   * ceiling keeps simultaneous path installation below the measured movement
   * tick latency threshold on the production terrain manifest.
   */
  private static readonly MAX_BFS_ITERATIONS_PER_TICK = 1000;
  /** Bound one guided non-combat segment so no single route owns the tick. */
  private static readonly MAX_GUIDED_NON_COMBAT_ITERATIONS_PER_SEARCH = 250;
  private _bfsIterationsThisTick = 0;

  /**
   * Per-tick walkability cache. Walkability depends on terrain height, slope,
   * biome, and collision — all stable within a single tick. Multiple BFS calls
   * in the same tick (25 agents in combat) re-check the same tiles repeatedly.
   * This cache makes the 2nd+ check O(1) instead of 10+ getHeightAt() calls.
   *
   * Key: numeric tile key (same as BFS visited set)
   * Value: boolean walkability result
   *
   * Cleared at the start of each tick.
   */
  private _walkabilityCache = new Map<number, boolean>();
  /** Separate cache for directional blocking (from→to collision checks) */
  private _directionalBlockCache = new Map<number, boolean>();
  /** Tick whose shared pathfinding caches and budget are currently serving. */
  private _movementCacheTick = -1;
  /**
   * Non-combat routes interrupted by a newly blocked step. Replanning is
   * deferred to the next authoritative tick so collision caches are fresh and
   * the global BFS budget remains fair across agents.
   */
  private _pendingObstructionReplans = new Map<
    string,
    {
      destination: TileCoord;
      isRunning: boolean;
      interactionArrival: TileInteractionArrival | null;
      attempts: number;
    }
  >();
  private static readonly MAX_OBSTRUCTION_REPLAN_ATTEMPTS = 3;
  /**
   * Shared workstations expose many legal arrival tiles. Temporary player
   * occupancy should wait through a full behavior-planning interval instead
   * of abandoning an otherwise reachable preparation action after 1.8s.
   */
  private static readonly MAX_INTERACTION_REPLAN_ATTEMPTS = 16;

  /**
   * Server-owned non-combat route requests deferred by the shared BFS budget.
   * One latest intent is retained per player and retried on authoritative ticks,
   * avoiding an eight-second wait for the next agent-planning cadence.
   */
  private _pendingNonCombatMoves = new Map<
    string,
    {
      destination: TileCoord;
      isRunning: boolean;
      interactionArrival: TileInteractionArrival | null;
      failedAttempts: number;
    }
  >();

  /**
   * Short-lived destination reservations keep simultaneous embedded agents
   * from all selecting the same outer workstation tile. Inner interaction
   * rings fill first so later arrivals cannot form an impassable player wall.
   */
  private _interactionApproachReservations = new Map<
    string,
    { tile: TileCoord; destination: TileCoord }
  >();

  /**
   * Look-ahead continuations already sent to clients but not yet activated by
   * the authoritative server path state.
   */
  private _precomputedPathSegments = new Map<
    string,
    {
      path: TileCoord[];
      destination: TileCoord;
      interactionArrival: TileInteractionArrival | null;
      lastPathPartial: boolean;
    }
  >();

  private beginMovementTick(tickNumber: number): void {
    if (this._movementCacheTick === tickNumber) return;
    this._movementCacheTick = tickNumber;
    this._bfsIterationsThisTick = 0;
    this._walkabilityCache.clear();
    this._directionalBlockCache.clear();
    this.captureTickStartTiles();
    this.captureDuelMovementIntents();
  }

  private captureTickStartTiles(): void {
    for (const [playerId, state] of this.playerStates) {
      const existing = this.tickStartTiles.get(playerId);
      if (existing) {
        existing.x = state.currentTile.x;
        existing.z = state.currentTile.z;
      } else {
        this.tickStartTiles.set(playerId, {
          x: state.currentTile.x,
          z: state.currentTile.z,
        });
      }
    }
    for (const id of this.tickStartTiles.keys()) {
      if (!this.playerStates.has(id)) this.tickStartTiles.delete(id);
    }
  }

  private captureDuelMovementIntents(): void {
    this.duelMovementIntents.clear();
    for (const [playerId, state] of this.playerStates) {
      const entity = this.world.entities.get(playerId);
      const data = entity?.data as
        | {
            inStreamingDuel?: boolean;
            duelAiControlsMovement?: boolean;
            streamingDuelOpponentId?: unknown;
            combatTarget?: unknown;
            attackTarget?: unknown;
          }
        | undefined;
      if (
        data?.inStreamingDuel !== true ||
        data.duelAiControlsMovement !== true
      ) {
        continue;
      }
      const rawTargetId =
        data.streamingDuelOpponentId ?? data.combatTarget ?? data.attackTarget;
      if (typeof rawTargetId !== "string" || rawTargetId.length === 0) continue;
      const startTile = this.tickStartTiles.get(playerId);
      if (!startTile) continue;
      const maximumSteps = state.isRunning
        ? TILES_PER_TICK_RUN
        : TILES_PER_TICK_WALK;
      const steps: TileCoord[] = [];
      for (
        let index = state.pathIndex;
        index < state.path.length && steps.length < maximumSteps;
        index++
      ) {
        steps.push({ x: state.path[index].x, z: state.path[index].z });
      }
      this.duelMovementIntents.set(playerId, {
        targetId: rawTargetId,
        startTile: { x: startTile.x, z: startTile.z },
        steps,
      });
    }
  }

  /**
   * A duel path yields before movement when it would enter the opponent's
   * tick-start tile. For an interior diagonal crossing, the stable id order
   * lets exactly one path proceed. The yielded path is cancelled and the duel
   * controller replans from the unchanged authoritative tile on its next turn.
   */
  private shouldYieldStreamingDuelMovement(playerId: string): boolean {
    const intent = this.duelMovementIntents.get(playerId);
    if (!intent || intent.steps.length === 0) return false;
    const opponentIntent = this.duelMovementIntents.get(intent.targetId);
    if (!opponentIntent) return false;
    return duelMovementIntentShouldYield(playerId, intent, opponentIntent);
  }

  private resolveStreamingDuelPathInstallation(
    playerId: string,
    state: TileMovementState,
    path: readonly TileCoord[],
    running: boolean,
  ): boolean {
    const entity = this.world.entities.get(playerId);
    const data = entity?.data as
      | {
          inStreamingDuel?: boolean;
          duelAiControlsMovement?: boolean;
          streamingDuelOpponentId?: unknown;
          combatTarget?: unknown;
          attackTarget?: unknown;
        }
      | undefined;
    if (
      data?.inStreamingDuel !== true ||
      data.duelAiControlsMovement !== true
    ) {
      return true;
    }

    const rawTargetId =
      data.streamingDuelOpponentId ?? data.combatTarget ?? data.attackTarget;
    if (typeof rawTargetId !== "string" || rawTargetId.length === 0) {
      return true;
    }
    const opponentEntity = this.world.entities.get(rawTargetId);
    const opponentData = opponentEntity?.data as
      | { inStreamingDuel?: boolean; duelAiControlsMovement?: boolean }
      | undefined;
    const opponentState = this.playerStates.get(rawTargetId);
    if (
      opponentData?.inStreamingDuel !== true ||
      opponentData.duelAiControlsMovement !== true ||
      !opponentState
    ) {
      return true;
    }

    const copySteps = (
      source: readonly TileCoord[],
      startIndex: number,
      maximumSteps: number,
    ): TileCoord[] => {
      const steps: TileCoord[] = [];
      for (
        let index = startIndex;
        index < source.length && steps.length < maximumSteps;
        index++
      ) {
        steps.push({ x: source[index].x, z: source[index].z });
      }
      return steps;
    };
    const intent: DuelMovementIntent = {
      targetId: rawTargetId,
      startTile: { x: state.currentTile.x, z: state.currentTile.z },
      steps: copySteps(
        path,
        0,
        running ? TILES_PER_TICK_RUN : TILES_PER_TICK_WALK,
      ),
    };
    const opponentIntent: DuelMovementIntent = {
      targetId: playerId,
      startTile: {
        x: opponentState.currentTile.x,
        z: opponentState.currentTile.z,
      },
      steps: copySteps(
        opponentState.path,
        opponentState.pathIndex,
        opponentState.isRunning ? TILES_PER_TICK_RUN : TILES_PER_TICK_WALK,
      ),
    };
    const playerYields = duelMovementIntentShouldYield(
      playerId,
      intent,
      opponentIntent,
    );
    const opponentYields = duelMovementIntentShouldYield(
      rawTargetId,
      opponentIntent,
      intent,
    );

    if (playerYields) {
      if (opponentYields && this.isMoving(rawTargetId)) {
        this.stopPlayer(rawTargetId);
      }
      if (this.isMoving(playerId)) this.stopPlayer(playerId);
      return false;
    }
    if (opponentYields && this.isMoving(rawTargetId)) {
      this.stopPlayer(rawTargetId);
    }
    return true;
  }

  private isPathStepWalkable(
    playerId: string,
    state: TileMovementState,
    nextTile: TileCoord,
  ): boolean {
    const buildingService = this.getBuildingCollision();
    const currentFloor = buildingService
      ? buildingService.getPlayerFloor(playerId as EntityID)
      : 0;
    const currentBuildingId = buildingService
      ? buildingService.getBuildingAt(state.currentTile.x, state.currentTile.z)
      : null;
    return this.isTileTraversableForPlayer(
      playerId,
      nextTile,
      currentFloor,
      state.currentTile,
      currentBuildingId,
    );
  }

  private queueObstructionReplan(
    playerId: string,
    state: TileMovementState,
  ): void {
    const wasMoving = state.path.length > 0;
    const destination = state.requestedDestination;
    if (destination) {
      const existing = this._pendingObstructionReplans.get(playerId);
      this._pendingObstructionReplans.set(playerId, {
        destination: { x: destination.x, z: destination.z },
        isRunning: state.isRunning,
        interactionArrival: state.requestedInteractionArrival,
        attempts: existing?.attempts ?? 0,
      });
    }

    state.path.length = 0;
    state.pathIndex = 0;
    state.requestedDestination = null;
    state.requestedInteractionArrival = null;
    state.lastPathPartial = false;
    state.nextSegmentPrecomputed = false;
    this._precomputedPathSegments.delete(playerId);

    if (wasMoving) {
      state.moveSeq = (state.moveSeq || 0) + 1;
      const entity = this.world.entities.get(playerId);
      if (entity?.data) entity.data.tileMovementActive = false;
      const worldPosition = tileToWorld(state.currentTile);
      if (entity?.position) worldPosition.y = entity.position.y;
      this.persistSettledPlayerPosition(playerId, worldPosition);
      this.sendFn("tileMovementEnd", {
        id: playerId,
        tile: state.currentTile,
        worldPos: [worldPosition.x, worldPosition.y, worldPosition.z],
        moveSeq: state.moveSeq,
        emote: "idle",
        reason: "dynamic_obstruction",
      });
    }
  }

  private processPendingObstructionReplan(playerId: string): void {
    const pending = this._pendingObstructionReplans.get(playerId);
    if (!pending) return;

    const outcome = this._continuePathToDestination(
      playerId,
      pending.destination,
      pending.isRunning,
      pending.interactionArrival,
    );
    if (outcome === "started") {
      this._pendingObstructionReplans.delete(playerId);
      return;
    }
    if (outcome === "deferred") return;

    pending.attempts++;
    const maximumAttempts = pending.interactionArrival
      ? TileMovementManager.MAX_INTERACTION_REPLAN_ATTEMPTS
      : TileMovementManager.MAX_OBSTRUCTION_REPLAN_ATTEMPTS;
    if (pending.attempts >= maximumAttempts) {
      this._pendingObstructionReplans.delete(playerId);
      this._interactionApproachReservations.delete(playerId);
    }
  }

  private queueNonCombatMove(
    playerId: string,
    destination: TileCoord,
    isRunning: boolean,
    interactionArrival: TileInteractionArrival | null = null,
  ): void {
    if (this.isMoving(playerId)) {
      this.stopPlayer(playerId);
    }
    this._pendingNonCombatMoves.set(playerId, {
      destination: { x: destination.x, z: destination.z },
      isRunning,
      interactionArrival,
      failedAttempts: 0,
    });
  }

  private processPendingNonCombatMove(playerId: string): void {
    const pending = this._pendingNonCombatMoves.get(playerId);
    if (!pending) return;

    const currentTile = this.playerStates.get(playerId)?.currentTile;
    if (
      currentTile &&
      pending.interactionArrival &&
      this.isTileWithinInteractionArrival(
        currentTile,
        pending.destination,
        pending.interactionArrival,
      )
    ) {
      this._pendingNonCombatMoves.delete(playerId);
      return;
    }

    const outcome = this._continuePathToDestination(
      playerId,
      pending.destination,
      pending.isRunning,
      pending.interactionArrival,
    );
    if (outcome === "started") {
      this._pendingNonCombatMoves.delete(playerId);
      return;
    }
    if (outcome === "deferred") return;

    // An empty interaction path can mean every legal workstation approach is
    // temporarily occupied or reserved. Retain that intent for a bounded
    // interval so queued agents get a fair turn as the current users depart.
    // Exact movement and interaction validation still run on every retry, and
    // permanently unreachable stations are abandoned at the existing bound.
    pending.failedAttempts += 1;
    if (
      !pending.interactionArrival ||
      pending.failedAttempts >=
        TileMovementManager.MAX_INTERACTION_REPLAN_ATTEMPTS
    ) {
      this._pendingNonCombatMoves.delete(playerId);
      this._interactionApproachReservations.delete(playerId);
    }
  }

  private activatePrecomputedSegment(
    playerId: string,
    state: TileMovementState,
  ): boolean {
    const segment = this._precomputedPathSegments.get(playerId);
    this._precomputedPathSegments.delete(playerId);
    state.nextSegmentPrecomputed = false;
    if (!segment || segment.path.length === 0) return false;

    state.path = segment.path;
    state.pathIndex = 0;
    state.lastPathPartial = segment.lastPathPartial;
    state.requestedDestination = {
      x: segment.destination.x,
      z: segment.destination.z,
    };
    state.requestedInteractionArrival = segment.interactionArrival;
    return true;
  }

  /**
   * Called every server tick (600ms) - advance all players along their paths
   */
  onTick(tickNumber: number): void {
    // Reset the shared BFS budget/caches exactly once even when legacy and
    // per-player processors both observe this authoritative tick.
    this.beginMovementTick(tickNumber);

    for (const playerId of this._pendingObstructionReplans.keys()) {
      this.processPendingObstructionReplan(playerId);
    }
    for (const playerId of this._pendingNonCombatMoves.keys()) {
      this.processPendingNonCombatMove(playerId);
    }

    // Initialize previousTile for newly spawned players only
    // Movement processing will update it to "last stepped off" tile
    for (const [_playerId, state] of this.playerStates) {
      if (state.previousTile === null) {
        state.previousTile = { x: state.currentTile.x, z: state.currentTile.z };
      }
    }

    // Decay anti-cheat scores every 100 ticks (~60 seconds)
    // This rewards good behavior over time
    if (tickNumber % 100 === 0) {
      this.antiCheat.decayScores();
    }

    const terrain = this.getTerrain();
    const buildingService = this.getBuildingCollision();
    let pathContinuationsThisTick = 0;

    for (const [playerId, state] of this.playerStates) {
      // Skip if no path or at end
      if (state.path.length === 0 || state.pathIndex >= state.path.length) {
        continue;
      }

      const entity = this.world.entities.get(playerId);
      if (!entity) {
        this.getEntityOccupancy()?.vacate(playerId as EntityID);
        this.playerStates.delete(playerId);
        continue;
      }

      if (this.shouldYieldStreamingDuelMovement(playerId)) {
        this.stopPlayer(playerId);
        continue;
      }

      // Store previous position for rotation calculation (zero allocation)
      this._prevTile.x = state.currentTile.x;
      this._prevTile.z = state.currentTile.z;

      // Move 1 tile (walk) or 2 tiles (run) per tick
      const tilesToMove = state.isRunning
        ? TILES_PER_TICK_RUN
        : TILES_PER_TICK_WALK;

      for (let i = 0; i < tilesToMove; i++) {
        if (state.pathIndex >= state.path.length) break;

        // RULES-ACCURATE: Capture the tile we're stepping OFF of
        // This ensures previousTile is always 1 tile behind currentTile
        // Used by FollowManager for 1-tile trailing effect
        // A newly spawned/teleported actor legitimately has no previous tile.
        // Establish the reusable buffer on its first authoritative step instead
        // of relying on a non-null assertion that can crash the whole game tick.
        state.previousTile ??= {
          x: state.currentTile.x,
          z: state.currentTile.z,
        };
        state.previousTile.x = state.currentTile.x;
        state.previousTile.z = state.currentTile.z;

        const nextTile = state.path[state.pathIndex];

        // Paths can become stale after they are computed (for example when a
        // resource, station, door, or terrain bake adds collision). Never step
        // through the new obstruction; ordinary movement keeps its original
        // destination and receives a bounded fresh route on the next tick.
        if (!this.isPathStepWalkable(playerId, state, nextTile)) {
          this.queueObstructionReplan(playerId, state);
          break;
        }

        // Bridge railing guard: block any step that crosses a bridge railing
        const bridgeGuard = this.getBridgeSystem();
        if (
          bridgeGuard?.isBridgeTransitionBlocked(
            state.currentTile.x,
            state.currentTile.z,
            nextTile.x,
            nextTile.z,
          )
        ) {
          state.pathIndex = state.path.length; // Cancel remaining path
          break;
        }

        // Handle stair transitions if building service is available
        if (buildingService) {
          buildingService.handleStairTransition(
            playerId as EntityID,
            state.currentTile,
            nextTile,
          );
        }

        this.commitPlayerOccupancyStep(playerId, state.currentTile, nextTile);
        // Copy values instead of spread (zero allocation)
        state.currentTile.x = nextTile.x;
        state.currentTile.z = nextTile.z;
        state.pathIndex++;
      }

      // Track tiles moved for Agility XP (batched at 100 tiles = 50 XP)
      const tilesMoved =
        Math.abs(state.currentTile.x - this._prevTile.x) +
        Math.abs(state.currentTile.z - this._prevTile.z);
      if (tilesMoved > 0) {
        const currentTiles =
          (this.tilesTraveledForXP.get(playerId) || 0) + tilesMoved;
        if (currentTiles >= AGILITY_TILES_PER_XP_GRANT) {
          // Grant XP and preserve overflow
          const grantsEarned = Math.floor(
            currentTiles / AGILITY_TILES_PER_XP_GRANT,
          );
          const xpToGrant = grantsEarned * AGILITY_XP_PER_GRANT;
          this.tilesTraveledForXP.set(
            playerId,
            currentTiles % AGILITY_TILES_PER_XP_GRANT,
          );
          // Emit XP gain event (handled by SkillsSystem)
          this.world.emit(EventType.SKILLS_XP_GAINED, {
            playerId,
            skill: "agility",
            amount: xpToGrant,
          });
        } else {
          // Accumulate tiles silently
          this.tilesTraveledForXP.set(playerId, currentTiles);
        }
      }

      // Convert tile to world position (zero-allocation)
      tileToWorldInto(state.currentTile, this._worldPos);

      // determine Y elevation — building floor > terrain (bridge-aware)
      // getHeightAt() returns bridge deck height on bridge tiles (single source of truth),
      // so no explicit bridge check is needed here.
      {
        if (buildingService) {
          const currentFloor = buildingService.getPlayerFloor(
            playerId as EntityID,
          );
          const buildingId = buildingService.getBuildingAt(
            this._worldPos.x,
            this._worldPos.z,
          );

          let floorHeight: number | null = null;
          if (buildingId) {
            floorHeight = buildingService.getFloorHeight(
              buildingId,
              currentFloor,
            );
          }

          if (floorHeight !== null) {
            this._worldPos.y = floorHeight + 0.01;
          } else if (terrain) {
            const h = terrain.getHeightAt(this._worldPos.x, this._worldPos.z);
            if (h !== null && Number.isFinite(h)) {
              this._worldPos.y = h! + 0.01;
            } else {
              this._worldPos.y = 0.01;
            }
          } else {
            this._worldPos.y = 0.01;
          }
        } else if (terrain) {
          const height = terrain.getHeightAt(
            this._worldPos.x,
            this._worldPos.z,
          );
          if (height !== null && Number.isFinite(height)) {
            this._worldPos.y = (height as number) + 0.01;
          }
        }
      }

      // Update entity position on server
      entity.position.set(this._worldPos.x, this._worldPos.y, this._worldPos.z);
      entity.data.position = [
        this._worldPos.x,
        this._worldPos.y,
        this._worldPos.z,
      ];

      // RULES-ACCURATE: Mark player as having moved this tick
      // Face direction system will skip rotation update if player moved
      const faceManager = (
        this.world as {
          faceDirectionManager?: { markPlayerMoved: (id: string) => void };
        }
      ).faceDirectionManager;
      faceManager?.markPlayerMoved(playerId);

      // Calculate rotation based on movement direction (zero-allocation)
      tileToWorldInto(this._prevTile, this._prevWorldPos);
      const dx = this._worldPos.x - this._prevWorldPos.x;
      const dz = this._worldPos.z - this._prevWorldPos.z;

      if (Math.abs(dx) + Math.abs(dz) > 0.01) {
        // VRM faces -Z after factory rotation. Rotating -Z by yaw θ around Y gives:
        // (-sin(θ), 0, -cos(θ)). To face direction (dx, dz), solve:
        // -sin(θ) = dx, -cos(θ) = dz → θ = atan2(-dx, -dz)
        const yaw = Math.atan2(-dx, -dz);
        this._tempQuat.setFromAxisAngle(this._up, yaw);

        if (entity.node) {
          entity.node.quaternion.copy(this._tempQuat);
        }
        entity.data.quaternion = [
          this._tempQuat.x,
          this._tempQuat.y,
          this._tempQuat.z,
          this._tempQuat.w,
        ];
      }

      // Broadcast tile position update to clients
      // Include moveSeq so client can ignore stale packets from previous movements
      this.sendFn("entityTileUpdate", {
        id: playerId,
        tile: state.currentTile,
        worldPos: [this._worldPos.x, this._worldPos.y, this._worldPos.z],
        quaternion: entity.data.quaternion,
        emote: state.isRunning ? "run" : "walk",
        tickNumber,
        moveSeq: state.moveSeq,
      });

      // Look-ahead: pre-compute the next path segment 1 tick before the current
      // one ends so the client can append it seamlessly (no idle gap between segments).
      // Fires when exactly 1 tick of path is left and there is more ground to cover.
      // Capped per tick to prevent 25+ agents all BFS-pathfinding simultaneously.
      {
        const tilesPerTick = state.isRunning
          ? TILES_PER_TICK_RUN
          : TILES_PER_TICK_WALK;
        const tilesRemaining = state.path.length - state.pathIndex;
        if (
          pathContinuationsThisTick <
            TileMovementManager.MAX_PATH_CONTINUATIONS_PER_TICK &&
          tilesRemaining > 0 &&
          tilesRemaining <= tilesPerTick &&
          state.lastPathPartial &&
          state.requestedDestination &&
          !state.nextSegmentPrecomputed &&
          !tilesEqual(
            state.path[state.path.length - 1],
            state.requestedDestination,
          )
        ) {
          const pathEnd = state.path[state.path.length - 1];
          const precomputed = this._precomputeAndSendNextSegment(
            playerId,
            pathEnd,
            state.requestedDestination,
            state.isRunning,
            state,
          );
          state.nextSegmentPrecomputed = precomputed;
          if (precomputed) pathContinuationsThisTick++;
        }
      }

      // Check if arrived at destination
      if (state.pathIndex >= state.path.length) {
        let reachedRequestedDestination = true;

        // Path continuation: if BFS hit its iteration limit before reaching the
        // requested destination, immediately re-pathfind from the new tile so
        // movement continues seamlessly without a stop frame.
        if (
          state.lastPathPartial &&
          state.requestedDestination &&
          !tilesEqual(state.currentTile, state.requestedDestination)
        ) {
          const dest = state.requestedDestination;
          const interactionArrival = state.requestedInteractionArrival;
          if (state.nextSegmentPrecomputed) {
            // The client already has this segment; install the exact same path
            // into authoritative state before allowing either side to advance.
            if (this.activatePrecomputedSegment(playerId, state)) {
              continue;
            }

            // Defensive recovery: if the marker and stored segment ever drift,
            // replan from the authoritative tile instead of reporting arrival.
            state.requestedDestination = dest;
            state.lastPathPartial = true;
          }

          if (
            pathContinuationsThisTick <
            TileMovementManager.MAX_PATH_CONTINUATIONS_PER_TICK
          ) {
            // Clear before re-pathfind so an unreachable tile cannot loop forever
            state.requestedDestination = null;
            state.requestedInteractionArrival = null;
            state.lastPathPartial = false;
            const outcome = this._continuePathToDestination(
              playerId,
              dest,
              state.isRunning,
              interactionArrival,
            );
            pathContinuationsThisTick++;
            if (outcome === "started") {
              continue;
            }
            if (outcome === "deferred") {
              this.queueNonCombatMove(
                playerId,
                dest,
                state.isRunning,
                interactionArrival,
              );
              continue;
            }
            reachedRequestedDestination = false;
          } else {
            // Preserve fairness when more than the bounded number of agents need
            // a continuation in one tick. The retained intent is retried before
            // movement processing on the next authoritative tick.
            this.queueNonCombatMove(
              playerId,
              dest,
              state.isRunning,
              interactionArrival,
            );
            continue;
          }
        } else {
          // Reached the true destination (or it became unreachable)
          state.requestedDestination = null;
          state.requestedInteractionArrival = null;
          this._interactionApproachReservations.delete(playerId);
          state.lastPathPartial = false;
          state.nextSegmentPrecomputed = false;
        }

        // Get any pending arrival emote (e.g., "fishing" for gathering actions)
        // This is bundled with tileMovementEnd to prevent race conditions
        const arrivalEmote = this.consumeArrivalEmote(
          playerId,
          reachedRequestedDestination,
        );

        this.persistSettledPlayerPosition(playerId, this._worldPos);

        // Broadcast movement end with emote (atomic delivery)
        // Include moveSeq so client can ignore stale end packets
        // Note: Rotation is handled by FaceDirectionManager at end of tick
        this.sendFn("tileMovementEnd", {
          id: playerId,
          tile: state.currentTile,
          worldPos: [this._worldPos.x, this._worldPos.y, this._worldPos.z],
          moveSeq: state.moveSeq,
          emote: arrivalEmote,
        });

        // Clear path
        state.path.length = 0; // Zero-allocation clear
        state.pathIndex = 0;

        // modern MMORPG-style: Clear movement flag so combat can resume
        entity.data.tileMovementActive = false;

        // Broadcast entity state with arrival emote
        const entityModifiedChanges: Record<string, unknown> = {
          p: [this._worldPos.x, this._worldPos.y, this._worldPos.z],
          v: [0, 0, 0],
          e: arrivalEmote,
        };
        this.sendFn("entityModified", {
          id: playerId,
          changes: entityModifiedChanges,
        });
      }
    }
  }

  /**
   * Process movement for a specific player on this tick
   *
   * RULES-ACCURATE: Called by GameTickProcessor during player phase
   * This processes just one player's movement instead of all players.
   *
   * Zero-allocation: Uses pre-allocated tile buffers.
   *
   * @param playerId - The player to process movement for
   * @param tickNumber - Current tick number
   */
  processPlayerTick(playerId: string, tickNumber: number): void {
    this.beginMovementTick(tickNumber);
    this.processPendingObstructionReplan(playerId);
    this.processPendingNonCombatMove(playerId);

    const state = this.playerStates.get(playerId);
    if (!state) return;

    // Skip if no path or at end
    if (state.path.length === 0 || state.pathIndex >= state.path.length) {
      return;
    }

    const entity = this.world.entities.get(playerId);
    if (!entity) {
      this.getEntityOccupancy()?.vacate(playerId as EntityID);
      this.playerStates.delete(playerId);
      return;
    }

    if (this.shouldYieldStreamingDuelMovement(playerId)) {
      this.stopPlayer(playerId);
      return;
    }

    const terrain = this.getTerrain();
    const buildingService = this.getBuildingCollision();

    // Store previous position for rotation calculation (zero allocation)
    this._prevTile.x = state.currentTile.x;
    this._prevTile.z = state.currentTile.z;

    // Move 1 tile (walk) or 2 tiles (run) per tick
    const tilesToMove = state.isRunning
      ? TILES_PER_TICK_RUN
      : TILES_PER_TICK_WALK;

    for (let i = 0; i < tilesToMove; i++) {
      if (state.pathIndex >= state.path.length) break;

      // RULES-ACCURATE: Capture the tile we're stepping OFF of
      // This ensures previousTile is always 1 tile behind currentTile
      // Used by FollowManager for 1-tile trailing effect
      // syncPlayerPosition() creates a valid state whose previous tile is null
      // until the first step. Initialize it here before reusing the hot-path
      // buffer so server-controlled agents cannot crash on their opening move.
      state.previousTile ??= {
        x: state.currentTile.x,
        z: state.currentTile.z,
      };
      state.previousTile.x = state.currentTile.x;
      state.previousTile.z = state.currentTile.z;

      const nextTile = state.path[state.pathIndex];

      if (!this.isPathStepWalkable(playerId, state, nextTile)) {
        this.queueObstructionReplan(playerId, state);
        break;
      }

      // Bridge railing guard: block any step that crosses a bridge railing
      const bridgeGuardPT = this.getBridgeSystem();
      if (
        bridgeGuardPT?.isBridgeTransitionBlocked(
          state.currentTile.x,
          state.currentTile.z,
          nextTile.x,
          nextTile.z,
        )
      ) {
        state.pathIndex = state.path.length;
        break;
      }

      // Handle stair transitions if building service is available
      if (buildingService) {
        buildingService.handleStairTransition(
          playerId as EntityID,
          state.currentTile,
          nextTile,
        );
      }

      this.commitPlayerOccupancyStep(playerId, state.currentTile, nextTile);
      // Copy values instead of spread (zero allocation)
      state.currentTile.x = nextTile.x;
      state.currentTile.z = nextTile.z;
      state.pathIndex++;
    }

    // Convert tile to world position (zero-allocation)
    tileToWorldInto(state.currentTile, this._worldPos);

    // determine Y elevation — building floor > terrain (bridge-aware)
    // getHeightAt() returns bridge deck height on bridge tiles (single source of truth),
    // so no explicit bridge check is needed here.
    if (buildingService) {
      const currentFloor = buildingService.getPlayerFloor(playerId as EntityID);
      const buildingId = buildingService.getBuildingAt(
        state.currentTile.x,
        state.currentTile.z,
      );

      let floorHeight: number | null = null;
      if (buildingId) {
        floorHeight = buildingService.getFloorHeight(buildingId, currentFloor);
      }

      if (floorHeight !== null) {
        this._worldPos.y = floorHeight + 0.01;
      } else if (terrain) {
        const h = terrain.getHeightAt(this._worldPos.x, this._worldPos.z);
        if (h !== null && Number.isFinite(h)) {
          this._worldPos.y = h! + 0.01;
        } else {
          this._worldPos.y = 0.01;
        }
      } else {
        this._worldPos.y = 0.01;
      }
    } else if (terrain) {
      const height = terrain.getHeightAt(this._worldPos.x, this._worldPos.z);
      if (height !== null && Number.isFinite(height)) {
        this._worldPos.y = (height as number) + 0.01;
      }
    }

    // Update entity position on server
    entity.position.set(this._worldPos.x, this._worldPos.y, this._worldPos.z);
    entity.data.position = [
      this._worldPos.x,
      this._worldPos.y,
      this._worldPos.z,
    ];

    // RULES-ACCURATE: Mark player as having moved this tick
    // Face direction system will skip rotation update if player moved
    const faceManager = (
      this.world as {
        faceDirectionManager?: { markPlayerMoved: (id: string) => void };
      }
    ).faceDirectionManager;
    faceManager?.markPlayerMoved(playerId);

    // Calculate rotation based on movement direction (zero-allocation)
    tileToWorldInto(this._prevTile, this._prevWorldPos);
    const dx = this._worldPos.x - this._prevWorldPos.x;
    const dz = this._worldPos.z - this._prevWorldPos.z;

    if (Math.abs(dx) + Math.abs(dz) > 0.01) {
      const yaw = Math.atan2(-dx, -dz);
      this._tempQuat.setFromAxisAngle(this._up, yaw);

      if (entity.node) {
        entity.node.quaternion.copy(this._tempQuat);
      }
      entity.data.quaternion = [
        this._tempQuat.x,
        this._tempQuat.y,
        this._tempQuat.z,
        this._tempQuat.w,
      ];
    }

    // Broadcast tile position update to clients
    this.sendFn("entityTileUpdate", {
      id: playerId,
      tile: state.currentTile,
      worldPos: [this._worldPos.x, this._worldPos.y, this._worldPos.z],
      quaternion: entity.data.quaternion,
      emote: state.isRunning ? "run" : "walk",
      tickNumber,
      moveSeq: state.moveSeq,
    });

    // Look-ahead: pre-compute the next path segment 1 tick before the current
    // one ends so the client can append it seamlessly (no idle gap between segments).
    {
      const tilesPerTick = state.isRunning
        ? TILES_PER_TICK_RUN
        : TILES_PER_TICK_WALK;
      const tilesRemaining = state.path.length - state.pathIndex;
      if (
        tilesRemaining > 0 &&
        tilesRemaining <= tilesPerTick &&
        state.lastPathPartial &&
        state.requestedDestination &&
        !state.nextSegmentPrecomputed &&
        !tilesEqual(
          state.path[state.path.length - 1],
          state.requestedDestination,
        )
      ) {
        const pathEnd = state.path[state.path.length - 1];
        const precomputed = this._precomputeAndSendNextSegment(
          playerId,
          pathEnd,
          state.requestedDestination,
          state.isRunning,
          state,
        );
        state.nextSegmentPrecomputed = precomputed;
      }
    }

    // Check if arrived at destination
    if (state.pathIndex >= state.path.length) {
      let reachedRequestedDestination = true;

      // Path continuation: if BFS hit its iteration limit before reaching the
      // requested destination, immediately re-pathfind from the new tile so
      // movement continues seamlessly without a stop frame.
      if (
        state.lastPathPartial &&
        state.requestedDestination &&
        !tilesEqual(state.currentTile, state.requestedDestination)
      ) {
        const dest = state.requestedDestination;
        const interactionArrival = state.requestedInteractionArrival;
        if (state.nextSegmentPrecomputed) {
          if (this.activatePrecomputedSegment(playerId, state)) return;

          state.requestedDestination = dest;
          state.lastPathPartial = true;
        }

        state.requestedDestination = null;
        state.requestedInteractionArrival = null;
        this._interactionApproachReservations.delete(playerId);
        state.lastPathPartial = false;
        const outcome = this._continuePathToDestination(
          playerId,
          dest,
          state.isRunning,
          interactionArrival,
        );
        if (outcome === "started") return;
        if (outcome === "deferred") {
          this.queueNonCombatMove(
            playerId,
            dest,
            state.isRunning,
            interactionArrival,
          );
          return;
        }
        reachedRequestedDestination = false;
      } else {
        state.requestedDestination = null;
        state.requestedInteractionArrival = null;
        this._interactionApproachReservations.delete(playerId);
        state.lastPathPartial = false;
        state.nextSegmentPrecomputed = false;
      }

      // Get any pending arrival emote (e.g., "fishing" for gathering actions)
      // This is bundled with tileMovementEnd to prevent race conditions
      const arrivalEmote = this.consumeArrivalEmote(
        playerId,
        reachedRequestedDestination,
      );

      this.persistSettledPlayerPosition(playerId, this._worldPos);

      // Broadcast movement end with emote (atomic delivery)
      // Note: Rotation is handled by FaceDirectionManager at end of tick
      this.sendFn("tileMovementEnd", {
        id: playerId,
        tile: state.currentTile,
        worldPos: [this._worldPos.x, this._worldPos.y, this._worldPos.z],
        moveSeq: state.moveSeq,
        emote: arrivalEmote,
      });

      // Clear path
      state.path.length = 0; // Zero-allocation clear
      state.pathIndex = 0;

      // modern MMORPG-style: Clear movement flag so combat can resume
      entity.data.tileMovementActive = false;

      // Broadcast entity state with arrival emote
      const entityModifiedChanges: Record<string, unknown> = {
        p: [this._worldPos.x, this._worldPos.y, this._worldPos.z],
        v: [0, 0, 0],
        e: arrivalEmote,
      };
      this.sendFn("entityModified", {
        id: playerId,
        changes: entityModifiedChanges,
      });
    }
  }

  /**
   * Continue movement toward a destination after a partial BFS path ended.
   * Called server-side only — skips rate-limiting and input validation because
   * the original move request was already fully validated.
   *
   * If BFS returns an empty path the destination is definitively unreachable
   * and movement stops (no infinite loop).
   */
  private _continuePathToDestination(
    playerId: string,
    destination: TileCoord,
    isRunning: boolean,
    interactionArrival: TileInteractionArrival | null = null,
  ): "started" | "deferred" | "failed" {
    const state = this.playerStates.get(playerId);
    const entity = this.world.entities.get(playerId);
    if (!state || !entity) return "failed";

    // Respect the same guards as handleMoveRequest — don't continue moving if
    // the player died or became frozen mid-path (e.g. duel countdown started)
    const deathState = entity.data?.deathState as DeathState | undefined;
    if (deathState === DeathState.DYING || deathState === DeathState.DEAD) {
      state.requestedDestination = null;
      state.requestedInteractionArrival = null;
      this._interactionApproachReservations.delete(playerId);
      state.lastPathPartial = false;
      return "failed";
    }

    const duelSystem = this.world.getSystem("duel") as {
      canMove?: (playerId: string) => boolean;
    } | null;
    if (duelSystem?.canMove && !duelSystem.canMove(playerId)) {
      state.requestedDestination = null;
      state.requestedInteractionArrival = null;
      this._interactionApproachReservations.delete(playerId);
      state.lastPathPartial = false;
      return "failed";
    }

    // Global BFS iteration budget check
    if (
      this._bfsIterationsThisTick >=
      TileMovementManager.MAX_BFS_ITERATIONS_PER_TICK
    ) {
      return "deferred"; // Will retry next tick
    }

    const buildingService = this.getBuildingCollision();
    const currentFloor = buildingService
      ? buildingService.getPlayerFloor(playerId as EntityID)
      : 0;
    const currentBuildingId = buildingService
      ? buildingService.getBuildingAt(state.currentTile.x, state.currentTile.z)
      : null;

    const remainingBudget =
      TileMovementManager.MAX_BFS_ITERATIONS_PER_TICK -
      this._bfsIterationsThisTick;
    if (
      interactionArrival &&
      this.isTileWithinInteractionArrival(
        state.currentTile,
        destination,
        interactionArrival,
      )
    ) {
      state.requestedDestination = null;
      state.requestedInteractionArrival = null;
      this._interactionApproachReservations.delete(playerId);
      return "failed";
    }

    const path = this.findNonCombatPath(
      playerId,
      state.currentTile,
      destination,
      interactionArrival,
      currentFloor,
      currentBuildingId,
      remainingBudget,
    );
    this._bfsIterationsThisTick += this.pathfinder.getLastIterationsUsed();

    // Empty path means destination is unreachable — stop here
    if (path.length === 0) return "failed";

    state.path = path;
    state.pathIndex = 0;
    state.isRunning = isRunning;
    state.moveSeq = (state.moveSeq || 0) + 1;
    state.lastPathPartial = this.pathfinder.wasLastPathPartial();

    // Keep the ultimate non-combat destination for both partial-path
    // continuation and dynamic obstruction recovery. Normal arrival clears it.
    state.requestedDestination = { x: destination.x, z: destination.z };
    state.requestedInteractionArrival = interactionArrival;

    entity.data.tileMovementActive = true;

    // Build network path buffer (zero-allocation pattern)
    this._networkPathBuffer.length = path.length;
    for (let i = 0; i < path.length; i++) {
      if (!this._networkPathBuffer[i]) {
        this._networkPathBuffer[i] = { x: 0, z: 0 };
      }
      this._networkPathBuffer[i].x = path[i].x;
      this._networkPathBuffer[i].z = path[i].z;
    }

    this.sendFn("tileMovementStart", {
      id: playerId,
      startTile: { x: state.currentTile.x, z: state.currentTile.z },
      path: this._networkPathBuffer,
      running: isRunning,
      destinationTile: {
        x: path[path.length - 1].x,
        z: path[path.length - 1].z,
      },
      moveSeq: state.moveSeq,
      emote: isRunning ? "run" : "walk",
    });
    return "started";
  }

  /**
   * Pre-compute the next path segment and send it to the client 1 tick before
   * the current segment ends, allowing seamless path-appending on the client
   * with no idle frame between segments.
   *
   * Unlike _continuePathToDestination this method does NOT overwrite the active
   * path or its destination metadata. It stores the exact look-ahead segment
   * separately until the authoritative server reaches the segment boundary.
   */
  private _precomputeAndSendNextSegment(
    playerId: string,
    fromTile: TileCoord,
    destination: TileCoord,
    isRunning: boolean,
    state: TileMovementState,
  ): boolean {
    const entity = this.world.entities.get(playerId);
    if (!entity) return false;

    // Apply the same movement guards as handleMoveRequest
    const deathState = entity.data?.deathState as DeathState | undefined;
    if (deathState === DeathState.DYING || deathState === DeathState.DEAD) {
      return false;
    }

    const duelSystem = this.world.getSystem("duel") as {
      canMove?: (playerId: string) => boolean;
    } | null;
    if (duelSystem?.canMove && !duelSystem.canMove(playerId)) {
      return false;
    }

    // Global BFS iteration budget check
    if (
      this._bfsIterationsThisTick >=
      TileMovementManager.MAX_BFS_ITERATIONS_PER_TICK
    ) {
      return false; // Will be picked up by continuation on next tick
    }

    const buildingService = this.getBuildingCollision();
    const currentFloor = buildingService
      ? buildingService.getPlayerFloor(playerId as EntityID)
      : 0;
    const currentBuildingId = buildingService
      ? buildingService.getBuildingAt(fromTile.x, fromTile.z)
      : null;

    // BFS from the last tile of the current path (the player hasn't stepped on
    // it yet — keeps the segment boundary invisible to the client)
    const remainingBudget =
      TileMovementManager.MAX_BFS_ITERATIONS_PER_TICK -
      this._bfsIterationsThisTick;
    const path = this.findNonCombatPath(
      playerId,
      fromTile,
      destination,
      state.requestedInteractionArrival,
      currentFloor,
      currentBuildingId,
      remainingBudget,
    );
    this._bfsIterationsThisTick += this.pathfinder.getLastIterationsUsed();

    if (path.length === 0) {
      // Destination is unreachable from the path-end tile; let normal end-of-path
      // handling deal with it when the current segment finishes.
      return false;
    }

    // Advance moveSeq so the client can validate ordering (stale precomputed
    // packets sent before a re-click are rejected via the existing moveSeq check)
    state.moveSeq = (state.moveSeq || 0) + 1;
    const lastPathPartial = this.pathfinder.wasLastPathPartial();
    this._precomputedPathSegments.set(playerId, {
      path,
      destination: { x: destination.x, z: destination.z },
      interactionArrival: state.requestedInteractionArrival,
      lastPathPartial,
    });

    // Build network path buffer (zero-allocation pattern)
    this._networkPathBuffer.length = path.length;
    for (let i = 0; i < path.length; i++) {
      if (!this._networkPathBuffer[i]) {
        this._networkPathBuffer[i] = { x: 0, z: 0 };
      }
      this._networkPathBuffer[i].x = path[i].x;
      this._networkPathBuffer[i].z = path[i].z;
    }

    this.sendFn("tileMovementStart", {
      id: playerId,
      startTile: { x: fromTile.x, z: fromTile.z },
      path: this._networkPathBuffer,
      running: isRunning,
      destinationTile: {
        x: path[path.length - 1].x,
        z: path[path.length - 1].z,
      },
      moveSeq: state.moveSeq,
      emote: isRunning ? "run" : "walk",
      isContinuation: true,
    });
    return true;
  }

  /**
   * Legacy frame-based update (for compatibility during transition)
   * This should be removed once tile movement is fully working
   */
  update(_dt: number): void {
    // No-op - movement is now tick-based
  }

  /**
   * Cleanup state for a player
   */
  cleanup(playerId: string): void {
    this.getEntityOccupancy()?.vacate(playerId as EntityID);
    this.playerStates.delete(playerId);
    this._pendingObstructionReplans.delete(playerId);
    this._pendingNonCombatMoves.delete(playerId);
    this._precomputedPathSegments.delete(playerId);
    this._interactionApproachReservations.delete(playerId);
    this.arrivalEmotes.delete(playerId);
    this.arrivalEmoteResolvers.delete(playerId);
    this.tilesTraveledForXP.delete(playerId);
    this.antiCheat.cleanup(playerId);
    this.movementRateLimiter.reset(playerId);
    this.pathfindRateLimiter.reset(playerId);
  }

  /**
   * Reset agility XP progress for a player (called on death)
   * Tiles accumulated toward the next XP grant are lost as a death penalty
   */
  resetAgilityProgress(playerId: string): void {
    this.tilesTraveledForXP.set(playerId, 0);
  }

  /**
   * Set an emote to be used when the player arrives at their destination.
   * This emote is included in the tileMovementEnd packet, ensuring atomic delivery
   * with the arrival notification. Prevents race conditions where the client
   * sets "idle" before receiving a separate emote packet.
   *
   * @param playerId - The player ID
   * @param emote - The emote to use on arrival (e.g., "fishing", "chopping")
   */
  setArrivalEmote(
    playerId: string,
    emote: string,
    resolveAtArrival?: () => string | null,
  ): void {
    this.arrivalEmotes.set(playerId, emote);
    if (resolveAtArrival) {
      this.arrivalEmoteResolvers.set(playerId, resolveAtArrival);
    } else {
      this.arrivalEmoteResolvers.delete(playerId);
    }
  }

  /**
   * Clear any pending arrival emote for a player.
   * Called when gathering is cancelled or player moves to a different destination.
   */
  clearArrivalEmote(playerId: string): void {
    this.arrivalEmotes.delete(playerId);
    this.arrivalEmoteResolvers.delete(playerId);
  }

  /**
   * Sync player position after respawn or teleport
   *
   * CRITICAL: When a player respawns at spawn point, the TileMovementManager's
   * internal state still has their old tile position. This method resets the
   * internal state to match the actual world position, preventing path calculation
   * from the wrong starting tile.
   */
  syncPlayerPosition(
    playerId: string,
    position: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number } {
    let newTile = worldToTile(position.x, position.z);
    const occupancy = this.getEntityOccupancy();
    const entityId = playerId as EntityID;
    let positionWasRelocated = false;
    if (occupancy?.isOccupied(newTile, entityId)) {
      const availableTile = this.findClosestWalkableTile(
        position,
        TileMovementManager.SPAWN_RELOCATION_RADIUS,
        (tile) => occupancy.isOccupied(tile, entityId) === false,
      );
      if (availableTile) {
        newTile = availableTile;
        positionWasRelocated = true;
      }
    }
    occupancy?.vacate(entityId);
    this._pendingObstructionReplans.delete(playerId);
    this._pendingNonCombatMoves.delete(playerId);
    this._precomputedPathSegments.delete(playerId);
    this._interactionApproachReservations.delete(playerId);
    this.arrivalEmotes.delete(playerId);
    this.arrivalEmoteResolvers.delete(playerId);

    // Get existing state or create new one
    let state = this.playerStates.get(playerId);

    if (state) {
      // Clear any pending movement and update tile
      state.currentTile = newTile;
      state.path.length = 0; // Zero-allocation clear
      state.pathIndex = 0;
      state.previousTile = null;
      state.moveSeq = (state.moveSeq || 0) + 1; // Increment to invalidate stale client packets

      // Cancel any pending path continuation — the player has teleported/respawned
      // so the original destination is no longer valid
      state.requestedDestination = null;
      state.requestedInteractionArrival = null;
      state.lastPathPartial = false;
      state.nextSegmentPrecomputed = false;

      // modern MMORPG-style: Clear movement flag so combat can resume
      const entity = this.world.entities.get(playerId);
      if (entity?.data) {
        entity.data.tileMovementActive = false;
      }

      console.log(
        `[TileMovement] Synced ${playerId} position to tile (${newTile.x},${newTile.z}) after respawn/teleport`,
      );
    } else {
      // Create fresh state at new position
      state = createTileMovementState(newTile);
      this.playerStates.set(playerId, state);
      console.log(
        `[TileMovement] Created new state for ${playerId} at tile (${newTile.x},${newTile.z})`,
      );
    }
    this.ensurePlayerOccupancy(playerId, newTile);
    this.tickStartTiles.set(playerId, { x: newTile.x, z: newTile.z });

    let resolvedPosition = {
      x: position.x,
      y: position.y,
      z: position.z,
    };
    const entity = this.world.entities.get(playerId);
    if (positionWasRelocated) {
      const corrected = tileToWorld(newTile);
      corrected.y = position.y;
      const terrain = this.getTerrain();
      const height = terrain?.getHeightAt(corrected.x, corrected.z);
      if (height !== null && height !== undefined && Number.isFinite(height)) {
        corrected.y = height + 0.01;
      }
      entity?.position?.set(corrected.x, corrected.y, corrected.z);
      if (entity?.data) {
        entity.data.position = [corrected.x, corrected.y, corrected.z];
      }
      resolvedPosition = corrected;
      this.persistSettledPlayerPosition(playerId, corrected);
      this.sendFn("tileMovementEnd", {
        id: playerId,
        tile: newTile,
        worldPos: [corrected.x, corrected.y, corrected.z],
        moveSeq: state.moveSeq,
        emote: "idle",
        reason: "occupied_spawn_relocation",
      });
      console.warn(
        `[TileMovement] Relocated ${playerId} to unoccupied tile (${newTile.x},${newTile.z}) during spawn/teleport sync`,
      );
    }
    if (entity?.position) {
      if (typeof entity.position.set === "function") {
        entity.position.set(
          resolvedPosition.x,
          resolvedPosition.y,
          resolvedPosition.z,
        );
      } else {
        entity.position.x = resolvedPosition.x;
        entity.position.y = resolvedPosition.y;
        entity.position.z = resolvedPosition.z;
      }
    }
    if (entity?.data) {
      entity.data.position = [
        resolvedPosition.x,
        resolvedPosition.y,
        resolvedPosition.z,
      ];
    }
    return resolvedPosition;
  }

  /**
   * Get current tile for a player
   */
  getCurrentTile(playerId: string): TileCoord | null {
    const state = this.playerStates.get(playerId);
    return state ? state.currentTile : null;
  }

  /**
   * Get the previous tile for a player (where they were at START of tick)
   *
   * RULES-ACCURATE: Used by FollowManager for follow mechanic.
   * Followers path to target's PREVIOUS tile, creating the
   * characteristic 1-tick trailing effect.
   *
   * Edge cases:
   * - If no previous tile (just spawned/teleported): use tile WEST of current
   * - This matches classic MMORPG behavior per private server community research
   *
   */
  getPreviousTile(playerId: string): TileCoord {
    const state = this.playerStates.get(playerId);

    // Use captured previous tile if available
    if (state?.previousTile) {
      return state.previousTile;
    }

    // Fallback: If no previous tile (just spawned/teleported), use tile WEST of current
    // This matches classic MMORPG behavior per private server research
    if (state) {
      return {
        x: state.currentTile.x - 1,
        z: state.currentTile.z,
      };
    }

    // No state at all - try to get from entity position
    const entity = this.world.entities.get(playerId);
    if (entity?.position) {
      const currentTile = worldToTile(entity.position.x, entity.position.z);
      return {
        x: currentTile.x - 1,
        z: currentTile.z,
      };
    }

    // Ultimate fallback (should never happen)
    return { x: 0, z: 0 };
  }

  /**
   * Get the tick-start tile for a player
   *
   * RULES-ACCURATE: Returns where the player was at the VERY START of the
   * current tick, BEFORE any movement was processed. This is different from
   * previousTile (which is the last tile stepped off during movement).
   *
   * Used by FollowManager to create the authentic 1-tick delay effect:
   * - Tick N: Target is at tile A (tick-start), then moves to tile B
   * - Tick N: Follower sees target's tick-start position (A)
   * - Tick N+1: Follower moves toward A, while target is now at B
   *
   * This creates the characteristic "always one step behind" feel.
   */
  getTickStartTile(playerId: string): TileCoord | null {
    return this.tickStartTiles.get(playerId) ?? null;
  }

  getPlayerCount(): number {
    return this.playerStates.size;
  }

  /**
   * Snapshot lightweight movement workload counters for a slow-tick report.
   * This intentionally scans only when the caller has already observed a slow
   * tick, keeping the ordinary 600ms movement loop allocation-free.
   */
  getPerformanceContext(): {
    players: number;
    activePaths: number;
    queuedPathTiles: number;
    bfsIterations: number;
    walkabilityCacheEntries: number;
    directionalBlockCacheEntries: number;
    pendingObstructionReplans: number;
    pendingNonCombatMoves: number;
    precomputedPathSegments: number;
    occupiedPlayerTiles: number;
    occupiedMobTiles: number;
    trackedOccupants: number;
  } {
    let activePaths = 0;
    let queuedPathTiles = 0;

    for (const state of this.playerStates.values()) {
      const remaining = Math.max(0, state.path.length - state.pathIndex);
      if (remaining > 0) {
        activePaths++;
        queuedPathTiles += remaining;
      }
    }

    const occupancy = this.getEntityOccupancy()?.getStats();
    return {
      players: this.playerStates.size,
      activePaths,
      queuedPathTiles,
      bfsIterations: this._bfsIterationsThisTick,
      walkabilityCacheEntries: this._walkabilityCache.size,
      directionalBlockCacheEntries: this._directionalBlockCache.size,
      pendingObstructionReplans: this._pendingObstructionReplans.size,
      pendingNonCombatMoves: this._pendingNonCombatMoves.size,
      precomputedPathSegments: this._precomputedPathSegments.size,
      occupiedPlayerTiles: occupancy?.playerTileCount ?? 0,
      occupiedMobTiles: occupancy?.mobTileCount ?? 0,
      trackedOccupants: occupancy?.trackedEntityCount ?? 0,
    };
  }

  /**
   * Stop a player's current movement immediately.
   * Clears their path and sends tileMovementEnd so the client's TileInterpolator
   * stops interpolating along the old path.
   * Used when starting actions like firemaking that require the player to stand still.
   */
  stopPlayer(playerId: string): void {
    this._pendingObstructionReplans.delete(playerId);
    this._pendingNonCombatMoves.delete(playerId);
    this._precomputedPathSegments.delete(playerId);
    this._interactionApproachReservations.delete(playerId);
    const state = this.playerStates.get(playerId);
    if (!state) return;

    state.requestedDestination = null;
    state.requestedInteractionArrival = null;
    state.lastPathPartial = false;
    state.nextSegmentPrecomputed = false;
    if (state.path.length === 0) return;

    state.path.length = 0;
    state.pathIndex = 0;
    state.moveSeq = (state.moveSeq || 0) + 1;

    const entity = this.world.entities.get(playerId);
    if (entity?.data) {
      entity.data.tileMovementActive = false;
    }

    // Send tileMovementEnd so the client's TileInterpolator stops
    const worldPos = tileToWorld(state.currentTile);
    if (entity?.position) {
      worldPos.y = entity.position.y;
    }

    this.persistSettledPlayerPosition(playerId, worldPos);

    this.sendFn("tileMovementEnd", {
      id: playerId,
      tile: state.currentTile,
      worldPos: [worldPos.x, worldPos.y, worldPos.z],
      moveSeq: state.moveSeq,
      emote: "idle",
    });
  }

  /**
   * Read-only movement diagnostics for server-controlled actors. This is kept
   * out of the normal tick path and is used by duel telemetry to prove whether
   * a requested reposition actually installed an authoritative tile path.
   */
  getPlayerMovementDebug(playerId: string): {
    activePath: boolean;
    currentTile: { x: number; z: number } | null;
    nextTile: { x: number; z: number } | null;
    destinationTile: { x: number; z: number } | null;
    remainingPathTiles: number;
    moveSeq: number;
  } {
    const state = this.playerStates.get(playerId);
    if (!state) {
      return {
        activePath: false,
        currentTile: null,
        nextTile: null,
        destinationTile: null,
        remainingPathTiles: 0,
        moveSeq: 0,
      };
    }

    const remainingPathTiles = Math.max(0, state.path.length - state.pathIndex);
    const nextTile = state.path[state.pathIndex];
    const destinationTile =
      state.requestedDestination ?? state.path[state.path.length - 1];
    return {
      activePath: remainingPathTiles > 0,
      currentTile: { x: state.currentTile.x, z: state.currentTile.z },
      nextTile: nextTile ? { x: nextTile.x, z: nextTile.z } : null,
      destinationTile: destinationTile
        ? { x: destinationTile.x, z: destinationTile.z }
        : null,
      remainingPathTiles,
      moveSeq: state.moveSeq,
    };
  }

  /**
   * Check if a player is currently moving
   */
  isMoving(playerId: string): boolean {
    const state = this.playerStates.get(playerId);
    return state
      ? state.path.length > 0 && state.pathIndex < state.path.length
      : false;
  }

  /**
   * Check if a player has run mode enabled
   * Used by resource/combat handlers to determine movement speed
   */
  getIsRunning(playerId: string): boolean {
    const state = this.playerStates.get(playerId);
    return state?.isRunning ?? false;
  }

  /**
   * Server-initiated movement toward a target position
   * Used for combat follow when target moves out of range
   *
   * classic MMORPG-style pathfinding (from wiki):
   * - When clicking on an NPC, the requested tiles are all tiles within attack range
   * - BFS finds the CLOSEST valid tile among those options
   * - For melee range 1: only cardinal tiles (N/S/E/W) are valid destinations
   * - For ranged/magic: Chebyshev distance to any tile within range
   * - Pathfinding recalculates every tick until target tile is found
   *
   * @param playerId - The player to move
   * @param targetPosition - Target position in world coordinates
   * @param running - Whether to run (default: true for combat following)
   * @param attackRange - Weapon's attack range (1 = standard melee, 2 = halberd, 10 = ranged/magic, 0 = non-combat)
   * @param attackType - Attack type (MELEE, RANGED, MAGIC) - affects positioning logic
   *
   */
  private normalizeInteractionArrival(
    arrival: TileInteractionArrival | null | undefined,
  ): TileInteractionArrival | null {
    if (!arrival) return null;
    const interactionRange = Math.floor(arrival.interactionRange);
    const footprintWidth = Math.floor(arrival.footprintWidth);
    const footprintDepth = Math.floor(arrival.footprintDepth);
    if (
      !Number.isFinite(arrival.interactionRange) ||
      !Number.isFinite(arrival.footprintWidth) ||
      !Number.isFinite(arrival.footprintDepth) ||
      interactionRange < 1 ||
      interactionRange > 10 ||
      footprintWidth < 1 ||
      footprintWidth > 10 ||
      footprintDepth < 1 ||
      footprintDepth > 10
    ) {
      return null;
    }
    return { interactionRange, footprintWidth, footprintDepth };
  }

  private isTileWithinInteractionArrival(
    tile: TileCoord,
    destination: TileCoord,
    arrival: TileInteractionArrival,
  ): boolean {
    const minX = destination.x - Math.floor(arrival.footprintWidth / 2);
    const maxX = minX + arrival.footprintWidth - 1;
    const minZ = destination.z - Math.floor(arrival.footprintDepth / 2);
    const maxZ = minZ + arrival.footprintDepth - 1;
    const dx = tile.x < minX ? minX - tile.x : Math.max(0, tile.x - maxX);
    const dz = tile.z < minZ ? minZ - tile.z : Math.max(0, tile.z - maxZ);
    return Math.max(dx, dz) <= arrival.interactionRange;
  }

  private findNonCombatPath(
    playerId: string,
    start: TileCoord,
    destination: TileCoord,
    arrival: TileInteractionArrival | null,
    currentFloor: number,
    currentBuildingId: string | null,
    remainingBudget: number,
  ): TileCoord[] {
    const guidedBudget = Math.min(
      remainingBudget,
      TileMovementManager.MAX_GUIDED_NON_COMBAT_ITERATIONS_PER_SEARCH,
    );
    const canTraverse = (tile: TileCoord, fromTile?: TileCoord) =>
      this.isTileTraversableForPlayer(
        playerId,
        tile,
        currentFloor,
        fromTile,
        currentBuildingId,
      );
    if (!arrival) {
      return this.pathfinder.findPathGuided(
        start,
        destination,
        canTraverse,
        guidedBudget,
      );
    }

    const offsetX = Math.floor(arrival.footprintWidth / 2);
    const offsetZ = Math.floor(arrival.footprintDepth / 2);
    const footprintMinX = destination.x - offsetX;
    const footprintMaxX = footprintMinX + arrival.footprintWidth - 1;
    const footprintMinZ = destination.z - offsetZ;
    const footprintMaxZ = footprintMinZ + arrival.footprintDepth - 1;
    const reservedByOther = new Set<string>();
    for (const [reservedPlayerId, reservation] of this
      ._interactionApproachReservations) {
      if (reservedPlayerId === playerId) continue;
      reservedByOther.add(`${reservation.tile.x},${reservation.tile.z}`);
    }
    const destinationsByDistance = new Map<number, TileCoord[]>();
    for (
      let x = footprintMinX - arrival.interactionRange;
      x <= footprintMaxX + arrival.interactionRange;
      x++
    ) {
      for (
        let z = footprintMinZ - arrival.interactionRange;
        z <= footprintMaxZ + arrival.interactionRange;
        z++
      ) {
        const tile = { x, z };
        if (!canTraverse(tile) || reservedByOther.has(`${x},${z}`)) continue;
        const dx =
          x < footprintMinX
            ? footprintMinX - x
            : Math.max(0, x - footprintMaxX);
        const dz =
          z < footprintMinZ
            ? footprintMinZ - z
            : Math.max(0, z - footprintMaxZ);
        const distance = Math.max(dx, dz);
        const destinations = destinationsByDistance.get(distance) ?? [];
        destinations.push(tile);
        destinationsByDistance.set(distance, destinations);
      }
    }
    let validDestinations: TileCoord[] = [];
    for (let distance = 0; distance <= arrival.interactionRange; distance++) {
      const candidates = destinationsByDistance.get(distance);
      if (candidates?.length) {
        validDestinations = candidates;
        break;
      }
    }
    const path = this.pathfinder.findPathToAnyGuided(
      start,
      validDestinations,
      canTraverse,
      guidedBudget,
    );
    if (path.length > 0 && !this.pathfinder.wasLastPathPartial()) {
      const reservedTile = path[path.length - 1];
      this._interactionApproachReservations.set(playerId, {
        tile: { x: reservedTile.x, z: reservedTile.z },
        destination: { x: destination.x, z: destination.z },
      });
    }
    return path;
  }

  movePlayerToward(
    playerId: string,
    targetPosition: { x: number; y: number; z: number },
    running: boolean = true,
    attackRange: number = 0, // 0 = non-combat, 1+ = combat range
    attackType: AttackType = AttackType.MELEE,
    interactionArrival?: TileInteractionArrival | null,
  ): boolean {
    const entity = this.world.entities.get(playerId);
    if (!entity) {
      return false;
    }

    // Death lock: Dead players cannot move
    const deathState = entity.data?.deathState;
    if (deathState === DeathState.DYING || deathState === DeathState.DEAD) {
      return false;
    }

    // Arena bounds clamp: when an agent is locked into the duel arena, clamp
    // the movement target so combat-follow, pending-attack walk, and every
    // other path through movePlayerToward stays inside the arena.  This is the
    // authoritative server-side gate — executeMove has its own clamp on the
    // service layer, but COMBAT_FOLLOW_TARGET and PendingAttackManager bypass
    // that and come straight here.
    const arenaBounds = (
      entity.data as {
        arenaBounds?: {
          minX: number;
          maxX: number;
          minZ: number;
          maxZ: number;
        } | null;
      }
    )?.arenaBounds;
    if (arenaBounds) {
      const PAD = 2.0;
      targetPosition = {
        x: Math.min(
          arenaBounds.maxX - PAD,
          Math.max(arenaBounds.minX + PAD, targetPosition.x),
        ),
        y: targetPosition.y,
        z: Math.min(
          arenaBounds.maxZ - PAD,
          Math.max(arenaBounds.minZ + PAD, targetPosition.z),
        ),
      };
    }

    const state = this.getOrCreateState(playerId);

    // CRITICAL: Sync state.currentTile with entity's actual position
    // The state might be stale if the player has been moving (zero allocation)
    worldToTileInto(
      entity.position.x,
      entity.position.z,
      this._actualEntityTile,
    );
    if (!tilesEqual(state.currentTile, this._actualEntityTile)) {
      state.currentTile.x = this._actualEntityTile.x;
      state.currentTile.z = this._actualEntityTile.z;
    }

    // Convert target to tile (zero allocation)
    worldToTileInto(targetPosition.x, targetPosition.z, this._targetTile);
    const normalizedInteractionArrival =
      attackRange === 0
        ? this.normalizeInteractionArrival(interactionArrival)
        : null;
    const previousInteractionArrival = state.requestedInteractionArrival;
    const sameInteractionArrival =
      previousInteractionArrival === null
        ? normalizedInteractionArrival === null
        : normalizedInteractionArrival !== null &&
          previousInteractionArrival.interactionRange ===
            normalizedInteractionArrival.interactionRange &&
          previousInteractionArrival.footprintWidth ===
            normalizedInteractionArrival.footprintWidth &&
          previousInteractionArrival.footprintDepth ===
            normalizedInteractionArrival.footprintDepth;

    // The behavior planner may restate the same destination while a segmented
    // route is active. Preserve its server/client look-ahead segment so the
    // planning cadence cannot introduce an avoidable stop at the boundary.
    if (
      attackRange === 0 &&
      state.requestedDestination?.x === this._targetTile.x &&
      state.requestedDestination.z === this._targetTile.z &&
      sameInteractionArrival &&
      state.isRunning === running &&
      this.isMoving(playerId)
    ) {
      return true;
    }

    this._pendingObstructionReplans.delete(playerId);
    this._pendingNonCombatMoves.delete(playerId);
    this._precomputedPathSegments.delete(playerId);
    this._interactionApproachReservations.delete(playerId);
    state.nextSegmentPrecomputed = false;

    // Determine current floor index for floor-aware pathfinding
    const buildingService = this.getBuildingCollision();
    const currentFloor = buildingService
      ? buildingService.getPlayerFloor(playerId as EntityID)
      : 0;

    // Stuck-on-unwalkable recovery: if the agent's current tile is unwalkable
    // (e.g., spawned on water/slope), find the nearest walkable tile and teleport there.
    // Runs for all embedded agents to prevent them from being permanently stuck.
    const isEmbeddedAgent =
      entity.data &&
      (entity.data as Record<string, unknown>).isEmbeddedAgent === true;
    if (isEmbeddedAgent) {
      const startWalkable = this.isTileWalkable(
        state.currentTile,
        currentFloor,
      );
      if (!startWalkable) {
        const nearestWalkable = this.findClosestWalkableTile(
          { x: entity.position.x, z: entity.position.z },
          15,
          (tile) =>
            this.getEntityOccupancy()?.isOccupied(
              tile,
              playerId as EntityID,
            ) !== true,
        );
        if (nearestWalkable) {
          tileToWorldInto(nearestWalkable, this._worldPos);
          const wy = entity.position.y;
          entity.position.set(this._worldPos.x, wy, this._worldPos.z);
          (entity.data as Record<string, unknown>).position = [
            this._worldPos.x,
            wy,
            this._worldPos.z,
          ];
          this.getEntityOccupancy()?.vacate(playerId as EntityID);
          state.currentTile.x = nearestWalkable.x;
          state.currentTile.z = nearestWalkable.z;
          this.ensurePlayerOccupancy(playerId, state.currentTile);
          console.warn(
            `[TileMov-UNSTUCK] ${playerId.slice(-8)} teleported from unwalkable (${this._actualEntityTile.x},${this._actualEntityTile.z}) to (${nearestWalkable.x},${nearestWalkable.z})`,
          );
        }
      }
    }

    const currentBuildingId = buildingService
      ? buildingService.getBuildingAt(state.currentTile.x, state.currentTile.z)
      : null;
    let path: TileCoord[];

    if (attackRange > 0) {
      // COMBAT MOVEMENT: Multi-destination BFS to ANY valid combat tile

      // Check if already in valid position
      const alreadyInRange =
        attackType === AttackType.MELEE
          ? tilesWithinMeleeRange(
              state.currentTile,
              this._targetTile,
              attackRange,
            )
          : tilesWithinRange(state.currentTile, this._targetTile, attackRange);

      if (alreadyInRange) {
        // For ranged/magic: also verify LoS before considering "in position"
        if (
          attackType === AttackType.MELEE ||
          this.tileHasLineOfSight(state.currentTile, this._targetTile)
        ) {
          // A target can move while an older combat-follow path is active. If
          // that movement puts the actor in a valid attack tile, retire the
          // stale path immediately so the next interpolation step cannot carry
          // the actor past the cardinal/ranged engagement boundary.
          if (this.isMoving(playerId)) {
            this.stopPlayer(playerId);
          }
          return true; // Already in valid combat position
        }
      }

      // BFS iteration budget check — skip pathfinding this tick, manager retries next tick
      if (
        this._bfsIterationsThisTick >=
        TileMovementManager.MAX_BFS_ITERATIONS_PER_TICK
      ) {
        return false;
      }

      // Generate ALL valid destination tiles
      let validTiles: TileCoord[];
      if (attackType === AttackType.RANGED || attackType === AttackType.MAGIC) {
        validTiles = getValidRangedTiles(
          this._targetTile,
          attackRange,
          (tile) =>
            this.isTileTraversableForPlayer(
              playerId,
              tile,
              currentFloor,
              undefined,
              currentBuildingId,
            ),
          (x, z) =>
            this.world.collision.hasFlags(x, z, CollisionMask.BLOCKS_RANGED),
        );
      } else {
        validTiles = getValidMeleeTiles(this._targetTile, attackRange, (tile) =>
          this.isTileTraversableForPlayer(
            playerId,
            tile,
            currentFloor,
            undefined,
            currentBuildingId,
          ),
        );
      }

      if (validTiles.length === 0) {
        return false; // No valid combat position found
      }

      // Multi-destination BFS: finds shortest path to ANY valid tile
      const remainingBudget =
        TileMovementManager.MAX_BFS_ITERATIONS_PER_TICK -
        this._bfsIterationsThisTick;
      path = this.pathfinder.findPathToAny(
        state.currentTile,
        validTiles,
        (tile: TileCoord, fromTile?: TileCoord) =>
          this.isTileTraversableForPlayer(
            playerId,
            tile,
            currentFloor,
            fromTile,
            currentBuildingId,
          ),
        remainingBudget,
      );
      this._bfsIterationsThisTick += this.pathfinder.getLastIterationsUsed();
    } else {
      // NON-COMBAT MOVEMENT: either reach the exact target tile or any legal
      // tile in the exact interaction boundary around a blocked footprint.
      const alreadyAtDestination = normalizedInteractionArrival
        ? this.isTileWithinInteractionArrival(
            state.currentTile,
            this._targetTile,
            normalizedInteractionArrival,
          )
        : tilesEqual(this._targetTile, state.currentTile);
      if (alreadyAtDestination) {
        if (this.isMoving(playerId)) this.stopPlayer(playerId);
        state.requestedDestination = null;
        state.requestedInteractionArrival = null;
        this._interactionApproachReservations.delete(playerId);
        return true;
      }

      // Retain the latest non-combat intent when the shared budget is exhausted;
      // the movement tick retries it instead of waiting for another agent plan.
      if (
        this._bfsIterationsThisTick >=
        TileMovementManager.MAX_BFS_ITERATIONS_PER_TICK
      ) {
        this.queueNonCombatMove(
          playerId,
          this._targetTile,
          running,
          normalizedInteractionArrival,
        );
        return true;
      }

      // Calculate BFS path to the target tile
      const remainingBudget =
        TileMovementManager.MAX_BFS_ITERATIONS_PER_TICK -
        this._bfsIterationsThisTick;
      path = this.findNonCombatPath(
        playerId,
        state.currentTile,
        this._targetTile,
        normalizedInteractionArrival,
        currentFloor,
        currentBuildingId,
        remainingBudget,
      );
      this._bfsIterationsThisTick += this.pathfinder.getLastIterationsUsed();
    }

    if (path.length === 0) {
      if (normalizedInteractionArrival) {
        this.queueNonCombatMove(
          playerId,
          this._targetTile,
          running,
          normalizedInteractionArrival,
        );
        return true;
      }
      return false; // No path found
    }

    // Resolve contestant path conflicts before tileMovementStart reaches the
    // renderer. Waiting until the next 600ms movement tick is too late: both
    // clients have already begun interpolating through the crossing segments.
    if (
      !this.resolveStreamingDuelPathInstallation(playerId, state, path, running)
    ) {
      return false;
    }

    // If we're already following the same remaining path at the same speed,
    // keep the existing movement state to avoid moveSeq churn and visual jitter.
    const remainingPathLength = state.path.length - state.pathIndex;
    if (remainingPathLength === path.length && state.isRunning === running) {
      let samePath = true;
      for (let i = 0; i < path.length; i++) {
        const existingTile = state.path[state.pathIndex + i];
        const nextTile = path[i];
        if (
          !existingTile ||
          existingTile.x !== nextTile.x ||
          existingTile.z !== nextTile.z
        ) {
          samePath = false;
          break;
        }
      }
      if (samePath) {
        state.lastPathPartial = this.pathfinder.wasLastPathPartial();
        state.requestedDestination =
          attackRange === 0
            ? { x: this._targetTile.x, z: this._targetTile.z }
            : null;
        state.requestedInteractionArrival =
          attackRange === 0 ? normalizedInteractionArrival : null;
        return true;
      }
    }

    // Update state
    state.path = path;
    state.pathIndex = 0;
    state.isRunning = running;
    state.moveSeq = (state.moveSeq || 0) + 1;
    state.lastPathPartial = this.pathfinder.wasLastPathPartial();
    state.requestedDestination =
      attackRange === 0
        ? { x: this._targetTile.x, z: this._targetTile.z }
        : null;
    state.requestedInteractionArrival =
      attackRange === 0 ? normalizedInteractionArrival : null;
    state.nextSegmentPrecomputed = false;

    // modern MMORPG-style: Set movement flag to suppress combat while moving
    entity.data.tileMovementActive = true;

    // Broadcast movement start
    const nextTile = path[0];
    const nextWorld = tileToWorld(nextTile);
    const curr = entity.position;
    const dx = nextWorld.x - curr.x;
    const dz = nextWorld.z - curr.z;

    // Calculate rotation to face movement direction
    if (Math.abs(dx) + Math.abs(dz) > 0.01) {
      const yaw = Math.atan2(-dx, -dz);
      this._tempQuat.setFromAxisAngle(this._up, yaw);

      if (
        (entity as { node?: { quaternion: { copy: (q: unknown) => void } } })
          .node
      ) {
        (
          entity as { node: { quaternion: { copy: (q: unknown) => void } } }
        ).node.quaternion.copy(this._tempQuat);
      }
      (entity as { data: { quaternion?: number[] } }).data.quaternion = [
        this._tempQuat.x,
        this._tempQuat.y,
        this._tempQuat.z,
        this._tempQuat.w,
      ];
    }

    // Send movement start packet
    const actualDestination = path[path.length - 1];

    // Zero-allocation: copy path to pre-allocated network buffer
    this._networkPathBuffer.length = path.length;
    for (let i = 0; i < path.length; i++) {
      if (!this._networkPathBuffer[i]) {
        this._networkPathBuffer[i] = { x: 0, z: 0 };
      }
      this._networkPathBuffer[i].x = path[i].x;
      this._networkPathBuffer[i].z = path[i].z;
    }

    this.sendFn("tileMovementStart", {
      id: playerId,
      startTile: { x: state.currentTile.x, z: state.currentTile.z },
      path: this._networkPathBuffer,
      running: state.isRunning,
      destinationTile: { x: actualDestination.x, z: actualDestination.z },
      moveSeq: state.moveSeq,
      emote: state.isRunning ? "run" : "walk",
    });
    return true;
  }

  /**
   * Check line of sight between two tiles for ranged/magic combat.
   * Uses BLOCKS_RANGED collision mask (BLOCK_LOS | BLOCKED).
   */
  private tileHasLineOfSight(from: TileCoord, to: TileCoord): boolean {
    return hasLineOfSight(from, to, (x, z) =>
      this.world.collision.hasFlags(x, z, CollisionMask.BLOCKS_RANGED),
    );
  }
}
