/**
 * ArenaPoolManager
 *
 * Manages a pool of duel arenas for player dueling.
 *
 * Responsibilities:
 * - Track which arenas are in use
 * - Reserve arenas for new duels
 * - Release arenas when duels complete
 * - Provide spawn points and bounds for each arena
 *
 * Arena Layout (classic MMORPG-style):
 * - 6 rectangular arenas arranged in a 2x3 grid
 * - Each arena has 2 spawn points (north and south)
 * - Arena bounds used for movement clamping if noMovement rule
 */

import {
  type Arena,
  type ArenaSpawnPoint,
  type ArenaBounds,
  type ICollisionMatrix,
  CollisionFlag,
  getDuelArenaConfig,
  getDuelArenaGradeHeight,
  DUEL_ARENA_FLOOR_GROUND_OFFSET,
  DUEL_ARENA_FLOOR_SOLID_OFFSET,
  PLAYER_ROOT_CLEARANCE,
} from "@hyperforge/shared";

// ============================================================================
// Types
// ============================================================================

interface ArenaState {
  arena: Arena;
  currentDuelId: string | null;
}

/**
 * Generate arena configuration for a given arena ID (1-6)
 * Uses manifest-driven config from getDuelArenaConfig()
 */
function generateArenaConfig(arenaId: number): Arena {
  const config = getDuelArenaConfig();
  const groundY = getDuelArenaGradeHeight() + DUEL_ARENA_FLOOR_GROUND_OFFSET;
  const rootY =
    getDuelArenaGradeHeight() +
    DUEL_ARENA_FLOOR_SOLID_OFFSET +
    PLAYER_ROOT_CLEARANCE;

  // Calculate row and column based on grid layout
  const row = Math.floor((arenaId - 1) / config.columns);
  const col = (arenaId - 1) % config.columns;

  // Calculate center position
  const centerX =
    config.baseX +
    col * (config.arenaWidth + config.arenaGap) +
    config.arenaWidth / 2;
  const centerZ =
    config.baseZ +
    row * (config.arenaLength + config.arenaGap) +
    config.arenaLength / 2;

  // Calculate bounds
  const bounds: ArenaBounds = {
    min: {
      x: centerX - config.arenaWidth / 2,
      y: groundY - 1,
      z: centerZ - config.arenaLength / 2,
    },
    max: {
      x: centerX + config.arenaWidth / 2,
      y: groundY + 10,
      z: centerZ + config.arenaLength / 2,
    },
  };

  // Spawn on opposite ends: along arena length (±Z) or width (±X)
  const spawnPoints: [ArenaSpawnPoint, ArenaSpawnPoint] =
    config.spawnLayout === "alongWidth"
      ? [
          {
            x: centerX - config.spawnOffset,
            y: rootY,
            z: centerZ,
          },
          {
            x: centerX + config.spawnOffset,
            y: rootY,
            z: centerZ,
          },
        ]
      : [
          { x: centerX, y: rootY, z: centerZ - config.spawnOffset },
          { x: centerX, y: rootY, z: centerZ + config.spawnOffset },
        ];

  return {
    arenaId,
    inUse: false,
    currentDuelId: null,
    spawnPoints,
    bounds,
    center: { x: centerX, z: centerZ },
  };
}

// ============================================================================
// ArenaPoolManager Class
// ============================================================================

export class ArenaPoolManager {
  /** Arena states by ID */
  private arenas: Map<number, ArenaState> = new Map();

  constructor() {
    this.initializeArenas();
  }

  /**
   * Initialize all arenas in the pool
   * Uses arena count from manifest config
   */
  private initializeArenas(): void {
    const config = getDuelArenaConfig();
    for (let i = 1; i <= config.arenaCount; i++) {
      const arena = generateArenaConfig(i);
      this.arenas.set(i, {
        arena,
        currentDuelId: null,
      });
    }
  }

  /**
   * Reserve an available arena for a duel
   * @returns Arena ID if one is available, null otherwise
   */
  reserveArena(duelId: string): number | null {
    for (const [arenaId, state] of this.arenas) {
      if (!state.currentDuelId) {
        state.currentDuelId = duelId;
        state.arena.inUse = true;
        state.arena.currentDuelId = duelId;
        return arenaId;
      }
    }
    return null;
  }

  /**
   * Reserve one exact arena for a named owner.
   *
   * Used for long-lived platform reservations such as the streaming arena.
   * This deliberately does not replace an existing reservation, even when the
   * caller presents the same owner ID: duplicate lifecycle ownership is an
   * initialization error that should remain visible.
   */
  reserveSpecificArena(arenaId: number, duelId: string): boolean {
    const state = this.arenas.get(arenaId);
    if (!state || state.currentDuelId !== null) return false;

    state.currentDuelId = duelId;
    state.arena.inUse = true;
    state.arena.currentDuelId = duelId;
    return true;
  }

  /**
   * Release an arena back to the pool
   */
  releaseArena(arenaId: number): boolean {
    const state = this.arenas.get(arenaId);
    if (!state) return false;

    state.currentDuelId = null;
    state.arena.inUse = false;
    state.arena.currentDuelId = null;
    return true;
  }

  /** Release an arena only when the caller still owns its reservation. */
  releaseSpecificArena(arenaId: number, duelId: string): boolean {
    const state = this.arenas.get(arenaId);
    if (!state || state.currentDuelId !== duelId) return false;

    return this.releaseArena(arenaId);
  }

