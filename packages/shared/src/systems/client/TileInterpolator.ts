/**
 * Tile Interpolator - classic fantasy MMORPG-Style Movement
 *
 * classic MMORPG Movement Model (from research):
 * 1. Server calculates full BFS path
 * 2. Server sends FULL PATH to client in tileMovementStart
 * 3. Client walks through path at FIXED SPEED (doesn't wait for individual updates)
 * 4. Server sends position sync every 600ms tick
 * 5. Client uses server updates for verification/sync only
 *
 * Key Insight: The client PREDICTS movement by walking through the known path.
 * Server updates just confirm the prediction is correct.
 *
 * Movement Speeds (configurable via TileSystem constants):
 * - Walking: TILES_PER_TICK_WALK tiles per 600ms tick
 * - Running: TILES_PER_TICK_RUN tiles per 600ms tick
 *
 */

import * as THREE from "three";
import {
  TileCoord,
  TICK_DURATION_MS,
  TILES_PER_TICK_WALK,
  TILES_PER_TICK_RUN,
  tilesEqual,
  worldToTile,
  tileToWorld,
  tileToWorldInto,
} from "../shared/movement/TileSystem";

// Movement speeds in tiles per second (derived from server tick rate)
// Server moves TILES_PER_TICK tiles per TICK_DURATION_MS
const WALK_SPEED = TILES_PER_TICK_WALK / (TICK_DURATION_MS / 1000); // tiles/sec
const RUN_SPEED = TILES_PER_TICK_RUN / (TICK_DURATION_MS / 1000); // tiles/sec

// How close we need to be to consider "at" a tile
const TILE_ARRIVAL_THRESHOLD = 0.02;
// Squared threshold — avoids sqrt in hot arrival check
const TILE_ARRIVAL_THRESHOLD_SQ =
  TILE_ARRIVAL_THRESHOLD * TILE_ARRIVAL_THRESHOLD;
// Squared skip threshold for backward-tile detection (0.5² = 0.25)
const TILE_SKIP_THRESHOLD_SQ = 0.25;

// Maximum distance from server position before we snap (teleport detection)
// Should be larger than max tiles moved per tick to avoid false snaps
const MAX_DESYNC_DISTANCE = Math.max(TILES_PER_TICK_RUN * 2, 8);

// Exponential smoothing time constant for catch-up multiplier blending
// Larger = slower/smoother transitions, smaller = faster/snappier
// Using exponential decay: alpha = 1 - exp(-deltaTime / TIME_CONSTANT)
const CATCHUP_SMOOTHING_RATE = 10.0; // ~100ms to reach 63% of target (faster response for desyncs)
// Maximum multiplier change per second to prevent jarring jumps during lag spikes
// Higher value allows faster catch-up when significantly behind (max 4.0x multiplier)
const CATCHUP_MAX_CHANGE_PER_SEC = 5.0; // Can change by at most 5.0 per second (~0.6s to reach 4.0x from 1.0x)

// Rotation slerp speed - how fast character turns toward target direction
// Higher = faster rotation, lower = smoother/slower rotation
// 12.0 = ~90% of rotation completed in ~0.2 seconds (responsive but smooth)
const ROTATION_SLERP_SPEED = 12.0;
// Keep large target-side reversals readable. Exponential damping remains
// responsive for ordinary tracking errors, while this angular-velocity ceiling
// prevents a close-range bearing flip from becoming a one-sample visual snap.
const MAX_ROTATION_RADIANS_PER_SECOND = 5.85;

// Emotes that are controlled by TileInterpolator (movement-related)
// Other emotes like "chopping", "combat", "death" etc. should NOT be overridden
// TileInterpolator only resets to idle if current emote is a movement emote
const MOVEMENT_EMOTES = new Set<string | undefined | null>([
  "walk",
  "run",
  "idle",
  undefined,
  null,
  "",
]);

const DEFAULT_MAX_ENTITIES_PER_FRAME = 1000;
const DEFAULT_BUDGET_CHECK_INTERVAL = 20;
const MIN_MAX_ENTITIES_PER_FRAME = 50;
const MAX_MAX_ENTITIES_PER_FRAME = 20000;
const MIN_BUDGET_CHECK_INTERVAL = 1;
const MAX_BUDGET_CHECK_INTERVAL = 200;

type TileInterpolatorConfig = {
  maxEntitiesPerFrame?: number;
  budgetCheckInterval?: number;
};

const clampInt = (
  value: number,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
};

