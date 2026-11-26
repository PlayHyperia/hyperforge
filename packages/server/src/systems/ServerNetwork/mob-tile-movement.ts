/**
 * Mob Tile Movement Manager
 *
 * classic fantasy MMORPG-style tile-based movement system for mobs.
 * Mobs move discretely from tile to tile on server ticks (600ms).
 *
 * Key behaviors:
 * - Movement happens on ticks, not frames
 * - Mobs move 1-2 tiles per tick (based on mob speed)
 * - Uses greedy/direct pathfinding (chaseStep), NOT BFS
 * - Mobs walk directly toward target, getting stuck behind obstacles
 * - This enables "safespotting" gameplay (authentic classic MMORPG behavior)
 * - Client interpolates visually between tile positions
 *
 * classic MMORPG Reference:
 * - Mobs use "dumb" pathfinding - they don't navigate around obstacles
 * - This is why safespotting works in classic MMORPG
 */

import {
  THREE,
  TerrainSystem,
  TownSystem,
  World,
  TILES_PER_TICK_WALK,
  worldToTile,
  worldToTileInto,
  tileToWorld,
  tileToWorldInto,
  tilesEqual,
  tilesWithinMeleeRange,
  tileChebyshevDistance,
  chaseStep,
  getChasePathfinder,
  MobEntity,
  getBestUnoccupiedMeleeTile,
  tileKey,
  // Collision system
  CollisionMask,
} from "@hyperforge/shared";
import type {
  TileCoord,
  TileMovementState,
  Position3D,
  EntityID,
} from "@hyperforge/shared";

/**
 * Extended movement state for mobs
 * Includes mob-specific fields like target entity tracking
 */
interface MobTileState extends TileMovementState {
  /** Target entity ID (for CHASE state - uses dumb pathfinder every tick) */
  targetEntityId: string | null;
  /** Last known target position (to detect when target moved) */
  lastTargetTile: TileCoord | null;
  /** Movement speed in tiles per tick (default: 2 for walk) */
  tilesPerTick: number;
  /** Whether mob is currently chasing/moving to a destination */
  hasDestination: boolean;
  /** Whether mob is actively chasing a moving target (uses dumb pathfinder) */
  isChasing: boolean;
  /** Combat range in tiles (from manifest combatRange, default 1 for melee) */
  combatRange: number;
}

/**
 * Create initial mob tile state
 */
function createMobTileState(
  currentTile: TileCoord,
  tilesPerTick = TILES_PER_TICK_WALK,
  combatRange = 1,
): MobTileState {
  return {
    currentTile: { ...currentTile },
    previousTile: null,
    path: [],
    pathIndex: 0,
    isRunning: false,
    moveSeq: 0,
    targetEntityId: null,
    lastTargetTile: null,
    tilesPerTick,
    hasDestination: false,
    isChasing: false,
    combatRange,
    // Required by TileMovementState base interface
    requestedDestination: null,
    requestedInteractionArrival: null,
    lastPathPartial: false,
    nextSegmentPrecomputed: false,
  };
}

/**
 * Tile-based movement manager for mobs (classic fantasy MMORPG-style)
 *
 * IMPORTANT: Mobs use greedy/direct pathfinding (chaseStep), NOT BFS.
 * This is authentic classic MMORPG behavior - mobs walk directly toward their target
 * and get stuck behind obstacles (enabling safespotting gameplay).
 */
export class MobTileMovementManager {
  private mobStates: Map<string, MobTileState> = new Map();
  // Y-axis for stable yaw rotation calculation
  private _up = new THREE.Vector3(0, 1, 0);
  private _tempQuat = new THREE.Quaternion();
  // Debug mode - set to true for verbose logging (disabled in production)
  private readonly DEBUG_MODE = false;

  // Cached reference to TownSystem for building collision
  private _townSystem: InstanceType<typeof TownSystem> | null = null;
  private _townSystemChecked = false;

  // ============================================================================
  // PRE-ALLOCATED BUFFERS (Zero-allocation hot path support)
  // ============================================================================

  /** Zero-allocation chase pathfinder */
  private readonly _chasePathfinder = getChasePathfinder();

  /** Reusable tile for current position during path calculation */
  private readonly _currentPosTile: TileCoord = { x: 0, z: 0 };

  /** Reusable tile for target position */
  private readonly _targetTile: TileCoord = { x: 0, z: 0 };

  /** Reusable world position for terrain walkability checks. */
  private readonly _walkableWorldPos: Position3D = { x: 0, y: 0, z: 0 };

  /**
   * Static walkability is stable within one authoritative tick. AI and movement
   * frequently inspect the same candidate tile more than once, and an uncached
   * terrain check expands into biome, water, slope, and procedural-height work.
   */
  private readonly _walkabilityCache = new Map<number, boolean>();
  private _walkabilityCacheTick = -1;

  /** Reusable tile for actual entity position */
  private readonly _actualTile: TileCoord = { x: 0, z: 0 };

  /** Pre-allocated path buffer (max 4 tiles per tick for running speed) */
  private readonly _pathBuffer: TileCoord[] = [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ];

  /** Pre-allocated network path buffer for sending to clients */
  private readonly _networkPathBuffer: Array<{ x: number; z: number }> = [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ];

  /** Reusable tile coordinate for previous position in processMobTick */
  private readonly _prevTileMob: TileCoord = { x: 0, z: 0 };

  /** Reusable tile coordinate for current target tile in processMobTick */
  private readonly _currentTargetTileMob: TileCoord = { x: 0, z: 0 };

  /** Reusable tile coordinate for spawn point in processMobTick */
  private readonly _spawnTileMob: TileCoord = { x: 0, z: 0 };

  /** Reusable tile for last target tile update */
  private readonly _lastTargetTileMob: TileCoord = { x: 0, z: 0 };

  /** Reusable tile for target occupied tile in onTick collision check */
  private readonly _targetOccupiedTile: TileCoord = { x: 0, z: 0 };

  /** Pre-allocated position for closure capture in chase path calculation (avoids per-step allocation) */
  private readonly _closurePos: TileCoord = { x: 0, z: 0 };

  /**
   * Destination claims for current tick (prevents multiple mobs targeting same tile)
   *
   * When a mob selects a melee tile as its destination, it's added here.
   * Other mobs in the same tick will see it as "claimed" and pick a different tile.
   * Cleared at the start of each onTick() call.
   */
  private readonly _claimedDestinations: Set<string> = new Set();