  /**
   * Release arena by duel ID (when duel ends)
   */
  releaseArenaByDuelId(duelId: string): boolean {
    for (const [arenaId, state] of this.arenas) {
      if (state.currentDuelId === duelId) {
        return this.releaseSpecificArena(arenaId, duelId);
      }
    }
    return false;
  }

  /**
   * Get arena configuration by ID
   */
  getArena(arenaId: number): Arena | undefined {
    return this.arenas.get(arenaId)?.arena;
  }

  /**
   * Get spawn points for an arena
   */
  getSpawnPoints(
    arenaId: number,
  ): [ArenaSpawnPoint, ArenaSpawnPoint] | undefined {
    return this.arenas.get(arenaId)?.arena.spawnPoints;
  }

  /**
   * Get arena bounds for movement clamping
   */
  getArenaBounds(arenaId: number): ArenaBounds | undefined {
    return this.arenas.get(arenaId)?.arena.bounds;
  }

  /**
   * Get arena center position
   */
  getArenaCenter(arenaId: number): { x: number; z: number } | undefined {
    return this.arenas.get(arenaId)?.arena.center;
  }

  /**
   * Check if an arena is available
   */
  isArenaAvailable(arenaId: number): boolean {
    const state = this.arenas.get(arenaId);
    return state ? !state.currentDuelId : false;
  }

  /**
   * Get count of available arenas
   */
  getAvailableCount(): number {
    let count = 0;
    for (const state of this.arenas.values()) {
      if (!state.currentDuelId) count++;
    }
    return count;
  }

  /**
   * Get total number of arenas in the pool
   */
  get totalArenas(): number {
    return this.arenas.size;
  }

  /**
   * Get all arena IDs
   */
  getAllArenaIds(): number[] {
    return Array.from(this.arenas.keys());
  }

  /**
   * Get the duel ID currently using an arena
   */
  getDuelIdForArena(arenaId: number): string | null {
    return this.arenas.get(arenaId)?.currentDuelId ?? null;
  }

  /**
   * Register arena wall collision for all arenas.
   * Blocks the perimeter ring OUTSIDE the arena to prevent entry/exit.
   * Players inside can walk up to the visual wall but not through it.
   *
   * @param collision - The world's collision matrix to register walls with
   */
  registerArenaWallCollision(collision: ICollisionMatrix): void {
    for (const [_arenaId, state] of this.arenas) {
      const bounds = state.arena.bounds;

      // Convert bounds to tile coordinates
      // Use round() for consistent alignment with visual walls
      const minX = Math.round(bounds.min.x);
      const maxX = Math.round(bounds.max.x);
      const minZ = Math.round(bounds.min.z);
      const maxZ = Math.round(bounds.max.z);

      // Block a perimeter ring OUTSIDE the arena
      // This lets players walk up to the visual wall but not through it

      // North wall: one row north (z = minZ - 1)
      for (let x = minX - 1; x <= maxX + 1; x++) {
        collision.addFlags(x, minZ - 1, CollisionFlag.BLOCKED);
      }

      // South wall: one row south (z = maxZ + 1)
      for (let x = minX - 1; x <= maxX + 1; x++) {
        collision.addFlags(x, maxZ + 1, CollisionFlag.BLOCKED);
      }

      // West wall: one column west (x = minX - 1)
      for (let z = minZ; z <= maxZ; z++) {
        collision.addFlags(minX - 1, z, CollisionFlag.BLOCKED);
      }

      // East wall: one column east (x = maxX + 1)
      for (let z = minZ; z <= maxZ; z++) {
        collision.addFlags(maxX + 1, z, CollisionFlag.BLOCKED);
      }
    }

    this.assertArenaWallCollision(collision);
  }

  /**
   * Fail startup closed if the authoritative collision matrix did not retain
   * a complete arena perimeter. Visual/PhysX fences are not sufficient for
   * server-owned agents, whose movement is governed by this tile matrix.
   */
  assertArenaWallCollision(collision: ICollisionMatrix): void {
    const missing: string[] = [];
    let checkedTiles = 0;

    const checkTile = (arenaId: number, x: number, z: number): void => {
      checkedTiles++;
      if (
        !collision.hasFlags(x, z, CollisionFlag.BLOCKED) &&
        missing.length < 12
      ) {
        missing.push(`arena=${arenaId} tile=(${x},${z})`);
      }
    };

    for (const [arenaId, state] of this.arenas) {
      const bounds = state.arena.bounds;
      const minX = Math.round(bounds.min.x);
      const maxX = Math.round(bounds.max.x);
      const minZ = Math.round(bounds.min.z);
      const maxZ = Math.round(bounds.max.z);

      for (let x = minX - 1; x <= maxX + 1; x++) {
        checkTile(arenaId, x, minZ - 1);
        checkTile(arenaId, x, maxZ + 1);
      }
      for (let z = minZ; z <= maxZ; z++) {
        checkTile(arenaId, minX - 1, z);
        checkTile(arenaId, maxX + 1, z);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `[ArenaPoolManager] Authoritative arena collision audit failed (${missing.length} sampled missing of ${checkedTiles} checked perimeter tiles): ${missing.join(
          "; ",
        )}`,
      );
    }
  }
}