const readPositiveIntegerEnv = (...keys: string[]): number | null => {
  const runtimeEnv = (globalThis as { env?: Record<string, string> }).env;
  const processEnv =
    typeof process !== "undefined" && typeof process.env !== "undefined"
      ? process.env
      : undefined;

  for (const key of keys) {
    const raw = runtimeEnv?.[key] ?? processEnv?.[key];
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
};

/**
 * Movement state for a single entity
 */
interface EntityMovementState {
  // ========== Path State ==========
  // Full path from server (all tiles to walk through)
  fullPath: TileCoord[];
  // Index of the tile we're currently moving TOWARD (0 = first destination tile)
  targetTileIndex: number;
  // The intended final destination tile (authoritative from server)
  // This ensures we always end at the clicked tile even if path calculation differs
  destinationTile: TileCoord | null;

  // ========== Visual State ==========
  // Current interpolated world position (what we render)
  visualPosition: THREE.Vector3;
  // Target world position (current target tile in world coords)
  targetWorldPos: THREE.Vector3;
  // Current visual rotation (what we render, smoothly interpolated via slerp)
  quaternion: THREE.Quaternion;
  // Target rotation (what we're rotating toward)
  targetQuaternion: THREE.Quaternion;

  // ========== Movement State ==========
  // Whether entity is running (affects speed)
  isRunning: boolean;
  // Whether entity is actively moving
  isMoving: boolean;
  // Current emote (walk/run/idle)
  emote: string;
  // Emote to apply when movement finishes (e.g., idle, fishing)
  // Stored to avoid switching away from movement emotes while still interpolating
  pendingArrivalEmote: string | null;
  // Per-entity movement speed (tiles per server tick)
  // Defaults to TILES_PER_TICK_WALK/RUN, but can be overridden for mobs
  tilesPerTick: number | null;
  // Whether entity is in combat rotation mode (takes priority over movement facing)
  // When true, combat rotation is maintained even during movement
  inCombatRotation: boolean;
  // A frozen streaming duel pair owns facing over generic entity rotation packets.
  // This prevents an ordinary movement/combat quaternion from steering a
  // contestant away from its opponent between authoritative target refreshes.
  combatRotationLocked: boolean;

  // ========== Sync State ==========
  // Last tile confirmed by server
  serverConfirmedTile: TileCoord;
  // Last Y position confirmed by server (preserves building floor elevation)
  serverConfirmedY: number | null;
  // Last tick number from server
  lastServerTick: number;
  // Catch-up multiplier for when client is behind server (current, smoothly lerped)
  // 1.0 = normal speed, >1.0 = catching up
  catchUpMultiplier: number;
  // Target catch-up multiplier (set by sync logic, current lerps toward this)
  // Smooth blending prevents jarring speed changes
  targetCatchUpMultiplier: number;
  // Movement sequence number - used to ignore stale packets from previous movements
  // Incremented on server each time a new path starts
  moveSeq: number;

  // Last global simulation timestamp when this state was processed.
  // Used to prevent time dilation when entities are updated round-robin.
  lastProcessedTime: number;
}

/**
 * Client-side tile interpolator using classic MMORPG's full-path prediction model
 *
 * The client receives the full path and walks through it at fixed speed.
 * Server updates are used for verification/sync only, not for driving movement.
 */
export class TileInterpolator {
  private entityStates: Map<string, EntityMovementState> = new Map();
  private debugMode = false;
  /** Monotonic simulation clock in seconds (advances by frame delta). */
  private simulationTime = 0;
  /** Hard cap to prevent worst-case frame spikes with huge populations. */
  private readonly maxEntitiesPerFrame: number;
  /** How frequently to check frame budget during entity processing. */
  private readonly budgetCheckInterval: number;

  // Reusable vectors - pre-allocated to avoid per-frame allocations
  private _tempDir = new THREE.Vector3();
  private _tempQuat = new THREE.Quaternion();
  // Y-axis for yaw rotation
  private _up = new THREE.Vector3(0, 1, 0);
  // Pre-allocated Vector3 for tile transitions in update()
  private _nextPos = new THREE.Vector3();
  // Pre-allocated world-pos for backward-tile-skip (avoids tileToWorld() allocation per frame)
  private _destWorldPos = { x: 0, y: 0, z: 0 };

  // OPTIMIZATION: Pre-allocated objects for onMovementStart/onTileUpdate
  // Avoids creating new Vector3/Quaternion per movement start
  private _startPos = new THREE.Vector3();
  private _rotationTarget = new THREE.Vector3();
  private _initialRotation = new THREE.Quaternion();
  private _usePos = new THREE.Vector3();
  private _initialQuat = new THREE.Quaternion();

  // OPTIMIZATION: Progressive processing with frame budget
  /** Rotation index for round-robin processing when over budget */
  private _entityRotationIndex = 0;
  /** Cached array for iteration - avoids Map->Array conversion */
  private _entityStateArray: Array<[string, EntityMovementState]> = [];
  /** Flag indicating array needs refresh */
  private _entityArrayDirty = true;

  constructor(config: TileInterpolatorConfig = {}) {
    const envMaxEntities = readPositiveIntegerEnv(
      "PUBLIC_TILE_INTERPOLATOR_MAX_ENTITIES_PER_FRAME",
      "TILE_INTERPOLATOR_MAX_ENTITIES_PER_FRAME",
    );
    const envBudgetInterval = readPositiveIntegerEnv(
      "PUBLIC_TILE_INTERPOLATOR_BUDGET_CHECK_INTERVAL",
      "TILE_INTERPOLATOR_BUDGET_CHECK_INTERVAL",
    );

    this.maxEntitiesPerFrame = clampInt(
      config.maxEntitiesPerFrame ??
        envMaxEntities ??
        DEFAULT_MAX_ENTITIES_PER_FRAME,
      MIN_MAX_ENTITIES_PER_FRAME,
      MAX_MAX_ENTITIES_PER_FRAME,
      DEFAULT_MAX_ENTITIES_PER_FRAME,
    );
    this.budgetCheckInterval = clampInt(
      config.budgetCheckInterval ??
        envBudgetInterval ??
        DEFAULT_BUDGET_CHECK_INTERVAL,
      MIN_BUDGET_CHECK_INTERVAL,
      MAX_BUDGET_CHECK_INTERVAL,
      DEFAULT_BUDGET_CHECK_INTERVAL,
    );
  }

  /**
   * Get the remaining path tiles for an entity (from current target index onward).
   * Used by BFS path debug visualization.
   */
  getEntityPath(entityId: string): TileCoord[] | null {
    const state = this.entityStates.get(entityId);
    if (!state || !state.isMoving || state.fullPath.length === 0) return null;
    return state.fullPath.slice(state.targetTileIndex);
  }

  /** Helper to set entity state and mark cache dirty */
  private setEntityState(entityId: string, state: EntityMovementState): void {
    this.entityStates.set(entityId, state);
    this._entityArrayDirty = true;
  }

  /** Helper to delete entity state and mark cache dirty */
  private deleteEntityState(entityId: string): boolean {
    const deleted = this.entityStates.delete(entityId);
    if (deleted) this._entityArrayDirty = true;
    return deleted;
  }

  /**
   * Calculate Chebyshev distance between two tiles (max of dx, dz)
   */
  private tileDistance(tileA: TileCoord, tileB: TileCoord): number {
    const dx = Math.abs(tileA.x - tileB.x);
    const dz = Math.abs(tileA.z - tileB.z);
    return Math.max(dx, dz);
  }

  /**
   * Calculate rotation quaternion to face from one position to another
   * Uses atan2 for stable yaw calculation (avoids setFromUnitVectors instability)
   * Returns null if distance is too small to determine direction
   */
  private calculateFacingRotation(
    from: THREE.Vector3,
    to: THREE.Vector3,
  ): THREE.Quaternion | null {
    const dx = to.x - from.x;
    const dz = to.z - from.z;

    // Distance too small to determine direction - preserve existing rotation
    if (Math.abs(dx) + Math.abs(dz) < 0.01) {
      return null;
    }

    // Use atan2 for stable yaw calculation
    // VRM faces -Z after factory rotation. Rotating -Z by yaw θ around Y gives:
    // (-sin(θ), 0, -cos(θ)). To face direction (dx, dz), solve:
    // -sin(θ) = dx, -cos(θ) = dz → θ = atan2(-dx, -dz)
    const yaw = Math.atan2(-dx, -dz);

    // Create quaternion from Y-axis rotation (yaw only)
    this._tempQuat.setFromAxisAngle(this._up, yaw);
    return this._tempQuat;
  }

  /**
   * Advance the visual quaternion toward its current movement/combat target.
   * Keeping this in one path ensures stationary combat turns and movement turns
   * use the same frame-rate-independent damping and shortest-arc behavior.
   */
  private smoothRotation(state: EntityMovementState, deltaTime: number): void {
    if (state.quaternion.dot(state.targetQuaternion) < 0) {
      state.targetQuaternion.set(
        -state.targetQuaternion.x,
        -state.targetQuaternion.y,
        -state.targetQuaternion.z,
        -state.targetQuaternion.w,
      );
    }
    const remainingAngle = state.quaternion.angleTo(state.targetQuaternion);
    if (remainingAngle < 1e-6) return;
    const rotationAlpha = 1 - Math.exp(-deltaTime * ROTATION_SLERP_SPEED);
    const angularVelocityAlpha = Math.min(
      1,
      (MAX_ROTATION_RADIANS_PER_SECOND * deltaTime) / remainingAngle,
    );
    state.quaternion.slerp(
      state.targetQuaternion,
      Math.min(rotationAlpha, angularVelocityAlpha),
    );
  }

  /**
   * Called when server sends a movement path started
   * This is the PRIMARY way movement begins - client receives full path
   *
   * Server is AUTHORITATIVE - client follows server path exactly, no recalculation.
   * If client visual position differs from server's startTile, catch-up multiplier handles it.
   *
   * @param startTile Server's authoritative starting tile (where server knows entity IS)
   * @param destinationTile Final target tile for verification
   * @param moveSeq Movement sequence number for packet ordering
   * @param emote Optional emote bundled with movement (classic MMORPG-style)
   * @param tilesPerTick Optional per-entity speed (tiles per server tick)
   */
  onMovementStart(
    entityId: string,
    path: TileCoord[],
    running: boolean,
    currentPosition?: THREE.Vector3,
    startTile?: TileCoord,
    destinationTile?: TileCoord,
    moveSeq?: number,
    emote?: string,
    tilesPerTick?: number,
    isContinuation?: boolean,
  ): void {
    if (this.debugMode) {
      console.log(
        `[TileInterpolator] onMovementStart: ${entityId}, startTile=${startTile ? `(${startTile.x},${startTile.z})` : "none"}, path=${path.length} tiles, running=${running}, dest=${destinationTile ? `(${destinationTile.x},${destinationTile.z})` : "none"}, moveSeq=${moveSeq}`,
      );
    }

    // Get existing state to check moveSeq
    const existingState = this.entityStates.get(entityId);

    // If we have moveSeq and existing state, validate sequence
    // Ignore stale start packets from previous movements
    if (
      moveSeq !== undefined &&
      existingState &&
      existingState.moveSeq > moveSeq
    ) {
      if (this.debugMode) {
        console.log(
          `[TileInterpolator] Ignoring stale onMovementStart: moveSeq ${moveSeq} < current ${existingState.moveSeq}`,
        );
      }
      return;
    }

    if (path.length === 0) {
      // No path - clear any existing state
      this.deleteEntityState(entityId);
      return;
    }

    // Continuation fast-path: server sent this segment 1 tick early so the client
    // can append it to the existing path with no idle frame.
    // Preserve visual position, catch-up multiplier, and tile index — nothing resets.
    const existingMoving =
      existingState?.isMoving && (existingState?.fullPath.length ?? 0) > 0;
    if (isContinuation && existingMoving && existingState) {
      for (const tile of path) {
        existingState.fullPath.push({ ...tile });
      }
      if (destinationTile) {
        existingState.destinationTile = { ...destinationTile };
      }
      existingState.moveSeq = moveSeq ?? existingState.moveSeq;
      existingState.isRunning = running;
      if (this.debugMode) {
        console.log(
          `[TileInterpolator] Continuation: appended ${path.length} tiles to path (total=${existingState.fullPath.length})`,
        );
      }
      return;
    }
    // isContinuation=true but entity already stopped (packet arrived slightly late):
    // fall through to normal full-reset logic — still better than an idle gap.

    // Get or create state
    let state = this.entityStates.get(entityId);

    // OPTIMIZATION: Reuse pre-allocated vector instead of clone()/new
    // Starting visual position for interpolation - prioritize current visual position
    if (state?.visualPosition) {
      this._startPos.copy(state.visualPosition);
    } else if (currentPosition) {
      this._startPos.copy(currentPosition);
    } else {
      this._startPos.set(0, 0, 0);
    }
    const startPos = this._startPos;

    // SERVER PATH IS AUTHORITATIVE - no client path calculation
    // Server sends complete path from its known position. Client follows exactly.
    // If client visual position differs from server's startTile, catch-up multiplier handles sync.
    // OPTIMIZATION: push loop avoids intermediate array from .map()
    const finalPath: TileCoord[] = [];
    for (let _pi = 0; _pi < path.length; _pi++) {
      finalPath.push({ x: path[_pi].x, z: path[_pi].z });
    }

    // Ensure destination is included (authoritative from server)
    if (destinationTile) {
      const lastTileInPath = finalPath[finalPath.length - 1];
      if (!lastTileInPath || !tilesEqual(lastTileInPath, destinationTile)) {
        finalPath.push({ ...destinationTile });
        if (this.debugMode) {
          console.log(
            `[TileInterpolator] Appended destination tile (${destinationTile.x},${destinationTile.z}) to path`,
          );
        }
      }
    }

    // If we ended up with no path, nothing to do
    if (finalPath.length === 0) {
      return;
    }

    // Calculate rotation to face DESTINATION (not first tile in path)
    // When spam clicking, server's path starts from its known position which may be
    // behind the client's visual position. Using first tile could cause facing backward.
    // Instead, face the destination - this matches classic MMORPG behavior (face where you clicked).
    const firstTileWorld = tileToWorld(finalPath[0]);
    const rotationTargetTile =
      destinationTile || finalPath[finalPath.length - 1];
    const rotationTargetWorld = tileToWorld(rotationTargetTile);
    // OPTIMIZATION: Reuse pre-allocated vector instead of new THREE.Vector3()
    this._rotationTarget.set(
      rotationTargetWorld.x,
      startPos.y,
      rotationTargetWorld.z,
    );
    const calculatedRotation = this.calculateFacingRotation(
      startPos,
      this._rotationTarget,
    );
    // OPTIMIZATION: Reuse pre-allocated quaternion for identity fallback
    if (calculatedRotation) {
      this._initialRotation.copy(calculatedRotation);
    } else {
      this._initialRotation.identity();
    }
    const initialRotation = this._initialRotation;

    // Use server's startTile for confirmed position tracking
    const serverConfirmed = startTile ?? worldToTile(startPos.x, startPos.z);

    if (state) {
      const preserveCombatRotation = state.inCombatRotation;
      // Update existing state with new path
      state.fullPath = finalPath;
      state.targetTileIndex = 0;
      state.destinationTile = destinationTile ? { ...destinationTile } : null;
      state.visualPosition.copy(startPos);
      state.targetWorldPos.set(firstTileWorld.x, startPos.y, firstTileWorld.z);
      // DON'T snap quaternion - keep current visual rotation for smooth turn
      // A combat-facing fighter keeps looking at its opponent while a new
      // strafe/kite segment begins. Replacing the target here creates a
      // one-frame turn toward the path before ClientNetwork refreshes the
      // opponent direction on the next animation frame. That transient snap is
      // visible to 60 FPS capture and can exceed a right angle. Ordinary
      // movement still takes ownership once combat rotation is explicitly
      // cleared by the combat-ended/clear-face packet.
      if (!preserveCombatRotation) {
        state.targetQuaternion.copy(initialRotation);
      }
      state.isRunning = running;
      state.isMoving = true;
      state.emote = emote ?? (running ? "run" : "walk");
      state.pendingArrivalEmote = null;
      state.inCombatRotation = preserveCombatRotation;
      state.serverConfirmedTile = { ...serverConfirmed };
      state.serverConfirmedY = startPos.y; // Preserve server Y (building floor elevation)
      state.lastServerTick = 0;
      state.catchUpMultiplier = 1.0;
      state.targetCatchUpMultiplier = 1.0;
      state.moveSeq = moveSeq ?? state.moveSeq;
      state.tilesPerTick = tilesPerTick ?? null;
      state.lastProcessedTime = this.simulationTime;
    } else {
      // Create new state - set both quaternion and target to initial (no slerp needed for first movement)
      state = {
        fullPath: finalPath,
        targetTileIndex: 0,
        destinationTile: destinationTile ? { ...destinationTile } : null,
        visualPosition: startPos.clone(),
        targetWorldPos: new THREE.Vector3(
          firstTileWorld.x,
          startPos.y,
          firstTileWorld.z,
        ),
        quaternion: initialRotation.clone(),
        targetQuaternion: initialRotation.clone(),
        isRunning: running,
        isMoving: true,
        emote: emote ?? (running ? "run" : "walk"),
        pendingArrivalEmote: null,
        inCombatRotation: false,
        combatRotationLocked: false,
        serverConfirmedTile: { ...serverConfirmed },
        serverConfirmedY: startPos.y, // Preserve server Y (building floor elevation)
        lastServerTick: 0,
        catchUpMultiplier: 1.0,
        targetCatchUpMultiplier: 1.0,
        moveSeq: moveSeq ?? 0,
        tilesPerTick: tilesPerTick ?? null,
        lastProcessedTime: this.simulationTime,
      };
      this.setEntityState(entityId, state);
    }

    if (this.debugMode) {
      console.log(
        `[TileInterpolator] Path set: ${finalPath.map((t) => `(${t.x},${t.z})`).join(" -> ")}, tilesPerTick=${tilesPerTick ?? "default"}`,
      );
    }
  }

  /**
   * Immediately pivot the entity's visual rotation toward a new world-space target.
   * Called client-side on every move-click so the character faces the new destination
   * BEFORE the server round-trip completes (optimistic rotation).
   *
   * Only updates the target quaternion — the existing path, visual position, and
   * catch-up state are untouched. The slerp in update() smoothly transitions
   * the visual rotation, and onMovementStart() will overwrite targetQuaternion
   * again when the server's confirmed path arrives.
   */
  setOptimisticTarget(
    entityId: string,
    worldPos: { x: number; z: number },
  ): void {
    const state = this.entityStates.get(entityId);
    if (!state || !state.isMoving) return;
    const dx = worldPos.x - state.visualPosition.x;
    const dz = worldPos.z - state.visualPosition.z;
    if (Math.abs(dx) < 0.01 && Math.abs(dz) < 0.01) return;
    // VRM faces -Z; apply same yaw convention as the movement rotation code
    const yaw = Math.atan2(-dx, -dz);
    state.targetQuaternion.setFromAxisAngle(this._up, yaw);
  }

  /**
   * Called when server sends a tile position update (every 600ms tick)
   * This is for SYNC/VERIFICATION only - not the primary movement driver
   *
   * @param moveSeq Movement sequence number for packet ordering
   */
  onTileUpdate(
    entityId: string,
    serverTile: TileCoord,
    worldPos: THREE.Vector3,
    emote: string,
    quaternion?: number[],
    entityCurrentPos?: THREE.Vector3,
    tickNumber?: number,
    moveSeq?: number,
  ): void {
    const state = this.entityStates.get(entityId);

    // Validate moveSeq if provided - ignore stale packets from previous movements
    if (moveSeq !== undefined && state && state.moveSeq > moveSeq) {
      if (this.debugMode) {
        console.log(
          `[TileInterpolator] Ignoring stale onTileUpdate: moveSeq ${moveSeq} < current ${state.moveSeq}`,
        );
      }
      return;
    }

    if (!state) {
      // No active path - this might be a sync update for a stationary entity
      // IMPORTANT: Use entity's current visual position if available, not server position
      // This prevents teleporting to wrong location when state is first created
      const currentPos = entityCurrentPos || worldPos;

      // Check if server position is very different from current position
      const currentTile = worldToTile(currentPos.x, currentPos.z);
      const dist = Math.max(
        Math.abs(currentTile.x - serverTile.x),
        Math.abs(currentTile.z - serverTile.z),
      );

      // If large discrepancy and we have entity position, trust entity over server
      const usePos =
        dist > MAX_DESYNC_DISTANCE && entityCurrentPos
          ? entityCurrentPos
          : worldPos;

      if (dist > MAX_DESYNC_DISTANCE && entityCurrentPos) {
        console.warn(
          `[TileInterpolator] Creating state: large discrepancy (${dist} tiles). Using entity pos (${currentTile.x},${currentTile.z}) not server (${serverTile.x},${serverTile.z})`,
        );
      }

      const initialQuat = quaternion
        ? new THREE.Quaternion(
            quaternion[0],
            quaternion[1],
            quaternion[2],
            quaternion[3],
          )
        : new THREE.Quaternion();
      const newState: EntityMovementState = {
        fullPath: [],
        targetTileIndex: 0,
        destinationTile: null,
        visualPosition: usePos.clone(),
        targetWorldPos: usePos.clone(),
        quaternion: initialQuat.clone(),
        targetQuaternion: initialQuat.clone(),
        isRunning: emote === "run",
        isMoving: false,
        emote: emote,
        pendingArrivalEmote: null,
        inCombatRotation: false,
        combatRotationLocked: false,
        serverConfirmedTile: { ...serverTile },
        serverConfirmedY: worldPos.y, // Preserve server Y (building floor elevation)
        lastServerTick: tickNumber ?? 0,
        catchUpMultiplier: 1.0,
        targetCatchUpMultiplier: 1.0,
        moveSeq: moveSeq ?? 0,
        tilesPerTick: null, // Will be set when movement starts
        lastProcessedTime: this.simulationTime,
      };
      this.setEntityState(entityId, newState);
      return;
    }

    // Ignore out-of-order packets
    if (tickNumber !== undefined && tickNumber <= state.lastServerTick) {
      if (this.debugMode) {
        console.log(
          `[TileInterpolator] Ignoring old tick ${tickNumber} <= ${state.lastServerTick}`,
        );
      }
      return;
    }

    if (tickNumber !== undefined) {
      state.lastServerTick = tickNumber;
    }

    // Update server confirmed position and Y (for building floor elevation)
    state.serverConfirmedTile = { ...serverTile };
    state.serverConfirmedY = worldPos.y;

    // Update emote/running state from server
    state.emote = emote;
    state.isRunning = emote === "run";

    // DON'T update rotation from server while actively moving
    // Client calculates rotation based on interpolated position for smooth visuals
    // Server rotation would cause brief twitches since it's calculated at discrete tile positions
    // Only accept server rotation when NOT moving (path empty or completed)
    if (quaternion && state.fullPath.length === 0) {
      state.quaternion.set(
        quaternion[0],
        quaternion[1],
        quaternion[2],
        quaternion[3],
      );
    }

    // Check if we have a path
    if (state.fullPath.length === 0) {
      // No path - check if we need to smoothly sync to server position
      const visualTile = worldToTile(
        state.visualPosition.x,
        state.visualPosition.z,
      );
      const dist = this.tileDistance(visualTile, serverTile);

      if (dist <= 0.1) {
        // Already at server tile - just sync Y and stop
        const tileCenter = tileToWorld(serverTile);
        state.visualPosition.x = tileCenter.x;
        state.visualPosition.z = tileCenter.z;
        state.visualPosition.y = worldPos.y;
        state.targetWorldPos.copy(state.visualPosition);
        state.isMoving = false;
      } else {
        // Not at server tile - create synthetic path for smooth interpolation
        const serverTileCenter = tileToWorld(serverTile);
        state.fullPath = [{ ...serverTile }];
        state.targetTileIndex = 0;
        state.destinationTile = { ...serverTile };
        state.targetWorldPos.set(
          serverTileCenter.x,
          worldPos.y,
          serverTileCenter.z,
        );
        state.isMoving = true;
        state.serverConfirmedY = worldPos.y;

        // Use catch-up multiplier based on distance for smooth but quick sync
        const rawMultiplier = 1.0 + (dist - 1) * 0.6;
        state.targetCatchUpMultiplier = Math.min(rawMultiplier, 2.0);

        if (this.debugMode) {
          console.log(
            `[TileInterpolator] No path but desynced by ${dist.toFixed(1)} tiles, interpolating to (${serverTile.x},${serverTile.z})`,
          );
        }
      }
      return;
    }

    // Find where the server tile is in our path
    const serverTileInPath = state.fullPath.findIndex((t) =>
      tilesEqual(t, serverTile),
    );

    // Get visual tile for sync calculations
    const visualTile = worldToTile(
      state.visualPosition.x,
      state.visualPosition.z,
    );

    if (serverTileInPath >= 0) {
      // Server confirms a tile in our path - check if we're in sync
      const visualTileInPath = state.fullPath.findIndex((t) =>
        tilesEqual(t, visualTile),
      );

      // Calculate how far ahead/behind we are
      // FIX: When visualTile is not in path (index -1), calculate actual distance
      // to avoid incorrect tileDiff calculation (e.g., 1 - (-1) = 2 when actually 3+ behind)
      let tileDiff: number;
      if (visualTileInPath === -1) {
        // Visual tile not in path - calculate actual distance from visual to server
        // This happens when new path doesn't include tiles the client hasn't reached yet
        const actualDist = this.tileDistance(visualTile, serverTile);
        tileDiff = actualDist;
        if (this.debugMode) {
          console.log(
            `[TileInterpolator] Visual tile (${visualTile.x},${visualTile.z}) not in path, using actual distance ${actualDist} to server tile (${serverTile.x},${serverTile.z})`,
          );
        }
      } else {
        tileDiff = serverTileInPath - visualTileInPath;
      }

      if (this.debugMode && Math.abs(tileDiff) > 1) {
        console.log(
          `[TileInterpolator] Sync check: visual at path[${visualTileInPath}], server at path[${serverTileInPath}], diff=${tileDiff}`,
        );
      }

      // SMOOTH SYNC: Use speed multiplier to stay in sync with server
      // - Behind (tileDiff > 0): speed up to catch up
      // - Ahead (tileDiff < 0): slow down to let server catch up
      // This prevents visual "jumping" while keeping client in sync
      if (tileDiff > 2) {
        // Behind by more than 2 tiles - use progressive speed boost
        // Formula: 1.0 + (tileDiff - 2) * 0.5, capped at 4.0x for very large desyncs
        // 3 tiles behind = 1.5x, 6 tiles = 3.0x, 10+ tiles = 4.0x (max)
        const rawMultiplier = 1.0 + (tileDiff - 2) * 0.5;
        state.targetCatchUpMultiplier = Math.min(rawMultiplier, 2.0);
        if (this.debugMode) {
          console.log(
            `[TileInterpolator] Behind by ${tileDiff} tiles, speeding up to ${state.targetCatchUpMultiplier.toFixed(2)}x`,
          );
        }
      } else if (tileDiff < -2) {
        // Ahead by more than 2 tiles - slow down to let server catch up
        // Formula: 1.0 - (|tileDiff| - 2) * 0.2, capped at 0.3x minimum (don't freeze)
        // 3 tiles ahead = 0.8x, 5 tiles = 0.4x, 6+ tiles = 0.3x (min)
        const aheadBy = Math.abs(tileDiff);
        const rawMultiplier = 1.0 - (aheadBy - 2) * 0.2;
        state.targetCatchUpMultiplier = Math.max(rawMultiplier, 0.3);
        if (this.debugMode) {
          console.log(
            `[TileInterpolator] Ahead by ${aheadBy} tiles, slowing to ${state.targetCatchUpMultiplier.toFixed(2)}x`,
          );
        }
      } else {
        // IN SYNC (-2 <= tileDiff <= 2): Smoothly return to normal speed
        state.targetCatchUpMultiplier = 1.0;
      }

      // Update Y position from server (terrain height)
      state.targetWorldPos.y = worldPos.y;
    } else {
      // Server tile not in our path - path might have changed
      // Check distance to see if it's a desync or new path
      const dist = this.tileDistance(visualTile, serverTile);

      // Check if we have an active path
      const hasActivePath =
        state.fullPath.length > 0 &&
        state.targetTileIndex < state.fullPath.length;

      if (dist > 1 && !hasActivePath) {
        // Desync while stationary - create synthetic path toward server position
        // instead of snapping. This provides smooth interpolation for any desync.
        const serverTileCenter = tileToWorld(serverTile);

        // Set up a direct path to server position (just the destination tile)
        state.fullPath = [{ ...serverTile }];
        state.targetTileIndex = 0;
        state.destinationTile = { ...serverTile };
        state.targetWorldPos.set(
          serverTileCenter.x,
          worldPos.y,
          serverTileCenter.z,
        );
        state.isMoving = true;
        state.serverConfirmedY = worldPos.y;

        // Use aggressive catch-up multiplier based on distance
        // This ensures we reach server position quickly without teleporting
        const rawMultiplier = 1.0 + (dist - 1) * 0.6;
        state.targetCatchUpMultiplier = Math.min(rawMultiplier, 2.0);

        if (this.debugMode || dist > 4) {
          console.log(
            `[TileInterpolator] Desync (${dist} tiles) while stationary, interpolating to server tile (${serverTile.x},${serverTile.z}) at ${state.targetCatchUpMultiplier.toFixed(2)}x speed`,
          );
        }
      } else if (hasActivePath && dist > 2) {
        // Have active path but significant distance from server
        // Determine if we're ahead or behind by comparing progress toward destination
        const destTile =
          state.destinationTile || state.fullPath[state.fullPath.length - 1];
        if (destTile) {
          const visualDistToDest = this.tileDistance(visualTile, destTile);
          const serverDistToDest = this.tileDistance(serverTile, destTile);

          if (visualDistToDest < serverDistToDest - 1) {
            // Client is AHEAD (closer to destination than server)
            // Slow down to let server catch up
            const aheadBy = serverDistToDest - visualDistToDest;
            const rawMultiplier = 1.0 - (aheadBy - 1) * 0.2;
            state.targetCatchUpMultiplier = Math.max(rawMultiplier, 0.3);
            if (this.debugMode) {
              console.log(
                `[TileInterpolator] Ahead by ~${aheadBy.toFixed(1)} tiles (path mismatch), slowing to ${state.targetCatchUpMultiplier.toFixed(2)}x`,
              );
            }
          } else if (visualDistToDest > serverDistToDest + 1) {
            // Client is BEHIND (further from destination than server)
            // Speed up to catch up
            const behindBy = visualDistToDest - serverDistToDest;
            const rawMultiplier = 1.0 + (behindBy - 1) * 0.5;
            state.targetCatchUpMultiplier = Math.min(rawMultiplier, 2.0);
            if (this.debugMode) {
              console.log(
                `[TileInterpolator] Behind by ~${behindBy.toFixed(1)} tiles (path mismatch), speeding to ${state.targetCatchUpMultiplier.toFixed(2)}x`,
              );
            }
          } else {
            // Close enough - normal speed
            state.targetCatchUpMultiplier = 1.0;
          }
        } else {
          // No destination info - use distance-based speed up (assume behind)
          const rawMultiplier = 1.0 + (dist - 2) * 0.5;
          state.targetCatchUpMultiplier = Math.min(rawMultiplier, 2.0);
        }
      }
      // For small distances or when we have an active path with small desync,
      // trust the current path and let normal interpolation handle it
    }
  }

  /**
   * Called when entity arrives at destination
   * IMPORTANT: Don't snap immediately - let interpolation finish naturally
   *
   * @param moveSeq Movement sequence number for packet ordering
   * @param emote Optional emote to use on arrival (bundled from server for atomic delivery)
   */
  onMovementEnd(
    entityId: string,
    tile: TileCoord,
    worldPos: THREE.Vector3,
    moveSeq?: number,
    emote?: string,
  ): void {
    if (this.debugMode) {
      console.log(
        `[TileInterpolator] onMovementEnd: ${entityId} at (${tile.x},${tile.z}), moveSeq=${moveSeq}, emote=${emote}`,
      );
    }

    const state = this.entityStates.get(entityId);
    if (!state) return;

    // Validate moveSeq - ignore stale end packets from previous movements
    if (moveSeq !== undefined && state.moveSeq > moveSeq) {
      if (this.debugMode) {
        console.log(
          `[TileInterpolator] Ignoring stale onMovementEnd: moveSeq ${moveSeq} < current ${state.moveSeq}`,
        );
      }
      return;
    }

    // Store arrival emote so it can be applied when interpolation actually finishes
    // This prevents switching to idle while still moving (short paths can finish fast)
    state.pendingArrivalEmote = emote ?? null;

    // Update server confirmed position and Y (for building floor elevation)
    state.serverConfirmedTile = { ...tile };
    state.serverConfirmedY = worldPos.y;
    state.destinationTile = { ...tile };

    // Update Y from server (includes building floor elevation)
    state.targetWorldPos.y = worldPos.y;
    state.visualPosition.y = worldPos.y;

    // Check if we're still walking toward destination
    const visualTile = worldToTile(
      state.visualPosition.x,
      state.visualPosition.z,
    );
    const distToDestination = this.tileDistance(visualTile, tile);

    if (distToDestination <= 0.1) {
      // Already at destination - snap to exact center and stop
      const tileCenter = tileToWorld(tile);
      state.visualPosition.x = tileCenter.x;
      state.visualPosition.z = tileCenter.z;
      state.targetWorldPos.x = tileCenter.x;
      state.targetWorldPos.z = tileCenter.z;
      state.fullPath = [];
      state.targetTileIndex = 0;
      state.isMoving = false;
      if (state.pendingArrivalEmote) {
        state.emote = state.pendingArrivalEmote;
        state.pendingArrivalEmote = null;
      } else if (
        MOVEMENT_EMOTES.has(state.emote as string | undefined | null)
      ) {
        // No arrival emote - reset to idle if we were in a movement emote
        state.emote = "idle";
      }
      state.catchUpMultiplier = 1.0;
      state.targetCatchUpMultiplier = 1.0;
    } else {
      // Not at destination yet - ensure we have a path to get there
      // Keep walking animation until we actually arrive

      // Check if destination is in our current path
      const destInPath = state.fullPath.findIndex((t) => tilesEqual(t, tile));

      if (destInPath >= 0 && destInPath >= state.targetTileIndex) {
        // Destination is ahead of us in path - trim to it
        state.fullPath = state.fullPath.slice(0, destInPath + 1);
      } else if (destInPath >= 0 && destInPath < state.targetTileIndex) {
        // We've already passed the destination in our path (edge case)
        // Server is authoritative - just path directly to destination
        // Catch-up multiplier handles smooth movement
        state.fullPath = [{ ...tile }];
        state.targetTileIndex = 0;
      } else if (state.fullPath.length > 0) {
        // Destination not in path - append it
        state.fullPath.push({ ...tile });
      } else {
        // No path at all - go directly to destination
        // Server is authoritative - no client path calculation
        state.fullPath = [{ ...tile }];
        state.targetTileIndex = 0;
      }

      // Ensure targetTileIndex is valid
      if (state.targetTileIndex >= state.fullPath.length) {
        state.targetTileIndex = Math.max(0, state.fullPath.length - 1);
      }

      // Keep moving and keep current animation (walk/run)
      state.isMoving = true;
      // Don't change emote - keep walking/running

      if (this.debugMode) {
        console.log(
          `[TileInterpolator] Still walking, ${distToDestination.toFixed(1)} tiles from destination, path length: ${state.fullPath.length}`,
        );
      }
    }
  }

  /**
   * Update visual positions for all entities
   * This is the main movement driver - walks through path at fixed speed
   *
   * @param deltaTime - Time since last frame in seconds
   * @param getEntity - Function to get entity by ID
   * @param getTerrainHeight - Optional function to get terrain height at X/Z (for smooth Y)
   * @param onMovementComplete - Optional callback when an entity finishes moving (arrives at destination)
   * @param isNearBuilding - Optional function to check if position is near a building (preserve server Y for elevation)
   * @param getStepHeight - Optional function to get entrance step height at X/Z (for smooth stair walking)
   * @param hasTimeRemaining - Optional frame-budget callback to stop work when frame is over budget
   */
  update(
    deltaTime: number,
    getEntity: (id: string) =>
      | {
          position: THREE.Vector3;
          node?: THREE.Object3D;
          base?: THREE.Object3D;
          data: Record<string, unknown>;
          // modify() is needed to trigger PlayerLocal's emote handling (avatar animation)
          modify: (data: Record<string, unknown>) => void;
        }
      | undefined,
    getTerrainHeight?: (
      x: number,
      z: number,
      entityId: string,
    ) => number | null,
    onMovementComplete?: (
      entityId: string,
      position: { x: number; y: number; z: number },
    ) => void,
    isNearBuilding?: (x: number, z: number) => boolean,
    getStepHeight?: (x: number, z: number, entityId: string) => number | null,
    hasTimeRemaining?: (minimumMs?: number) => boolean,
  ): void {
    const frameDelta =
      Number.isFinite(deltaTime) && deltaTime > 0 ? deltaTime : 0;
    this.simulationTime += frameDelta;

    // OPTIMIZATION: Use cached array to avoid Map->Array conversion each frame
    if (this._entityArrayDirty) {
      this._entityStateArray.length = 0;
      for (const entry of this.entityStates.entries()) {
        this._entityStateArray.push(entry);
      }
      this._entityArrayDirty = false;
      this._entityRotationIndex = 0;
    }

    const statesArray = this._entityStateArray;
    const totalStates = statesArray.length;
    if (totalStates === 0) return;

    // Process up to configured cap using round-robin
    const maxToProcess = Math.min(this.maxEntitiesPerFrame, totalStates);
    let processed = 0;
    const startIndex = this._entityRotationIndex % totalStates;
    let i = startIndex;

    do {
      if (processed >= maxToProcess) break;
      if (
        hasTimeRemaining &&
        processed > 0 &&
        processed % this.budgetCheckInterval === 0 &&
        !hasTimeRemaining(1)
      ) {
        break;
      }

      const [entityId, state] = statesArray[i];
      const entity = getEntity(entityId);

      i = (i + 1) % totalStates;

      if (!entity) continue;

      const elapsedSinceLastProcess = Math.max(
        0,
        this.simulationTime - state.lastProcessedTime,
      );
      const effectiveDelta =
        elapsedSinceLastProcess > 0 ? elapsedSinceLastProcess : frameDelta;
      state.lastProcessedTime = this.simulationTime;

      // No path or finished path - just ensure position is synced
      if (
        state.fullPath.length === 0 ||
        state.targetTileIndex >= state.fullPath.length
      ) {
        // Combat-facing updates also arrive while the entity is stationary.
        // Previously setCombatRotation snapped both quaternions immediately and
        // this early-return branch never ran the movement slerp, so every target
        // change could visibly pop. Use the same bounded turn path as movement.
        this.smoothRotation(state, effectiveDelta);

        // Update Y: building floor > entrance steps > terrain
        // Check if near building - if so, preserve server Y (correct floor elevation)
        const inBuilding =
          isNearBuilding &&
          isNearBuilding(state.visualPosition.x, state.visualPosition.z);

        if (inBuilding) {
          // In building - preserve server Y (floor elevation set by server)
          const serverY = state.serverConfirmedY ?? state.visualPosition.y;
          state.visualPosition.y = serverY;
        } else if (getStepHeight) {
          // Check if on entrance steps (smooth stair walking)
          const stepY = getStepHeight(
            state.visualPosition.x,
            state.visualPosition.z,
            entityId,
          );
          if (stepY !== null && Number.isFinite(stepY)) {
            state.visualPosition.y = stepY;
          } else if (getTerrainHeight) {
            // Not on steps - use terrain height
            const height = getTerrainHeight(
              state.visualPosition.x,
              state.visualPosition.z,
              entityId,
            );
            if (height !== null && Number.isFinite(height)) {
              state.visualPosition.y = height; // Feet at ground level
            }
          }
        } else if (getTerrainHeight) {
          // No step height function - use terrain height
          const height = getTerrainHeight(
            state.visualPosition.x,
            state.visualPosition.z,
            entityId,
          );
          if (height !== null && Number.isFinite(height)) {
            state.visualPosition.y = height; // Feet at ground level
          }
        }
        entity.position.copy(state.visualPosition);
        // Also sync to node.position if available (for PlayerRemote compatibility)
        if (entity.node && "position" in entity.node) {
          (entity.node as THREE.Object3D).position.copy(state.visualPosition);
        }
        // CRITICAL: Also sync base.position for PlayerRemote avatar positioning
        // PlayerRemote.update() uses base.matrixWorld for instance.move() which positions the avatar
        if (entity.base && "position" in entity.base) {
          (entity.base as THREE.Object3D).position.copy(state.visualPosition);
        }
        // Keep the flag set so PlayerRemote doesn't overwrite
        entity.data.tileInterpolatorControlled = true;
        // Set rotation: Use base for players, fall back to node for mobs
        if (state.quaternion) {
          if (entity.base) {
            // Players: VRM models have 180° rotation baked in, base.quaternion adds to that
            entity.base.quaternion.copy(state.quaternion);
          } else if (entity.node && "quaternion" in entity.node) {
            // Mobs/other entities: Set rotation directly on node
            (entity.node as THREE.Object3D).quaternion.copy(state.quaternion);
          }
        }
        // No path = not moving = idle animation
        const wasMoving = state.isMoving;
        state.isMoving = false;
        // Only reset to idle if current emote is a movement emote
        // Don't override special emotes like "chopping", "combat", "death" etc.
        const currentEmote = entity.data?.emote || entity.data?.e;
        if (state.pendingArrivalEmote) {
          state.emote = state.pendingArrivalEmote;
          state.pendingArrivalEmote = null;
          // Use modify() to trigger PlayerLocal's emote handling which updates avatar animation
          entity.modify({ e: state.emote });
        } else if (
          MOVEMENT_EMOTES.has(currentEmote as string | undefined | null)
        ) {
          state.emote = "idle";
          // Use modify() to trigger PlayerLocal's emote handling which updates avatar animation
          entity.modify({ e: "idle" });
        }
        entity.data.tileMovementActive = false; // Not moving - allow combat rotation

        // Notify when entity finishes moving (transitions from moving to idle)
        // This enables event-based interaction systems (e.g., InteractionSystem pending NPC)
        if (wasMoving && onMovementComplete) {
          onMovementComplete(entityId, {
            x: state.visualPosition.x,
            y: state.visualPosition.y,
            z: state.visualPosition.z,
          });
        }
        continue;
      }

      // Smooth catch-up multiplier toward target (prevents jarring speed changes)
      // Uses exponential smoothing with rate limiting for consistent feel across frame rates
      if (state.catchUpMultiplier !== state.targetCatchUpMultiplier) {
        const diff = state.targetCatchUpMultiplier - state.catchUpMultiplier;

        // Exponential smoothing: alpha = 1 - e^(-dt * rate)
        // This is frame-rate independent - same behavior at 30fps or 144fps
        const alpha = 1 - Math.exp(-effectiveDelta * CATCHUP_SMOOTHING_RATE);
        let change = diff * alpha;

        // Rate limit: cap maximum change per frame to prevent jarring jumps during lag spikes
        const maxChange = CATCHUP_MAX_CHANGE_PER_SEC * effectiveDelta;
        if (Math.abs(change) > maxChange) {
          change = Math.sign(change) * maxChange;
        }

        state.catchUpMultiplier += change;

        // Snap when very close to avoid floating point drift
        if (Math.abs(diff) < 0.01) {
          state.catchUpMultiplier = state.targetCatchUpMultiplier;
        }
      }

      // Movement speed and total movement budget for this frame
      // Apply catch-up multiplier to move faster when behind server
      // Use per-entity tilesPerTick if set (for mobs with custom speed), else default walk/run speed
      const baseSpeed =
        state.tilesPerTick !== null
          ? state.tilesPerTick / (TICK_DURATION_MS / 1000) // Convert tiles/tick to tiles/sec
          : state.isRunning
            ? RUN_SPEED
            : WALK_SPEED;
      const speed = baseSpeed * state.catchUpMultiplier;
      let remainingMove = speed * effectiveDelta;

      // Process movement, potentially crossing multiple tiles in one frame
      // This prevents "stuttering" at high speeds or low frame rates
      while (
        remainingMove > 0 &&
        state.targetTileIndex < state.fullPath.length
      ) {
        // Get current target tile
        const targetTile = state.fullPath[state.targetTileIndex];
        const targetWorld = tileToWorld(targetTile);
        state.targetWorldPos.x = targetWorld.x;
        state.targetWorldPos.z = targetWorld.z;
        // Note: Y is updated from server updates (terrain height)

        // Skip tiles that are BEHIND the visual position (prevents backward movement)
        // This happens when server's path starts from a position behind the client's visual position
        // due to network latency during spam clicking.
        //
        // IMPORTANT: Only skip when the path is locally straight. On paths that turn
        // (e.g. bridge endpoint routing), intermediate tiles are in the "wrong" direction
        // relative to the final destination but MUST be walked through. We verify that
        // the NEXT tile after the skip candidate is in roughly the same direction as the
        // destination — if not, the path is turning and we must not skip.
        if (
          state.destinationTile &&
          state.targetTileIndex < state.fullPath.length - 1
        ) {
          // OPTIMIZATION: tileToWorldInto reuses pre-allocated object, no heap allocation
          tileToWorldInto(state.destinationTile, this._destWorldPos);
          const toTargetX = state.targetWorldPos.x - state.visualPosition.x;
          const toTargetZ = state.targetWorldPos.z - state.visualPosition.z;
          const toDestX = this._destWorldPos.x - state.visualPosition.x;
          const toDestZ = this._destWorldPos.z - state.visualPosition.z;

          // Dot product: if negative, target tile is behind us relative to destination
          const dot = toTargetX * toDestX + toTargetZ * toDestZ;
          // OPTIMIZATION: compare squared distance (avoids sqrt in hot path)
          const distToTargetSq = toTargetX * toTargetX + toTargetZ * toTargetZ;

          // Skip if target is behind us AND not very close (avoid skipping near-destination tiles)
          if (dot < 0 && distToTargetSq > TILE_SKIP_THRESHOLD_SQ) {
            // Safety: only skip if the NEXT tile in the path continues toward the
            // destination (path is locally straight). If the next tile is in a
            // different direction, the path is turning and we must not skip.
            const nextIdx = state.targetTileIndex + 1;
            if (nextIdx < state.fullPath.length) {
              const nextTile = state.fullPath[nextIdx];
              const nextWorld = tileToWorld(nextTile);
              const nextToDestX = this._destWorldPos.x - nextWorld.x;
              const nextToDestZ = this._destWorldPos.z - nextWorld.z;
              // Direction from current target to next tile
              const segDx = nextWorld.x - state.targetWorldPos.x;
              const segDz = nextWorld.z - state.targetWorldPos.z;
              // If the segment from target→next doesn't point toward the destination,
              // the path is turning — don't skip
              const segDot = segDx * nextToDestX + segDz * nextToDestZ;
              if (segDot <= 0) {
                // Path turns here — do NOT skip this tile
              } else {
                state.targetTileIndex++;
                continue; // Re-evaluate with next tile
              }
            } else {
              state.targetTileIndex++;
              continue; // Re-evaluate with next tile
            }
          }
        }

        // Calculate distance to target
        const dx = state.targetWorldPos.x - state.visualPosition.x;
        const dz = state.targetWorldPos.z - state.visualPosition.z;
        // OPTIMIZATION: use squared distance to defer sqrt until we actually need it
        const distSq = dx * dx + dz * dz;
        // Arrived if very close (thresh²) OR movement budget covers the remaining distance (rem²≥dist²)
        const arrived =
          distSq <= TILE_ARRIVAL_THRESHOLD_SQ ||
          remainingMove * remainingMove >= distSq;
        // Only pay for sqrt when we know we're arriving (avoids sqrt every iteration)
        const dist = arrived ? Math.sqrt(distSq) : 0;

        if (arrived) {
          // Arrived at current target tile - snap to tile center and advance
          state.visualPosition.x = state.targetWorldPos.x;
          state.visualPosition.z = state.targetWorldPos.z;
          // Y will be set from terrain at end of loop

          // Subtract the distance we traveled from our movement budget
          remainingMove -= dist;
          state.targetTileIndex++;

          if (this.debugMode) {
            console.log(
              `[TileInterpolator] ${entityId} reached tile ${state.targetTileIndex - 1}/${state.fullPath.length}`,
            );
          }

          // Check if there's a next tile
          if (state.targetTileIndex < state.fullPath.length) {
            // Only update movement rotation if NOT in combat rotation mode
            // When in combat, entity should keep facing their target, not their movement direction
            if (!state.inCombatRotation) {
              // Calculate rotation to face next tile (only update if distance is sufficient)
              const nextTile = state.fullPath[state.targetTileIndex];
              const nextWorld = tileToWorld(nextTile);
              // Use pre-allocated Vector3 to avoid per-frame allocations
              this._nextPos.set(
                nextWorld.x,
                state.visualPosition.y,
                nextWorld.z,
              );
              const nextRotation = this.calculateFacingRotation(
                state.visualPosition,
                this._nextPos,
              );
              if (nextRotation) {
                // Only update rotation if direction changed significantly (>~16°)
                // This prevents micro-pivots during nearly-straight movement
                // Quaternion dot product: |dot| > 0.99 means angle < ~16°
                const dot = Math.abs(state.targetQuaternion.dot(nextRotation));
                if (dot < 0.99) {
                  state.targetQuaternion.copy(nextRotation);
                }
              }
            }
            // Continue loop to use remaining movement toward next tile
          } else {
            // Finished path - snap to destination tile center
            // Use destinationTile (authoritative from server) if available, otherwise use last path tile
            const finalTile =
              state.destinationTile ||
              state.fullPath[state.fullPath.length - 1];
            const finalWorld = tileToWorld(finalTile);
            state.visualPosition.x = finalWorld.x;
            state.visualPosition.z = finalWorld.z;
            const wasMoving = state.isMoving;
            state.isMoving = false;
            if (state.pendingArrivalEmote) {
              state.emote = state.pendingArrivalEmote;
              state.pendingArrivalEmote = null;
            } else if (
              MOVEMENT_EMOTES.has(state.emote as string | undefined | null)
            ) {
              // Only track idle state if current emote is movement-related
              // (actual emote change is handled in the empty path block above)
              state.emote = "idle";
            }
            state.destinationTile = null; // Clear destination as we've arrived
            state.catchUpMultiplier = 1.0;
            state.targetCatchUpMultiplier = 1.0;
            remainingMove = 0; // Stop processing

            // Notify when entity finishes walking path (arrives at destination)
            if (wasMoving && onMovementComplete) {
              onMovementComplete(entityId, {
                x: state.visualPosition.x,
                y: state.visualPosition.y,
                z: state.visualPosition.z,
              });
            }
          }
        } else {
          // Move toward target, consuming all remaining movement
          // OPTIMIZATION: divideScalar(sqrt(distSq)) avoids a second sqrt vs .normalize()
          this._tempDir.set(dx, 0, dz).divideScalar(Math.sqrt(distSq));
          state.visualPosition.x += this._tempDir.x * remainingMove;
          state.visualPosition.z += this._tempDir.z * remainingMove;
          // Y will be set from terrain at end of loop

          // NOTE: Removed mid-tile rotation update (2.4 Only Rotate on Tile Transitions)
          // Rotation is only updated when reaching tile boundaries, not every frame.
          // This prevents micro-pivots from floating point variations during movement.
          // The initial rotation (set in onMovementStart) faces the destination,
          // and tile transition rotation (above) handles direction changes at turns.

          remainingMove = 0; // All movement consumed
        }
      }

      // Update Y: building floor > entrance steps > terrain
      // Check if near building - if so, preserve server Y (correct floor elevation)
      const inBuilding =
        isNearBuilding &&
        isNearBuilding(state.visualPosition.x, state.visualPosition.z);

      if (inBuilding) {
        // In building - preserve server Y (floor elevation set by server)
        const serverY = state.serverConfirmedY ?? state.visualPosition.y;
        state.visualPosition.y = serverY;
      } else if (getStepHeight) {
        // Check if on entrance steps (smooth stair walking)
        const stepY = getStepHeight(
          state.visualPosition.x,
          state.visualPosition.z,
          entityId,
        );
        if (stepY !== null && Number.isFinite(stepY)) {
          state.visualPosition.y = stepY;
        } else if (getTerrainHeight) {
          // Not on steps - use terrain height for smooth ground following
          const height = getTerrainHeight(
            state.visualPosition.x,
            state.visualPosition.z,
            entityId,
          );
          if (height !== null && Number.isFinite(height)) {
            state.visualPosition.y = height; // Feet at ground level
          }
        }
      } else if (getTerrainHeight) {
        // No step height function - use terrain height for smooth ground following
        const height = getTerrainHeight(
          state.visualPosition.x,
          state.visualPosition.z,
          entityId,
        );
        if (height !== null && Number.isFinite(height)) {
          state.visualPosition.y = height; // Feet at ground level
        }
      }

      // Smoothly turn along the shortest quaternion arc. This is shared with
      // stationary combat facing so movement/attack transitions cannot snap.
      this.smoothRotation(state, effectiveDelta);

      // Apply visual state to entity
      entity.position.copy(state.visualPosition);
      // Also sync to node.position if available (for PlayerRemote compatibility)
      if (entity.node && "position" in entity.node) {
        (entity.node as THREE.Object3D).position.copy(state.visualPosition);
      }
      // CRITICAL: Also sync base.position for PlayerRemote avatar positioning
      // PlayerRemote.update() uses base.matrixWorld for instance.move() which positions the avatar
      if (entity.base && "position" in entity.base) {
        (entity.base as THREE.Object3D).position.copy(state.visualPosition);
      }
      // Mark entity as controlled by tile interpolator to prevent other systems from overwriting
      entity.data.tileInterpolatorControlled = true;
      // Expose isMoving so PlayerLocal/PlayerRemote can check for combat rotation
      // classic MMORPG behavior: only face combat target when standing still, not while moving
      entity.data.tileMovementActive = state.isMoving;
      // Set rotation: Use base for players (VRM has 180° rotation baked in),
      // fall back to node for mobs/other entities that don't have base
      if (entity.base) {
        // Players: Set rotation on base (VRM models have 180° rotation baked in, base.quaternion adds to that)
        entity.base.quaternion.copy(state.quaternion);
      } else if (entity.node && "quaternion" in entity.node) {
        // Mobs/other entities: Set rotation directly on node
        (entity.node as THREE.Object3D).quaternion.copy(state.quaternion);
      }
      // Use modify() to trigger PlayerLocal's emote handling which updates avatar animation
      // For other entities (PlayerRemote, MobEntity), modify() just does Object.assign to data
      entity.modify({ e: state.emote });

      if (this.debugMode && Math.random() < 0.01) {
        console.log(
          `[TileInterpolator] ${entityId}: tile ${state.targetTileIndex}/${state.fullPath.length}`,
        );
      }

      processed++;
    } while (i !== startIndex && processed < maxToProcess);

    // Save rotation index for next frame
    this._entityRotationIndex = i;
  }

  /**
   * Check if an entity has an active interpolation state
   */
  hasState(entityId: string): boolean {
    return this.entityStates.has(entityId);
  }

  /**
   * Check if an entity is currently moving
   */
  isInterpolating(entityId: string): boolean {
    const state = this.entityStates.get(entityId);
    return state ? state.isMoving : false;
  }

  /**
   * Get current visual position for an entity
   */
  getVisualPosition(entityId: string): THREE.Vector3 | null {
    const state = this.entityStates.get(entityId);
    return state ? state.visualPosition.clone() : null;
  }

  /**
   * Remove interpolation state for an entity
   */
  removeEntity(entityId: string): void {
    this.deleteEntityState(entityId);
  }

  /**
   * Stop all movement for an entity (e.g., on death)
   *
   * Clears the movement path and resets to idle emote.
   * Used when an entity dies to prevent continued movement after death.
   *
   * @param entityId - Entity to stop
   * @param position - Optional position to snap to (e.g., death position)
   */
  stopMovement(
    entityId: string,
    position?: { x: number; y: number; z: number },
  ): void {
    const state = this.entityStates.get(entityId);
    if (!state) return;

    // Clear movement path
    state.fullPath = [];
    state.targetTileIndex = 0;
    state.isMoving = false;

    // Snap to position if provided
    if (position) {
      state.visualPosition.set(position.x, position.y, position.z);
      state.targetWorldPos.set(position.x, position.y, position.z);
    }
  }

  /**
   * Set combat rotation for an entity (AAA Single Source of Truth)
   *
   * When combat rotation arrives via entityModified, it should be routed here
   * so TileInterpolator maintains ownership of all rotation. This prevents
   * race conditions where multiple systems try to set rotation.
   *
   * Combat rotation is applied immediately when:
   * 1. Entity has TileInterpolator state
   * 2. Entity is NOT currently moving (standing still in combat)
   *
   * Combat rotation is now applied even during movement - the entity will
   * face their combat target while moving (classic MMORPG PvP behavior).
   *
   * @param entityId - Entity to update
   * @param quaternion - Combat rotation as [x, y, z, w] array or THREE.Quaternion
   * @returns true if rotation was applied, false if entity has no state
   */
  setCombatRotation(
    entityId: string,
    quaternion: number[] | THREE.Quaternion,
    entityPosition?: { x: number; y: number; z: number },
    lockTarget = false,
  ): boolean {
    let state = this.entityStates.get(entityId);
    const createdState = !state;

    if (state?.combatRotationLocked && !lockTarget) {
      return true;
    }

    // Create minimal state if it doesn't exist (fixes first-attack rotation issue)
    // CRITICAL: Use entity's current position to initialize visualPosition.
    // Previously defaulted to (0,0,0) which caused mobs to teleport to world origin
    // when the first entityModified packet with rotation arrived before any tile movement.
    if (!state) {
      const initPos = entityPosition
        ? new THREE.Vector3(
            entityPosition.x,
            entityPosition.y,
            entityPosition.z,
          )
        : new THREE.Vector3();
      const initTile = entityPosition
        ? worldToTile(entityPosition.x, entityPosition.z)
        : { x: 0, z: 0 };

      state = {
        fullPath: [],
        targetTileIndex: 0,
        destinationTile: null,
        visualPosition: initPos,
        targetWorldPos: initPos.clone(),
        quaternion: new THREE.Quaternion(),
        targetQuaternion: new THREE.Quaternion(),
        isRunning: false,
        isMoving: false,
        emote: "idle",
        pendingArrivalEmote: null,
        inCombatRotation: false,
        combatRotationLocked: false,
        serverConfirmedTile: initTile,
        serverConfirmedY: initPos.y,
        lastServerTick: 0,
        catchUpMultiplier: 1.0,
        targetCatchUpMultiplier: 1.0,
        moveSeq: 0,
        tilesPerTick: null,
        lastProcessedTime: this.simulationTime,
      };
      this.setEntityState(entityId, state);
    }

    // Combat-facing packets remain authoritative while the fighter is moving.
    // This is what lets a ranged or magic contestant strafe/kite without
    // visually turning its back on the opponent. Movement starts still clear
    // this mode, and the next combat-facing packet reasserts it for the active
    // engagement.
    state.inCombatRotation = true;
    state.combatRotationLocked = lockTarget;

    // Update only the target on an existing rendered state. The normal update
    // loop advances the visible quaternion with bounded, frame-rate-independent
    // slerp; copying both values here caused stationary combat target switches
    // to snap. A newly created state has no owned visual orientation yet, so it
    // may initialize at the authoritative facing without inventing a turn from
    // world-forward.
    if (Array.isArray(quaternion)) {
      state.targetQuaternion.set(
        quaternion[0],
        quaternion[1],
        quaternion[2],
        quaternion[3],
      );
    } else {
      state.targetQuaternion.copy(quaternion);
    }
    if (createdState) {
      state.quaternion.copy(state.targetQuaternion);
    }

    return true; // Rotation accepted
  }

  /**
   * Clear combat rotation mode for an entity
   * Called when combat ends to allow movement rotation to resume
   */
  clearCombatRotation(entityId: string): void {
    const state = this.entityStates.get(entityId);
    if (state) {
      state.inCombatRotation = false;
      state.combatRotationLocked = false;
    }
  }

  /**
   * Sync entity position after teleport/respawn
   *
   * Resets the entity's movement state to a new position, clearing any pending
   * path and setting the visual position to the new location. Used when a player
   * respawns or is teleported to prevent stale movement state.
   *
   * @param entityId - Entity to sync
   * @param position - New world position
   */
  syncPosition(
    entityId: string,
    position: { x: number; y: number; z: number },
  ): void {
    const newTile = worldToTile(position.x, position.z);
    const worldPos = tileToWorld(newTile);

    // Get existing state or create minimal new state
    let state = this.entityStates.get(entityId);
    if (state) {
      // Reset existing state to new position
      state.fullPath = [];
      state.targetTileIndex = 0;
      state.destinationTile = null;
      state.visualPosition.set(worldPos.x, position.y, worldPos.z);
      state.targetWorldPos.set(worldPos.x, position.y, worldPos.z);
      state.serverConfirmedTile = { ...newTile };
      state.serverConfirmedY = position.y;
      state.isMoving = false;
      state.pendingArrivalEmote = null;
      // Only track idle state if current emote is movement-related
      if (MOVEMENT_EMOTES.has(state.emote as string | undefined | null)) {
        state.emote = "idle";
      }
      state.catchUpMultiplier = 1.0;
      state.targetCatchUpMultiplier = 1.0;
      // CRITICAL: Reset moveSeq to 0 instead of incrementing
      // Server cleanup() deletes state and creates new with moveSeq=0
      // If we increment, client's moveSeq can become higher than server's
      // causing movement packets to be ignored as "stale"
      state.moveSeq = 0;
      state.lastProcessedTime = this.simulationTime;
    } else {
      // No existing state - create fresh state at new position
      state = {
        fullPath: [],
        targetTileIndex: 0,
        destinationTile: null,
        visualPosition: new THREE.Vector3(worldPos.x, position.y, worldPos.z),
        targetWorldPos: new THREE.Vector3(worldPos.x, position.y, worldPos.z),
        quaternion: new THREE.Quaternion(),
        targetQuaternion: new THREE.Quaternion(),
        isRunning: false,
        isMoving: false,
        emote: "idle",
        pendingArrivalEmote: null,
        inCombatRotation: false,
        combatRotationLocked: false,
        serverConfirmedTile: { ...newTile },
        serverConfirmedY: position.y, // Preserve initial Y (floor elevation)
        lastServerTick: 0,
        catchUpMultiplier: 1.0,
        targetCatchUpMultiplier: 1.0,
        moveSeq: 0,
        tilesPerTick: null,
        lastProcessedTime: this.simulationTime,
      };
      this.setEntityState(entityId, state);
    }
  }

  /**
   * Clear all interpolation states
   */
  clear(): void {
    this.entityStates.clear();
    this._entityArrayDirty = true;
    this.simulationTime = 0;
  }

  /**
   * Enable or disable debug logging
   */
  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }
}