  constructor(
    private world: World,
    private sendFn: (
      name: string,
      data: unknown,
      ignoreSocketId?: string,
    ) => void,
  ) {}

  /**
   * Get terrain system
   */
  private getTerrain(): InstanceType<typeof TerrainSystem> | null {
    return this.world.getSystem("terrain") as InstanceType<
      typeof TerrainSystem
    > | null;
  }

  /**
   * Get TownSystem for building collision (cached lazy lookup)
   * Re-checks if no buildings are registered to handle async initialization
   */
  private get townSystem(): InstanceType<typeof TownSystem> | null {
    if (
      !this._townSystemChecked ||
      (this._townSystem &&
        this._townSystem.getCollisionService().getBuildingCount() === 0)
    ) {
      this._townSystem = this.world.getSystem?.("towns") as InstanceType<
        typeof TownSystem
      > | null;

      if (this._townSystem) {
        const buildingCount = this._townSystem
          .getCollisionService()
          .getBuildingCount();
        if (buildingCount > 0) {
          this._townSystemChecked = true;
        }
      } else {
        this._townSystemChecked = true;
      }
    }
    return this._townSystem;
  }

  /**
   * Check if a tile is walkable based on collision and terrain constraints
   * Checks CollisionMatrix for static objects (trees, rocks, stations),
   * building collision (walls), and TerrainSystem for water level, slope, and biome rules
   *
   * @param tile - Target tile to check
   * @param fromTile - Optional source tile for directional wall checks
   */
  private isTileWalkable(tile: TileCoord, fromTile?: TileCoord): boolean {
    const currentTick = this.world.currentTick;
    if (currentTick !== this._walkabilityCacheTick) {
      this._walkabilityCache.clear();
      this._walkabilityCacheTick = currentTick;
    }

    const towns = this.townSystem;

    // FIRST: Check wall blocking between tiles (handles building walls)
    // This MUST be checked regardless of whether tiles are inside/outside buildings
    if (fromTile && towns) {
      // Check building wall blocking (handles entry, exit, and internal movement)
      if (
        towns.isBuildingWallBlocked(fromTile.x, fromTile.z, tile.x, tile.z, 0)
      ) {
        return false;
      }

      // Also check CollisionMatrix directional walls (for non-building obstacles)
      if (
        this.world.collision.isBlocked(fromTile.x, fromTile.z, tile.x, tile.z)
      ) {
        return false;
      }
    }

    // SECOND: Check if target tile is inside a building
    const walkabilityKey =
      ((tile.x + 1048576) | 0) * 2097152 + ((tile.z + 1048576) | 0);
    const cachedWalkability = this._walkabilityCache.get(walkabilityKey);
    if (cachedWalkability !== undefined) {
      return cachedWalkability;
    }

    if (towns) {
      const collisionService = towns.getCollisionService();
      const buildingResult = collisionService.queryCollision(tile.x, tile.z, 0);

      if (buildingResult.isInsideBuilding) {
        // Check if this tile is walkable at ground floor (mobs stay on ground)
        if (!buildingResult.isWalkable) {
          this._walkabilityCache.set(walkabilityKey, false);
          return false;
        }
        // Building floor is walkable - skip terrain checks
        this._walkabilityCache.set(walkabilityKey, true);
        return true;
      }
    }

    // THIRD: Check CollisionMatrix for static objects (trees, rocks, furnaces, etc.)
    // BLOCKS_WALK includes BLOCKED, WATER, STEEP_SLOPE - excludes OCCUPIED
    // (mobs should be able to path through other entities for pathfinding)
    if (
      this.world.collision.hasFlags(tile.x, tile.z, CollisionMask.BLOCKS_WALK)
    ) {
      this._walkabilityCache.set(walkabilityKey, false);
      return false;
    }

    const terrain = this.getTerrain();
    if (!terrain) {
      // Fallback: walkable if no terrain system available
      this._walkabilityCache.set(walkabilityKey, true);
      return true;
    }

    // Convert tile to world coordinates (center of tile)
    tileToWorldInto(tile, this._walkableWorldPos);

    // Generated terrain tiles synchronously bake WATER and STEEP_SLOPE into
    // CollisionMatrix. The blocking flags were checked above, so their absence
    // is an authoritative walkable result and avoids procedural height noise.
    if (
      terrain.hasBakedWalkabilityAt(
        this._walkableWorldPos.x,
        this._walkableWorldPos.z,
      )
    ) {
      this._walkabilityCache.set(walkabilityKey, true);
      return true;
    }

    // Mobs must not move into terrain that spectators/players have not loaded.
    // Fail closed until the tile is generated and its authoritative collision
    // bake is present instead of running procedural terrain work on the tick.
    this._walkabilityCache.set(walkabilityKey, false);
    return false;
  }

  /**
   * Get or create movement state for a mob
   */
  private getOrCreateState(
    mobId: string,
    currentPos?: Position3D,
  ): MobTileState {
    let state = this.mobStates.get(mobId);
    if (!state) {
      // Get current position and convert to tile
      const entity = this.world.entities.get(mobId);
      const pos = currentPos || entity?.position;
      const currentTile: TileCoord = pos
        ? worldToTile(pos.x, pos.z)
        : { x: 0, z: 0 };

      state = createMobTileState(currentTile);
      this.mobStates.set(mobId, state);
    }
    return state;
  }

  /**
   * Request movement to a target position
   * Called by MobEntity when AI wants to move
   *
   * IMPORTANT: Mobs use greedy/direct pathfinding (chaseStep), NOT BFS.
   * This is authentic classic MMORPG behavior - mobs walk directly toward their target
   * and get stuck behind obstacles (enabling safespotting gameplay).
   *
   * @param mobId - The mob's entity ID
   * @param targetPos - Target world position
   * @param targetEntityId - Optional entity ID being chased (for dynamic repathing)
   * @param tilesPerTick - Movement speed (default: walk speed)
   * @param combatRange - Combat range in tiles (default: 1 for melee)
   */
  requestMoveTo(
    mobId: string,
    targetPos: Position3D,
    targetEntityId: string | null = null,
    tilesPerTick: number = TILES_PER_TICK_WALK,
    combatRange: number = 1,
  ): void {
    const entity = this.world.entities.get(mobId);
    if (!entity) {
      if (this.DEBUG_MODE)
        console.log(
          `[MobTileMovement] requestMoveTo: Entity ${mobId} not found`,
        );
      return;
    }

    const state = this.getOrCreateState(mobId, entity.position);
    const targetTile = worldToTile(targetPos.x, targetPos.z);

    if (this.DEBUG_MODE)
      console.log(
        `[MobTileMovement] requestMoveTo: ${mobId} from tile (${state.currentTile.x},${state.currentTile.z}) to tile (${targetTile.x},${targetTile.z})`,
      );

    // Store combat range for this mob
    state.combatRange = combatRange;

    // If already at destination, nothing to do (but still update chase state)
    if (tilesEqual(state.currentTile, targetTile)) {
      if (this.DEBUG_MODE)
        console.log(`[MobTileMovement] requestMoveTo: Already at destination`);
      // Still update chase state so combat system knows who we're targeting
      state.targetEntityId = targetEntityId;
      state.isChasing = !!targetEntityId;
      state.hasDestination = false;
      state.path.length = 0; // Zero-allocation clear
      state.pathIndex = 0;
      return;
    }

    // If chasing an entity and already within combat range - stop moving
    // (Only for combat - when returning to spawn, we want the exact tile)
    // rules-accurate: Range 1 = cardinal only (N/S/E/W), range 2+ = diagonal allowed
    if (
      targetEntityId !== null &&
      tilesWithinMeleeRange(state.currentTile, targetTile, combatRange)
    ) {
      if (this.DEBUG_MODE)
        console.log(
          `[MobTileMovement] requestMoveTo: Already in combat range (${combatRange}) of target entity`,
        );
      // Update chase state so combat system knows who we're targeting
      state.targetEntityId = targetEntityId;
      state.isChasing = true;
      state.hasDestination = false;
      state.path.length = 0; // Zero-allocation clear
      state.pathIndex = 0;
      return;
    }

    // If already chasing this same entity, let onTick handle continued movement
    if (
      state.isChasing &&
      state.targetEntityId === targetEntityId &&
      targetEntityId !== null
    ) {
      if (this.DEBUG_MODE)
        console.log(
          `[MobTileMovement] requestMoveTo: Already chasing ${targetEntityId}, onTick handles`,
        );
      state.tilesPerTick = tilesPerTick;
      return;
    }

    // Set up chase state - onTick will use chaseStep for actual movement
    state.targetEntityId = targetEntityId;
    // Zero-allocation: reuse or create lastTargetTile
    if (!state.lastTargetTile) {
      state.lastTargetTile = { x: 0, z: 0 };
    }
    state.lastTargetTile.x = targetTile.x;
    state.lastTargetTile.z = targetTile.z;
    state.tilesPerTick = tilesPerTick;
    state.isChasing = !!targetEntityId;
    state.hasDestination = true;
    state.moveSeq = (state.moveSeq || 0) + 1;

    // Calculate initial chase path using chaseStep (NOT BFS!)
    // Zero-allocation: use pre-allocated _pathBuffer instead of creating new array
    let chasePathLength = 0;
    // Zero-allocation: use pre-allocated buffer for current position iteration
    this._currentPosTile.x = state.currentTile.x;
    this._currentPosTile.z = state.currentTile.z;

    // RULES-ACCURATE LEASH RANGE CAP: Get spawn point and leash range
    // Mobs cannot move beyond leashRange from their spawn point
    const mobEntity = entity instanceof MobEntity ? entity : null;
    const spawnPoint = mobEntity?.getSpawnPoint();
    const leashRange = mobEntity?.getLeashRange() ?? 10;
    const spawnTile = spawnPoint
      ? worldToTile(spawnPoint.x, spawnPoint.z)
      : null;

    for (let step = 0; step < tilesPerTick; step++) {
      // Zero-allocation: copy to pre-allocated closure position buffer
      this._closurePos.x = this._currentPosTile.x;
      this._closurePos.z = this._currentPosTile.z;
      const nextTile = chaseStep(this._currentPosTile, targetTile, (tile) =>
        this.isTileWalkable(tile, this._closurePos),
      );

      if (!nextTile) break; // Blocked

      // RULES-ACCURATE: Check if this step would exceed leash range from spawn
      // If so, stop at current position (mob lingers at edge)
      if (spawnTile) {
        const nextDistFromSpawn = tileChebyshevDistance(nextTile, spawnTile);
        if (nextDistFromSpawn > leashRange) {
          break; // Would exceed leash range - stop at edge
        }
      }

      // Zero-allocation: copy to pre-allocated path buffer
      this._pathBuffer[chasePathLength].x = nextTile.x;
      this._pathBuffer[chasePathLength].z = nextTile.z;
      chasePathLength++;
      // Zero-allocation: update pre-allocated tile instead of reassigning
      this._currentPosTile.x = nextTile.x;
      this._currentPosTile.z = nextTile.z;

      // Stop if we'll be in combat range after this step (classic MMORPG melee rules)
      if (tilesWithinMeleeRange(nextTile, targetTile, combatRange)) break;
    }

    if (chasePathLength === 0) {
      // Completely blocked from the start
      if (this.DEBUG_MODE)
        console.log(`[MobTileMovement] requestMoveTo: Blocked, can't move`);
      state.hasDestination = false;
      return;
    }

    // Zero-allocation: copy from buffer to state.path
    state.path.length = chasePathLength;
    for (let i = 0; i < chasePathLength; i++) {
      if (!state.path[i]) {
        state.path[i] = { x: 0, z: 0 };
      }
      state.path[i].x = this._pathBuffer[i].x;
      state.path[i].z = this._pathBuffer[i].z;
    }
    state.pathIndex = 0;

    if (this.DEBUG_MODE)
      console.log(
        `[MobTileMovement] requestMoveTo: Chase path ${chasePathLength} steps`,
      );

    // Rotate mob toward first tile
    const nextTile = state.path[0];
    const nextWorld = tileToWorld(nextTile);
    const curr = entity.position;
    const dx = nextWorld.x - curr.x;
    const dz = nextWorld.z - curr.z;

    if (Math.abs(dx) + Math.abs(dz) > 0.01) {
      const yaw = Math.atan2(-dx, -dz);
      this._tempQuat.setFromAxisAngle(this._up, yaw);

      if (entity.node) {
        entity.node.quaternion.copy(this._tempQuat);
      }
      if (entity.data) {
        entity.data.quaternion = [
          this._tempQuat.x,
          this._tempQuat.y,
          this._tempQuat.z,
          this._tempQuat.w,
        ];
      }
    }

    // Broadcast movement started
    // Server sends COMPLETE authoritative path - client follows exactly, no recalculation
    // startTile: where server knows mob IS
    // classic MMORPG-style: Bundle emote with movement packet to prevent animation mismatch

    // Zero-allocation: copy path to pre-allocated network buffer
    this._networkPathBuffer.length = state.path.length;
    for (let i = 0; i < state.path.length; i++) {
      if (!this._networkPathBuffer[i]) {
        this._networkPathBuffer[i] = { x: 0, z: 0 };
      }
      this._networkPathBuffer[i].x = state.path[i].x;
      this._networkPathBuffer[i].z = state.path[i].z;
    }

    this.sendFn("tileMovementStart", {
      id: mobId,
      startTile: { x: state.currentTile.x, z: state.currentTile.z },
      path: this._networkPathBuffer,
      running: state.isRunning,
      destinationTile: { x: targetTile.x, z: targetTile.z },
      moveSeq: state.moveSeq,
      isMob: true,
      emote: state.isRunning ? "run" : "walk",
      tilesPerTick: state.tilesPerTick, // Mob-specific speed for client interpolation
    });
  }

  /**
   * Cancel current movement for a mob
   */
  cancelMovement(mobId: string): void {
    const state = this.mobStates.get(mobId);
    if (!state) return;

    state.path.length = 0; // Zero-allocation clear
    state.pathIndex = 0;
    state.targetEntityId = null;
    state.lastTargetTile = null;
    state.hasDestination = false;
    state.isChasing = false;

    // Send tileMovementEnd so client TileInterpolator stops interpolating
    // along the old path and snaps to current position.
    // Previously sent entityModified which was stripped by PacketHandlers
    // for tile-controlled entities, leaving TileInterpolator out of sync.
    const worldPos = tileToWorld(state.currentTile);
    this.sendFn("tileMovementEnd", {
      id: mobId,
      tile: state.currentTile,
      worldPos: [worldPos.x, worldPos.y, worldPos.z],
      moveSeq: state.moveSeq,
      isMob: true,
      emote: "idle",
    });
  }

  /**
   * Called every server tick (600ms) - advance all mobs along their paths
   */
  onTick(tickNumber: number): void {
    const terrain = this.getTerrain();

    // Clear destination claims from previous tick
    // This prevents mobs from claiming the same melee tile in the same tick
    this._claimedDestinations.clear();

    if (this.DEBUG_MODE && this.mobStates.size > 0) {
      // Log occupancy stats at tick start
      const stats = this.world.entityOccupancy.getStats();
      console.log(
        `[MobTileMovement] onTick #${tickNumber}: Processing ${this.mobStates.size} mobs, occupancy: ${stats.occupiedTileCount} tiles, ${stats.trackedEntityCount} entities`,
      );
    }

    for (const [mobId, state] of this.mobStates) {
      const entity = this.world.entities.get(mobId);
      if (!entity) {
        // Mob no longer exists, clean up
        if (this.DEBUG_MODE)
          console.log(
            `[MobTileMovement] onTick: Mob ${mobId} no longer exists, cleaning up`,
          );
        this.mobStates.delete(mobId);
        continue;
      }

      if (this.DEBUG_MODE) {
        // Log mob's actual position vs state position (zero-allocation)
        worldToTileInto(entity.position.x, entity.position.z, this._actualTile);
        const tileMatch =
          this._actualTile.x === state.currentTile.x &&
          this._actualTile.z === state.currentTile.z;
        console.log(
          `[MobTileMovement] onTick: Mob ${mobId} - stateTile=(${state.currentTile.x},${state.currentTile.z}), actualTile=(${this._actualTile.x},${this._actualTile.z}), match=${tileMatch}, hasDestination=${state.hasDestination}, isChasing=${state.isChasing}`,
        );
      }

      // classic MMORPG-STYLE DUMB PATHFINDER FOR CHASE MODE
      // Instead of expensive BFS repathing every tick, NPCs use a simple algorithm:
      // 1. Try diagonal step toward target
      // 2. Try cardinal steps (prioritize axis with greater distance)
      // 3. If all blocked = NPC is "stuck" (safespotting!)
      //
      // This is O(1) per step, so no throttling is needed.
      if (state.isChasing && state.targetEntityId) {
        // CRITICAL: Players are NOT in world.entities - they're accessed via world.getPlayer()
        // Mobs are in world.entities, but when chasing we're always targeting players
        const targetPlayer = this.world.getPlayer?.(state.targetEntityId);
        const targetEntity =
          targetPlayer || this.world.entities.get(state.targetEntityId);
        if (targetEntity) {
          // Zero-allocation: use pre-allocated buffer for target tile
          worldToTileInto(
            targetEntity.position.x,
            targetEntity.position.z,
            this._targetTile,
          );

          // classic MMORPG COMBAT POSITIONING: Check if we're already in combat range
          // If so, we're in attack range - no need to move closer!
          // rules-accurate: Range 1 = cardinal only (N/S/E/W), range 2+ = diagonal allowed
          const combatRange = state.combatRange || 1;
          if (
            tilesWithinMeleeRange(
              state.currentTile,
              this._targetTile,
              combatRange,
            )
          ) {
            // Already in combat range - stop moving and clear path
            if (this.DEBUG_MODE)
              console.log(
                `[MobTileMovement] IN RANGE: Mob ${mobId} at (${state.currentTile.x},${state.currentTile.z}) is in combat range (${combatRange}) of target at (${this._targetTile.x},${this._targetTile.z}), skipping movement`,
              );
            if (state.path.length > 0 || state.hasDestination) {
              state.path.length = 0; // Zero-allocation clear
              state.pathIndex = 0;
              state.hasDestination = false;

              // Broadcast that we've stopped
              this.sendFn("tileMovementEnd", {
                id: mobId,
                tile: state.currentTile,
                worldPos: [
                  entity.position.x,
                  entity.position.y,
                  entity.position.z,
                ],
                moveSeq: state.moveSeq,
                isMob: true,
              });
            }
            continue; // Skip movement processing - we're in attack range
          }

          // NOT in combat range - find best unoccupied melee tile and path toward it
          // This prevents all mobs from trying to reach the same tile around the player
          // Also check claimed destinations to prevent multiple mobs targeting same tile in same tick
          const destinationTile = getBestUnoccupiedMeleeTile(
            state.currentTile,
            this._targetTile,
            this.world.entityOccupancy,
            mobId as EntityID,
            (tile) =>
              this.isTileWalkable(tile) &&
              !this._claimedDestinations.has(tileKey(tile)),
            combatRange,
          );

          // If no unoccupied melee tile available, wait (creates queuing behavior)
          if (!destinationTile) {
            if (this.DEBUG_MODE)
              console.log(
                `[MobTileMovement] WAIT: Mob ${mobId} at (${state.currentTile.x},${state.currentTile.z}) - all melee tiles around target (${this._targetTile.x},${this._targetTile.z}) are occupied or claimed, waiting`,
              );
            state.path.length = 0; // Zero-allocation clear
            state.pathIndex = 0;
            state.hasDestination = false;
            continue; // Skip movement - wait for a tile to open up
          }

          // Claim this destination so other mobs in this tick won't target it
          this._claimedDestinations.add(tileKey(destinationTile));

          if (this.DEBUG_MODE)
            console.log(
              `[MobTileMovement] DESTINATION: Mob ${mobId} targeting unoccupied melee tile (${destinationTile.x},${destinationTile.z}) around player at (${this._targetTile.x},${this._targetTile.z})`,
            );

          // Calculate up to tilesPerTick steps toward the unoccupied melee tile
          // Zero-allocation: use pre-allocated currentPos tile and ChasePathfinder
          let pathLength = 0;
          this._currentPosTile.x = state.currentTile.x;
          this._currentPosTile.z = state.currentTile.z;

          // RULES-ACCURATE LEASH RANGE CAP: Get spawn point and leash range
          // Mobs cannot move beyond leashRange from their spawn point
          const mobEntity = entity instanceof MobEntity ? entity : null;
          const spawnPoint = mobEntity?.getSpawnPoint();
          const leashRange = mobEntity?.getLeashRange() ?? 10;
          // Zero-allocation: use pre-allocated spawn tile buffer
          let hasSpawnTile = false;
          if (spawnPoint) {
            worldToTileInto(spawnPoint.x, spawnPoint.z, this._spawnTileMob);
            hasSpawnTile = true;
          }

          for (let step = 0; step < state.tilesPerTick; step++) {
            // Check if this step would put us in combat range (path toward destination tile, not player)
            // Zero-allocation: copy to pre-allocated closure position buffer
            this._closurePos.x = this._currentPosTile.x;
            this._closurePos.z = this._currentPosTile.z;
            const nextTile = this._chasePathfinder.chaseStep(
              this._currentPosTile,
              destinationTile,
              (tile) => this.isTileWalkable(tile, this._closurePos),
            );

            if (!nextTile) {
              // Blocked - stop here (safespotting!)
              break;
            }

            // RULES-ACCURATE: Check if this step would exceed leash range from spawn
            // If so, stop at current position (mob lingers at edge)
            if (hasSpawnTile) {
              const nextDistFromSpawn = tileChebyshevDistance(
                nextTile,
                this._spawnTileMob,
              );
              if (nextDistFromSpawn > leashRange) {
                break; // Would exceed leash range - stop at edge
              }
            }

            // Zero-allocation: copy to pre-allocated path buffer
            this._pathBuffer[pathLength].x = nextTile.x;
            this._pathBuffer[pathLength].z = nextTile.z;
            pathLength++;

            // Update current position for next iteration (zero-allocation)
            this._currentPosTile.x = nextTile.x;
            this._currentPosTile.z = nextTile.z;

            // Stop early if we'll be in combat range after this step (classic MMORPG melee rules)
            if (
              tilesWithinMeleeRange(nextTile, this._targetTile, combatRange)
            ) {
              break;
            }
          }

          if (pathLength > 0) {
            // Zero-allocation: Reuse state.path array and copy tile values
            // (slice would create new array with shared object refs - bug!)
            state.path.length = pathLength;
            for (let i = 0; i < pathLength; i++) {
              if (!state.path[i]) {
                state.path[i] = { x: 0, z: 0 };
              }
              state.path[i].x = this._pathBuffer[i].x;
              state.path[i].z = this._pathBuffer[i].z;
            }
            state.pathIndex = 0;
            state.hasDestination = true;
            // Zero-allocation: copy values instead of spread
            if (!state.lastTargetTile) {
              state.lastTargetTile = { x: 0, z: 0 };
            }
            state.lastTargetTile.x = this._targetTile.x;
            state.lastTargetTile.z = this._targetTile.z;

            // CRITICAL: Increment moveSeq and send tileMovementStart with new path
            // Without this, the client only receives entityTileUpdate (sync packets)
            // and has no path to interpolate through, causing teleporting
            state.moveSeq = (state.moveSeq || 0) + 1;

            // Zero-allocation: copy path to pre-allocated network buffer and set length
            this._networkPathBuffer.length = pathLength;
            for (let i = 0; i < pathLength; i++) {
              // Ensure buffer element exists, create if needed (only happens once per slot)
              if (!this._networkPathBuffer[i]) {
                this._networkPathBuffer[i] = { x: 0, z: 0 };
              }
              this._networkPathBuffer[i].x = this._pathBuffer[i].x;
              this._networkPathBuffer[i].z = this._pathBuffer[i].z;
            }

            this.sendFn("tileMovementStart", {
              id: mobId,
              startTile: { x: state.currentTile.x, z: state.currentTile.z },
              path: this._networkPathBuffer,
              running: state.isRunning,
              destinationTile: {
                x: this._pathBuffer[pathLength - 1].x,
                z: this._pathBuffer[pathLength - 1].z,
              },
              moveSeq: state.moveSeq,
              isMob: true,
              emote: state.isRunning ? "run" : "walk",
              tilesPerTick: state.tilesPerTick, // Mob-specific speed for client interpolation
            });

            if (this.DEBUG_MODE) {
              const pathStr = state.path
                .map((t) => `(${t.x},${t.z})`)
                .join(" -> ");
              console.log(
                `[MobTileMovement] CHASE PATH: Mob ${mobId} from (${state.currentTile.x},${state.currentTile.z}) path: ${pathStr} toward destination (${destinationTile.x},${destinationTile.z}) [player at (${this._targetTile.x},${this._targetTile.z})]`,
              );
            }
          } else {
            // All directions blocked - NPC is stuck (safespotted!)
            // This is intentional behavior - NPCs don't search around obstacles
            if (this.DEBUG_MODE)
              console.log(
                `[MobTileMovement] NPC stuck (safespotted?) - all paths to target blocked`,
              );
            state.path.length = 0; // Zero-allocation clear
            state.pathIndex = 0;
            state.hasDestination = false;
            continue; // Skip movement - we're blocked
          }
        } else {
          // Target entity no longer exists - stop chasing
          state.isChasing = false;
          state.targetEntityId = null;
          state.lastTargetTile = null;
        }
      }

      // Skip if no path or at end
      if (state.path.length === 0 || state.pathIndex >= state.path.length) {
        if (state.hasDestination) {
          // Just finished moving
          state.hasDestination = false;
          this.sendFn("tileMovementEnd", {
            id: mobId,
            tile: state.currentTile,
            worldPos: [entity.position.x, entity.position.y, entity.position.z],
            moveSeq: state.moveSeq,
            isMob: true,
          });
        }
        continue;
      }

      // Store previous position for rotation calculation (zero allocation)
      this._prevTileMob.x = state.currentTile.x;
      this._prevTileMob.z = state.currentTile.z;

      // Move tiles per tick (mob speed)
      const tilesToMove = state.tilesPerTick;

      // Get target tile if chasing (for collision prevention)
      // Zero-allocation: use pre-allocated buffer and flag
      let hasTargetOccupied = false;
      if (state.targetEntityId) {
        // CRITICAL: Players are NOT in world.entities - they're accessed via world.getPlayer()
        const targetPlayer = this.world.getPlayer?.(state.targetEntityId);
        const targetEntity =
          targetPlayer || this.world.entities.get(state.targetEntityId);
        if (targetEntity) {
          worldToTileInto(
            targetEntity.position.x,
            targetEntity.position.z,
            this._targetOccupiedTile,
          );
          hasTargetOccupied = true;
        }
      }

      for (let i = 0; i < tilesToMove; i++) {
        if (state.pathIndex >= state.path.length) break;

        const nextTile = state.path[state.pathIndex];

        // classic MMORPG-STYLE COLLISION: Never step onto the tile occupied by our target
        // This is defense-in-depth - the path should already avoid this,
        // but we double-check here in case target moved after path calculation
        if (
          hasTargetOccupied &&
          tilesEqual(nextTile, this._targetOccupiedTile)
        ) {
          if (this.DEBUG_MODE)
            console.log(
              `[MobTileMovement] Refusing to step onto target's tile (${nextTile.x},${nextTile.z}), stopping`,
            );
          // Stop at current tile - we're adjacent and in combat range
          state.path.length = 0; // Zero-allocation clear
          state.pathIndex = 0;
          state.hasDestination = false;
          break;
        }

        // RULES-ACCURATE ENTITY COLLISION: Check if tile is blocked by another NPC
        // Pathfinder ignores entity collision; it is checked here at movement time.
        // If blocked: movement fails, path is RETAINED for retry next tick
        // This creates the "waiting behind" behavior seen in classic MMORPG
        const isBlocked = this.world.entityOccupancy.isBlocked(
          nextTile,
          mobId as EntityID,
        );
        if (isBlocked) {
          if (this.DEBUG_MODE) {
            const occupant = this.world.entityOccupancy.getOccupant(nextTile);
            console.log(
              `[MobTileMovement] COLLISION: Mob ${mobId} at (${state.currentTile.x},${state.currentTile.z}) cannot move to (${nextTile.x},${nextTile.z}) - blocked by ${occupant?.entityId}`,
            );
          }
          // Path is RETAINED - will retry next tick (rules-accurate)
          break;
        } else if (this.DEBUG_MODE) {
          console.log(
            `[MobTileMovement] MOVE OK: ${mobId} moving to (${nextTile.x},${nextTile.z})`,
          );
        }

        // Copy values instead of spread (zero allocation)
        state.currentTile.x = nextTile.x;
        state.currentTile.z = nextTile.z;
        state.pathIndex++;
      }

      if (this.DEBUG_MODE)
        console.log(
          `[MobTileMovement] onTick: Mob ${mobId} moved from tile (${this._prevTileMob.x},${this._prevTileMob.z}) to (${state.currentTile.x},${state.currentTile.z}), pathIndex=${state.pathIndex}/${state.path.length}`,
        );

      // Convert tile to world position
      const worldPos = tileToWorld(state.currentTile);

      // Get height - prioritize building floor elevation over terrain
      const towns = this.townSystem;
      let usedBuildingElevation = false;

      if (towns) {
        const collisionService = towns.getCollisionService();
        const buildingId = collisionService.getBuildingAtTile(
          state.currentTile.x,
          state.currentTile.z,
        );

        if (buildingId) {
          // Mob is inside a building - use building floor elevation (ground floor for mobs)
          const floorElevation = collisionService.getFloorElevation(
            state.currentTile.x,
            state.currentTile.z,
            0, // Mobs stay on ground floor
          );

          if (floorElevation !== null && Number.isFinite(floorElevation)) {
            worldPos.y = floorElevation + 0.1;
            usedBuildingElevation = true;
          }
        }
      }

      // Fall back to terrain height if not in building
      if (!usedBuildingElevation && terrain) {
        const height = terrain.getHeightAt(worldPos.x, worldPos.z);
        if (height !== null && Number.isFinite(height)) {
          worldPos.y = (height as number) + 0.1;
        }
      }

      // Update entity position on server
      entity.position.set(worldPos.x, worldPos.y, worldPos.z);
      if (entity.data) {
        entity.data.position = [worldPos.x, worldPos.y, worldPos.z];
      }

      // Update entity occupancy after movement (rules-accurate tile collision)
      // This updates the EntityOccupancyMap to reflect the mob's new position
      if (entity instanceof MobEntity) {
        if (this.DEBUG_MODE)
          console.log(
            `[MobTileMovement] OCCUPANCY UPDATE: ${mobId} now at tile (${state.currentTile.x},${state.currentTile.z})`,
          );
        entity.updateOccupancy();
      }

      // Calculate rotation based on movement direction (zero allocation - use pre-allocated tile)
      const prevWorld = tileToWorld(this._prevTileMob);
      const dx = worldPos.x - prevWorld.x;
      const dz = worldPos.z - prevWorld.z;

      if (Math.abs(dx) + Math.abs(dz) > 0.01) {
        // VRM faces -Z after factory rotation
        const yaw = Math.atan2(-dx, -dz);
        this._tempQuat.setFromAxisAngle(this._up, yaw);

        if (entity.node) {
          entity.node.quaternion.copy(this._tempQuat);
        }
        if (entity.data) {
          entity.data.quaternion = [
            this._tempQuat.x,
            this._tempQuat.y,
            this._tempQuat.z,
            this._tempQuat.w,
          ];
        }
      }

      // Broadcast tile position update to clients
      // This packet drives client-side TileInterpolator for smooth movement
      this.sendFn("entityTileUpdate", {
        id: mobId,
        tile: state.currentTile,
        worldPos: [worldPos.x, worldPos.y, worldPos.z],
        quaternion: entity.data?.quaternion,
        emote: "walk",
        tickNumber,
        moveSeq: state.moveSeq,
        isMob: true,
      });

      // NOTE: Do NOT call markNetworkDirty() here!
      // The tile movement packets (entityTileUpdate) already handle position sync.
      // Calling markNetworkDirty() would trigger the regular entity network sync,
      // causing duplicate position updates that conflict with tile interpolation.

      // Check if arrived at destination
      if (state.pathIndex >= state.path.length) {
        state.hasDestination = false;

        // Broadcast movement end - include idle emote for non-chasing mobs
        // so the client transitions to idle via the tile movement channel.
        // When chasing (in combat), omit emote - CombatSystem controls animation.
        this.sendFn("tileMovementEnd", {
          id: mobId,
          tile: state.currentTile,
          worldPos: [worldPos.x, worldPos.y, worldPos.z],
          moveSeq: state.moveSeq,
          isMob: true,
          emote: state.isChasing ? undefined : "idle",
        });

        // Clear path without creating new array
        state.path.length = 0;
        state.pathIndex = 0;
      }
    }
  }

  /**
   * Process movement for a specific mob on this tick
   *
   * RULES-ACCURATE: Called by GameTickProcessor during NPC phase
   * This processes just one mob's movement instead of all mobs.
   * NPCs process BEFORE players in classic MMORPG, which creates damage asymmetry.
   *
   * Zero-allocation: Uses pre-allocated tile buffers.
   *
   * @param mobId - The mob to process movement for
   * @param tickNumber - Current tick number
   */
  processMobTick(mobId: string, tickNumber: number): void {
    const state = this.mobStates.get(mobId);
    if (!state) return;

    const entity = this.world.entities.get(mobId);
    if (!entity) {
      this.mobStates.delete(mobId);
      return;
    }

    const terrain = this.getTerrain();

    // classic MMORPG-STYLE DUMB PATHFINDER FOR CHASE MODE
    if (state.isChasing && state.targetEntityId) {
      const targetPlayer = this.world.getPlayer?.(state.targetEntityId);
      const targetEntity =
        targetPlayer || this.world.entities.get(state.targetEntityId);

      if (targetEntity) {
        // Zero-allocation: use pre-allocated buffer for target tile
        worldToTileInto(
          targetEntity.position.x,
          targetEntity.position.z,
          this._currentTargetTileMob,
        );

        // Check if we're already in combat range
        const combatRange = state.combatRange || 1;
        if (
          tilesWithinMeleeRange(
            state.currentTile,
            this._currentTargetTileMob,
            combatRange,
          )
        ) {
          return; // In range, no need to move
        }

        // Find best unoccupied melee tile (prevents stacking)
        // Also check claimed destinations to prevent multiple mobs targeting same tile
        const destinationTile = getBestUnoccupiedMeleeTile(
          state.currentTile,
          this._currentTargetTileMob,
          this.world.entityOccupancy,
          mobId as EntityID,
          (tile) =>
            this.isTileWalkable(tile) &&
            !this._claimedDestinations.has(tileKey(tile)),
          combatRange,
        );

        // If no unoccupied melee tile available, wait
        if (!destinationTile) {
          return; // All melee tiles occupied or claimed - wait for one to open up
        }

        // Claim this destination so other mobs in this tick won't target it
        this._claimedDestinations.add(tileKey(destinationTile));

        // Calculate chase path toward the unoccupied melee tile
        // Zero-allocation: use pre-allocated path buffer and currentPos tile
        let pathLength = 0;
        this._currentPosTile.x = state.currentTile.x;
        this._currentPosTile.z = state.currentTile.z;

        // RULES-ACCURATE LEASH RANGE CAP: Get spawn point and leash range
        // Mobs cannot move beyond leashRange from their spawn point
        const mobEntity = entity instanceof MobEntity ? entity : null;
        const spawnPoint = mobEntity?.getSpawnPoint();
        const leashRange = mobEntity?.getLeashRange() ?? 10;

        // Zero-allocation: use pre-allocated spawn tile buffer
        let hasSpawnTile = false;
        if (spawnPoint) {
          worldToTileInto(spawnPoint.x, spawnPoint.z, this._spawnTileMob);
          hasSpawnTile = true;
        }

        for (let step = 0; step < state.tilesPerTick; step++) {
          // Zero-allocation: copy to pre-allocated closure position buffer
          this._closurePos.x = this._currentPosTile.x;
          this._closurePos.z = this._currentPosTile.z;
          const nextTile = chaseStep(
            this._currentPosTile,
            destinationTile,
            (tile) => this.isTileWalkable(tile, this._closurePos),
          );

          if (!nextTile) break;

          // RULES-ACCURATE: Check if this step would exceed leash range from spawn
          // If so, stop at current position (mob lingers at edge)
          if (hasSpawnTile) {
            const nextDistFromSpawn = tileChebyshevDistance(
              nextTile,
              this._spawnTileMob,
            );
            if (nextDistFromSpawn > leashRange) {
              break; // Would exceed leash range - stop at edge
            }
          }

          // Zero-allocation: copy to pre-allocated path buffer
          this._pathBuffer[pathLength].x = nextTile.x;
          this._pathBuffer[pathLength].z = nextTile.z;
          pathLength++;

          // Update current position for next iteration (zero-allocation)
          this._currentPosTile.x = nextTile.x;
          this._currentPosTile.z = nextTile.z;

          if (
            tilesWithinMeleeRange(
              nextTile,
              this._currentTargetTileMob,
              combatRange,
            )
          )
            break;
        }

        if (pathLength === 0) {
          return; // Blocked - safespotted
        }

        // Zero-allocation: Reuse state.path array and copy tile values
        // (slice would create new array with shared object refs - bug!)
        state.path.length = pathLength;
        for (let i = 0; i < pathLength; i++) {
          if (!state.path[i]) {
            state.path[i] = { x: 0, z: 0 };
          }
          state.path[i].x = this._pathBuffer[i].x;
          state.path[i].z = this._pathBuffer[i].z;
        }
        state.pathIndex = 0;
        // Zero-allocation: copy values instead of spread
        if (!state.lastTargetTile) {
          state.lastTargetTile = { x: 0, z: 0 };
        }
        state.lastTargetTile.x = this._currentTargetTileMob.x;
        state.lastTargetTile.z = this._currentTargetTileMob.z;
      }
    }

    // Skip if no path or at end
    if (state.path.length === 0 || state.pathIndex >= state.path.length) {
      return;
    }

    // Store previous position for rotation (zero allocation)
    this._prevTileMob.x = state.currentTile.x;
    this._prevTileMob.z = state.currentTile.z;

    // Move up to tilesPerTick tiles
    for (let i = 0; i < state.tilesPerTick; i++) {
      if (state.pathIndex >= state.path.length) break;
      const nextTile = state.path[state.pathIndex];

      // RULES-ACCURATE ENTITY COLLISION: Check if tile is blocked by another NPC
      // Pathfinder ignores entity collision; it is checked here at movement time.
      // If blocked: movement fails, path is RETAINED for retry next tick
      if (this.world.entityOccupancy.isBlocked(nextTile, mobId as EntityID)) {
        // Path is RETAINED - will retry next tick (rules-accurate)
        break;
      }

      // Copy values instead of spread (zero allocation)
      state.currentTile.x = nextTile.x;
      state.currentTile.z = nextTile.z;
      state.pathIndex++;
    }

    // Convert tile to world position
    const worldPos = tileToWorld(state.currentTile);

    // Get height - prioritize building floor elevation over terrain
    const towns = this.townSystem;
    let usedBuildingElevation = false;

    if (towns) {
      const collisionService = towns.getCollisionService();
      const buildingId = collisionService.getBuildingAtTile(
        state.currentTile.x,
        state.currentTile.z,
      );

      if (buildingId) {
        // Mob is inside a building - use building floor elevation (ground floor for mobs)
        const floorElevation = collisionService.getFloorElevation(
          state.currentTile.x,
          state.currentTile.z,
          0, // Mobs stay on ground floor
        );

        if (floorElevation !== null && Number.isFinite(floorElevation)) {
          worldPos.y = floorElevation + 0.1;
          usedBuildingElevation = true;
        }
      }
    }

    // Fall back to terrain height if not in building
    if (!usedBuildingElevation && terrain) {
      const height = terrain.getHeightAt(worldPos.x, worldPos.z);
      if (height !== null && Number.isFinite(height)) {
        worldPos.y = (height as number) + 0.1;
      }
    }

    // Update entity position on server
    entity.position.set(worldPos.x, worldPos.y, worldPos.z);
    if (entity.data) {
      entity.data.position = [worldPos.x, worldPos.y, worldPos.z];
    }

    // Update entity occupancy after movement (rules-accurate tile collision)
    if (entity instanceof MobEntity) {
      entity.updateOccupancy();
    }

    // Calculate rotation based on movement direction (zero allocation - use pre-allocated tile)
    const prevWorld = tileToWorld(this._prevTileMob);
    const dx = worldPos.x - prevWorld.x;
    const dz = worldPos.z - prevWorld.z;

    if (Math.abs(dx) + Math.abs(dz) > 0.01) {
      const yaw = Math.atan2(-dx, -dz);
      this._tempQuat.setFromAxisAngle(this._up, yaw);

      if (entity.node) {
        entity.node.quaternion.copy(this._tempQuat);
      }
      if (entity.data) {
        entity.data.quaternion = [
          this._tempQuat.x,
          this._tempQuat.y,
          this._tempQuat.z,
          this._tempQuat.w,
        ];
      }
    }

    // Broadcast tile position update
    this.sendFn("entityTileUpdate", {
      id: mobId,
      tile: state.currentTile,
      worldPos: [worldPos.x, worldPos.y, worldPos.z],
      quaternion: entity.data?.quaternion,
      emote: "walk",
      tickNumber,
      moveSeq: state.moveSeq,
      isMob: true,
    });

    // Check if arrived at destination
    if (state.pathIndex >= state.path.length) {
      state.hasDestination = false;

      this.sendFn("tileMovementEnd", {
        id: mobId,
        tile: state.currentTile,
        worldPos: [worldPos.x, worldPos.y, worldPos.z],
        moveSeq: state.moveSeq,
        isMob: true,
      });

      // Clear path without creating new array
      state.path.length = 0;
      state.pathIndex = 0;

      if (!state.isChasing) {
        this.sendFn("entityModified", {
          id: mobId,
          changes: {
            p: [worldPos.x, worldPos.y, worldPos.z],
            v: [0, 0, 0],
            e: "idle",
          },
        });
      }
    }
  }

  /**
   * Check if a mob is currently moving
   */
  isMoving(mobId: string): boolean {
    const state = this.mobStates.get(mobId);
    return state ? state.hasDestination : false;
  }

  /**
   * Get current tile for a mob
   */
  getCurrentTile(mobId: string): TileCoord | null {
    const state = this.mobStates.get(mobId);
    return state ? state.currentTile : null;
  }

  /**
   * Get distance to destination in tiles
   */
  getDistanceToDestination(mobId: string): number {
    const state = this.mobStates.get(mobId);
    if (!state || !state.hasDestination) return 0;
    return Math.max(0, state.path.length - state.pathIndex);
  }

  /**
   * Initialize mob at a specific tile (for spawning)
   */
  initializeMob(
    mobId: string,
    position: Position3D,
    tilesPerTick: number = TILES_PER_TICK_WALK,
  ): void {
    const currentTile = worldToTile(position.x, position.z);
    const state = createMobTileState(currentTile, tilesPerTick);
    this.mobStates.set(mobId, state);
  }

  /**
   * Cleanup state for a mob (on death/despawn)
   */
  cleanup(mobId: string): void {
    this.mobStates.delete(mobId);
  }

  /**
   * Get stats for debugging/monitoring
   */
  getStats(): {
    totalMobs: number;
    mobsMoving: number;
    totalPathTiles: number;
  } {
    let mobsMoving = 0;
    let totalPathTiles = 0;

    for (const state of this.mobStates.values()) {
      if (state.hasDestination) mobsMoving++;
      totalPathTiles += Math.max(0, state.path.length - state.pathIndex);
    }

    return {
      totalMobs: this.mobStates.size,
      mobsMoving,
      totalPathTiles,
    };
  }
}
