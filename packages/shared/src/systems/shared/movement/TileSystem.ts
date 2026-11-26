/**
 * Tile System
 *
 * Core constants and utilities for classic fantasy MMORPG-style tile-based movement.
 * The game world is divided into discrete tiles, and entities move
 * one tile at a time in sync with server ticks.
 *
 * Key concepts:
 * - TILE_SIZE: World units per tile (1.0 = 1 meter per tile)
 * - TICK_DURATION_MS: Server tick interval (600ms like classic fantasy MMORPG)
 * - Movement happens discretely: 1 tile/tick (walk) or 2 tiles/tick (run)
 * - Client interpolates visually between tile positions
 */

import { COMBAT_CONSTANTS } from "../../../constants/CombatConstants";
import type { EntityID } from "../../../types/core/identifiers";
import type { IEntityOccupancy } from "./EntityOccupancyMap";

/**
 * Core tile system constants
 *
 * classic MMORPG uses 600ms ticks with 1 tile/tick walk, 2 tiles/tick run.
 * We use 2x speed (2/4 tiles per tick) for a snappier modern feel
 * while keeping the tick-based movement system.
 */
export const TILE_SIZE = 1.0; // 1 world unit = 1 tile
export const TICK_DURATION_MS = 600; // 0.6 seconds per server tick
export const TILES_PER_TICK_WALK = 2; // Walking: 2 tiles per tick (2x classic MMORPG)
export const TILES_PER_TICK_RUN = 4; // Running: 4 tiles per tick (2x classic MMORPG)
export const MAX_PATH_LENGTH = 25; // Maximum checkpoint tiles in a path
export const PATHFIND_RADIUS = 128; // BFS search radius in tiles

/**
 * Tile coordinate (always integers)
 * Y is intentionally omitted - tiles are 2D, height comes from terrain
 */
export interface TileCoord {
  x: number; // Integer tile X
  z: number; // Integer tile Z
}

/** Exact non-combat arrival boundary around a centered entity footprint. */
export interface TileInteractionArrival {
  interactionRange: number;
  footprintWidth: number;
  footprintDepth: number;
}

/**
 * Movement state for a single entity
 */
export interface TileMovementState {
  currentTile: TileCoord; // Current tile position
  path: TileCoord[]; // Queue of tiles to walk through
  pathIndex: number; // Current position in path
  isRunning: boolean; // Walk (1 tile/tick) vs Run (2 tiles/tick)
  moveSeq: number; // Movement sequence number (incremented on each new path)
  /**
   * Tile player was on at START of current tick (captured before movement)
   *
   * RULES-ACCURATE: Used by FollowManager for follow mechanic.
   * Following a player means walking to their PREVIOUS tile,
   * creating the characteristic 1-tick trailing effect.
   *
   */
  previousTile: TileCoord | null;

  /**
   * Two-stage building navigation:
   * When clicking inside a building while outside, we first path to the door,
   * then continue to this pending destination once inside.
   */
  pendingDestination?: TileCoord | null;
  pendingBuildingId?: string | null;

  /**
   * Original click destination for path continuation.
   * Set when a new move request is received; cleared when the player reaches
   * the destination or the destination becomes unreachable.
   * Used to seamlessly continue movement when BFS returns a partial path.
   */
  requestedDestination: TileCoord | null;

  /**
   * Optional interaction boundary for the requested non-combat destination.
   * Retained across partial paths and obstruction replans.
   */
  requestedInteractionArrival: TileInteractionArrival | null;

  /**
   * Whether the most recently computed path for this player was partial
   * (BFS hit MAX_BFS_ITERATIONS before reaching the destination).
   * Stored per-player to avoid reading BFSPathfinder.wasLastPathPartial()
   * after other players' paths may have overwritten the shared flag.
   */
  lastPathPartial: boolean;

  /**
   * Whether the server has already pre-computed and sent the next path segment
   * 1 tick early to eliminate the idle gap at segment boundaries.
   * Prevents double-sending when the path-exhaustion block also fires.
   * Cleared on any new move request or respawn/teleport.
   */
  nextSegmentPrecomputed: boolean;
}

/**
 * Tile flags for collision/walkability
 */
export interface TileFlags {
  walkable: boolean; // Can entities stand on this tile?
  blockedNorth: boolean; // Is north edge blocked?
  blockedEast: boolean; // Is east edge blocked?
  blockedSouth: boolean; // Is south edge blocked?
  blockedWest: boolean; // Is west edge blocked?
}

/**
 * Convert world coordinates to tile coordinates
 * Uses floor to ensure consistent tile boundaries
 *
 * NOTE: This allocates a new object. For hot paths, use worldToTileInto().
 */
export function worldToTile(worldX: number, worldZ: number): TileCoord {
  // Validate inputs are finite numbers
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
    throw new Error(
      `[TileSystem] worldToTile called with non-finite coords: (${worldX}, ${worldZ})`,
    );
  }

  return {
    x: Math.floor(worldX / TILE_SIZE),
    z: Math.floor(worldZ / TILE_SIZE),
  };
}

/**
 * Convert world coordinates to tile coordinates (zero-allocation)
 *
 * Writes to an existing TileCoord object to avoid GC pressure in hot paths.
 *
 * @param worldX - World X coordinate
 * @param worldZ - World Z coordinate
 * @param out - Pre-allocated TileCoord to write to
 */
export function worldToTileInto(
  worldX: number,
  worldZ: number,
  out: TileCoord,
): void {
  out.x = Math.floor(worldX / TILE_SIZE);
  out.z = Math.floor(worldZ / TILE_SIZE);
}

/**
 * Convert tile coordinates to world coordinates (tile center)
 * Returns the center of the tile, not the corner
 */
export function tileToWorld(tile: TileCoord): {
  x: number;
  y: number;
  z: number;
} {
  return {
    x: (tile.x + 0.5) * TILE_SIZE,
    y: 0, // Y will be set from terrain height
    z: (tile.z + 0.5) * TILE_SIZE,
  };
}

/**
 * Snap a world position to the center of its containing tile
 *
 * RULES ACCURACY: All interactable objects are tile-aligned in classic MMORPG.
 * This function ensures resources, NPCs, and other objects are positioned
 * at tile centers rather than arbitrary coordinates.
 *
 * Position (15.3, y, -10.7) → (15.5, y, -10.5)
 * Position (0.1, y, 0.9) → (0.5, y, 0.5)
 *
 * @param position - World position to snap
 * @returns Position snapped to tile center (Y unchanged for terrain height)
 */
export function snapToTileCenter(position: {
  x: number;
  y: number;
  z: number;
}): { x: number; y: number; z: number } {
  return {
    x: Math.floor(position.x / TILE_SIZE) * TILE_SIZE + 0.5 * TILE_SIZE,
    y: position.y, // Y unchanged (terrain height)
    z: Math.floor(position.z / TILE_SIZE) * TILE_SIZE + 0.5 * TILE_SIZE,
  };
}

/**
 * Convert tile coordinates to world coordinates (zero-allocation)
 * Writes to an existing object to avoid GC pressure in hot paths.
 *
 * @param tile - Tile coordinates to convert
 * @param out - Pre-allocated object to write to (must have x, y, z properties)
 */
export function tileToWorldInto(
  tile: TileCoord,
  out: { x: number; y: number; z: number },
): void {
  out.x = (tile.x + 0.5) * TILE_SIZE;
  out.y = 0; // Y will be set from terrain height
  out.z = (tile.z + 0.5) * TILE_SIZE;
}

/**
 * Calculate Manhattan distance between two tiles
 * Used for simple distance checks (not pathfinding)
 */
export function tileManhattanDistance(a: TileCoord, b: TileCoord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
}

/**
 * Calculate Chebyshev distance (max of dx, dz)
 * This is the actual "tile distance" for diagonal movement
 */
export function tileChebyshevDistance(a: TileCoord, b: TileCoord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

/**
 * Check if two tile coordinates are equal
 */
export function tilesEqual(a: TileCoord, b: TileCoord): boolean {
  return a.x === b.x && a.z === b.z;
}

/**
 * Check if two tiles are adjacent (Chebyshev distance = 1)
 * This includes diagonal adjacency (8 directions).
 * Used for general "next to each other" checks.
 *
 * classic MMORPG Reference: Entities are considered "in melee range" when adjacent.
 */
export function tilesAdjacent(a: TileCoord, b: TileCoord): boolean {
  const dx = Math.abs(a.x - b.x);
  const dz = Math.abs(a.z - b.z);
  // Adjacent if max distance is 1 and not the same tile
  return dx <= 1 && dz <= 1 && (dx > 0 || dz > 0);
}

/**
 * Check if two tiles are within a given range (Chebyshev distance)
 * Used for ranged/magic combat and general distance checks.
 * NOTE: For melee combat, use tilesWithinMeleeRange() instead!
 *
 * @param a - First tile
 * @param b - Second tile
 * @param rangeTiles - Maximum range in tiles (minimum 1)
 * @returns true if tiles are within range but NOT the same tile
 */
export function tilesWithinRange(
  a: TileCoord,
  b: TileCoord,
  rangeTiles: number,
): boolean {
  const dx = Math.abs(a.x - b.x);
  const dz = Math.abs(a.z - b.z);
  const chebyshevDistance = Math.max(dx, dz);
  // Combat requires being on different tiles (adjacent, not overlapping)
  const effectiveRange = Math.max(1, Math.floor(rangeTiles));
  return chebyshevDistance <= effectiveRange && chebyshevDistance > 0;
}

/**
 * Check if player is within range of ANY tile in a multi-tile footprint.
 *
 * RULES-ACCURATE: Multi-tile objects like furnaces (2x2) can be interacted with
 * from any adjacent tile. The footprint is CENTERED on the target position.
 *
 * For a 2x2 furnace at position (10.5, 10.5):
 * - Center tile: (10, 10)
 * - Footprint offset: floor(2/2) = 1 in each direction
 * - Occupied tiles: (9, 9), (9, 10), (10, 9), (10, 10)
 *
 * Player can interact if they are within `rangeTiles` of ANY of these 4 tiles.
 *
 * @param playerTile - The player's current tile
 * @param centerTile - The center tile of the multi-tile object
 * @param footprintWidth - Width of the footprint in tiles (X-axis)
 * @param footprintDepth - Depth of the footprint in tiles (Z-axis)
 * @param rangeTiles - Maximum range in tiles (minimum 1)
 * @returns true if player is within range of any occupied tile
 */
export function tilesWithinRangeOfFootprint(
  playerTile: TileCoord,
  centerTile: TileCoord,
  footprintWidth: number,
  footprintDepth: number,
  rangeTiles: number,
): boolean {
  const effectiveRange = Math.max(1, Math.floor(rangeTiles));

  // Calculate footprint bounds (centered on center tile)
  const offsetX = Math.floor(footprintWidth / 2);
  const offsetZ = Math.floor(footprintDepth / 2);

  // Check each tile in the footprint
  for (let dx = 0; dx < footprintWidth; dx++) {
    for (let dz = 0; dz < footprintDepth; dz++) {
      const occupiedTile: TileCoord = {
        x: centerTile.x + dx - offsetX,
        z: centerTile.z + dz - offsetZ,
      };

      // Calculate Chebyshev distance from player to this occupied tile
      const distX = Math.abs(playerTile.x - occupiedTile.x);
      const distZ = Math.abs(playerTile.z - occupiedTile.z);
      const chebyshevDistance = Math.max(distX, distZ);

      // Player is in range if within range and not standing on the object
      if (chebyshevDistance <= effectiveRange && chebyshevDistance > 0) {
        return true;
      }
    }
  }

  return false;
}

/**
 * rules-accurate melee range check
 *
 * classic MMORPG melee attack rules (from wiki):
 * - Range 1 (standard melee): CARDINAL ONLY (N/S/E/W) - cannot attack diagonally
 * - Range 2+ (halberd, spear): Can attack diagonally (uses Chebyshev distance)
 * - Salamanders are special: range 1 but CAN attack diagonally (not implemented here)
 *
 * @param attacker - Attacker's tile position
 * @param target - Target's tile position
 * @param meleeRange - Weapon's melee range (1 = standard, 2 = halberd)
 * @returns true if target is within melee attack range
 *
 */
export function tilesWithinMeleeRange(
  attacker: TileCoord,
  target: TileCoord,
  meleeRange: number,
): boolean {
  const dx = Math.abs(attacker.x - target.x);
  const dz = Math.abs(attacker.z - target.z);

  // Range 1 (standard melee): CARDINAL ONLY - no diagonal attacks
  // This is the core classic MMORPG melee mechanic that makes positioning matter
  if (meleeRange === COMBAT_CONSTANTS.MELEE_RANGE_STANDARD) {
    return (dx === 1 && dz === 0) || (dx === 0 && dz === 1);
  }

  // Range 2+ (halberd, spear): Allow diagonal attacks
  // Uses Chebyshev distance, must be within range but not on same tile
  const chebyshevDistance = Math.max(dx, dz);
  const effectiveRange = Math.max(1, Math.floor(meleeRange));
  return chebyshevDistance <= effectiveRange && chebyshevDistance > 0;
}

/**
 * Check if two tiles are cardinally adjacent (Manhattan distance = 1)
 * This is N/S/E/W only, no diagonals.
 * In classic MMORPG, melee attacks are cardinal-only (except salamanders).
 *
 * classic MMORPG Reference: Standard melee can only attack N/S/E/W, not diagonally.
 */
export function tilesCardinallyAdjacent(a: TileCoord, b: TileCoord): boolean {
  const dx = Math.abs(a.x - b.x);
  const dz = Math.abs(a.z - b.z);
  // Cardinal if exactly 1 step in only one axis
  return (dx === 1 && dz === 0) || (dx === 0 && dz === 1);
}

/**
 * Get the best adjacent tile to stand on when attacking a target.
 * Returns the adjacent tile to `target` that is closest to `attacker`.
 * This is used for melee combat positioning - stand next to target, not on it.
 *
 * classic MMORPG Reference: NPCs path to an adjacent tile when chasing for melee combat.
 *
 * @param target - The tile the target is standing on
 * @param attacker - The tile the attacker is currently on
 * @param cardinalOnly - If true, only consider N/S/E/W tiles (classic MMORPG melee behavior)
 * @param isWalkable - Optional function to check if a tile is walkable
 * @returns The best adjacent tile to stand on, or null if none available
 */
export function getBestAdjacentTile(
  target: TileCoord,
  attacker: TileCoord,
  cardinalOnly: boolean = false,
  isWalkable?: (tile: TileCoord) => boolean,
): TileCoord | null {
  // Get candidate tiles (cardinal or all 8 directions)
  const candidates = cardinalOnly
    ? [
        { x: target.x - 1, z: target.z }, // West
        { x: target.x + 1, z: target.z }, // East
        { x: target.x, z: target.z - 1 }, // South
        { x: target.x, z: target.z + 1 }, // North
      ]
    : getAdjacentTiles(target);

  // Filter out unwalkable tiles if isWalkable function provided
  const walkableCandidates = isWalkable
    ? candidates.filter(isWalkable)
    : candidates;

  if (walkableCandidates.length === 0) {
    return null;
  }

  // If attacker is already on one of these tiles, return that tile
  for (const candidate of walkableCandidates) {
    if (tilesEqual(candidate, attacker)) {
      return candidate;
    }
  }

  // Find the candidate closest to the attacker using Chebyshev distance
  let best = walkableCandidates[0];
  let bestDist = tileChebyshevDistance(best, attacker);

  for (let i = 1; i < walkableCandidates.length; i++) {
    const dist = tileChebyshevDistance(walkableCandidates[i], attacker);
    if (dist < bestDist) {
      best = walkableCandidates[i];
      bestDist = dist;
    }
  }

  return best;
}

/**
 * Get the best tile to stand on when attacking a target, respecting combat range.
 * Used for ranged/magic combat. For melee, use getBestMeleeTile() instead!
 *
 * @param target - The tile the target is standing on
 * @param attacker - The tile the attacker is currently on
 * @param combatRange - Maximum combat range in tiles (1 = melee, 2+ = extended)
 * @param isWalkable - Optional function to check if a tile is walkable
 * @returns The best tile to stand on for combat, or null if none available
 */
export function getBestCombatRangeTile(
  target: TileCoord,
  attacker: TileCoord,
  combatRange: number = 1,
  isWalkable?: (tile: TileCoord) => boolean,
): TileCoord | null {
  const effectiveRange = Math.max(1, Math.floor(combatRange));

  // If already in range, stay where we are
  if (tilesWithinRange(attacker, target, effectiveRange)) {
    return attacker;
  }

  // Generate all valid combat tiles around the target
  const validCombatTiles: Array<{
    tile: TileCoord;
    distToTarget: number;
    distToAttacker: number;
  }> = [];

  for (let dx = -effectiveRange; dx <= effectiveRange; dx++) {
    for (let dz = -effectiveRange; dz <= effectiveRange; dz++) {
      const candidateTile: TileCoord = {
        x: target.x + dx,
        z: target.z + dz,
      };

      // Distance from candidate to target (Chebyshev)
      const distToTarget = Math.max(Math.abs(dx), Math.abs(dz));

      // Must be within range AND not on same tile
      if (distToTarget >= 1 && distToTarget <= effectiveRange) {
        if (isWalkable && !isWalkable(candidateTile)) {
          continue;
        }

        const attackerDx = candidateTile.x - attacker.x;
        const attackerDz = candidateTile.z - attacker.z;
        const distToAttacker = Math.max(
          Math.abs(attackerDx),
          Math.abs(attackerDz),
        );

        validCombatTiles.push({
          tile: candidateTile,
          distToTarget,
          distToAttacker,
        });
      }
    }
  }

  if (validCombatTiles.length === 0) {
    return null;
  }

  validCombatTiles.sort((a, b) => a.distToAttacker - b.distToAttacker);
  return validCombatTiles[0].tile;
}

/**
 * rules-accurate melee destination tile selection
 *
 * When clicking an NPC for melee combat, classic MMORPG:
 * 1. Finds all tiles within melee range of the target
 * 2. For range 1: only cardinal tiles (N/S/E/W) - NO diagonal
 * 3. For range 2+: all tiles within Chebyshev distance
 * 4. Paths to the CLOSEST valid tile using BFS
 *
 * @param target - The tile the target is standing on
 * @param attacker - The tile the attacker is currently on
 * @param meleeRange - Weapon's melee range (1 = standard, 2 = halberd)
 * @param isWalkable - Optional function to check if a tile is walkable
 * @returns The best tile to path to for melee combat, or null if none available
 *
 */
export function getBestMeleeTile(
  target: TileCoord,
  attacker: TileCoord,
  meleeRange: number = 1,
  isWalkable?: (tile: TileCoord) => boolean,
): TileCoord | null {
  const effectiveRange = Math.max(1, Math.floor(meleeRange));

  // Check if already in valid melee range
  if (tilesWithinMeleeRange(attacker, target, effectiveRange)) {
    return attacker;
  }

  // For range 1: CARDINAL ONLY (classic MMORPG melee behavior)
  if (effectiveRange === COMBAT_CONSTANTS.MELEE_RANGE_STANDARD) {
    const cardinalTiles = [
      { x: target.x - 1, z: target.z }, // West
      { x: target.x + 1, z: target.z }, // East
      { x: target.x, z: target.z - 1 }, // South
      { x: target.x, z: target.z + 1 }, // North
    ];

    // Filter walkable and find closest to attacker
    const validTiles = cardinalTiles
      .filter((tile) => !isWalkable || isWalkable(tile))
      .map((tile) => ({
        tile,
        dist: tileChebyshevDistance(tile, attacker),
      }))
      .sort((a, b) => a.dist - b.dist);

    return validTiles.length > 0 ? validTiles[0].tile : null;
  }

  // For range 2+ (halberd): Allow diagonal positions
  const validTiles: Array<{ tile: TileCoord; dist: number }> = [];

  for (let dx = -effectiveRange; dx <= effectiveRange; dx++) {
    for (let dz = -effectiveRange; dz <= effectiveRange; dz++) {
      const candidateTile: TileCoord = {
        x: target.x + dx,
        z: target.z + dz,
      };

      // Chebyshev distance to target
      const distToTarget = Math.max(Math.abs(dx), Math.abs(dz));

      // Must be within range but not on same tile
      if (distToTarget >= 1 && distToTarget <= effectiveRange) {
        if (isWalkable && !isWalkable(candidateTile)) {
          continue;
        }

        validTiles.push({
          tile: candidateTile,
          dist: tileChebyshevDistance(candidateTile, attacker),
        });
      }
    }
  }

  if (validTiles.length === 0) {
    return null;
  }

  // Sort by distance to attacker (closest first)
  validTiles.sort((a, b) => a.dist - b.dist);
  return validTiles[0].tile;
}

/**
 * Get adjacent tiles (8 directions - classic fantasy MMORPG order)
 * Order: W, E, S, N, SW, SE, NW, NE
 */
export function getAdjacentTiles(tile: TileCoord): TileCoord[] {
  return [
    { x: tile.x - 1, z: tile.z }, // West
    { x: tile.x + 1, z: tile.z }, // East
    { x: tile.x, z: tile.z - 1 }, // South
    { x: tile.x, z: tile.z + 1 }, // North
    { x: tile.x - 1, z: tile.z - 1 }, // Southwest
    { x: tile.x + 1, z: tile.z - 1 }, // Southeast
    { x: tile.x - 1, z: tile.z + 1 }, // Northwest
    { x: tile.x + 1, z: tile.z + 1 }, // Northeast
  ];
}

/**
 * Direction vectors matching classic fantasy MMORPG's neighbor check order
 */
export const TILE_DIRECTIONS = [
  { x: -1, z: 0 }, // West
  { x: 1, z: 0 }, // East
  { x: 0, z: -1 }, // South
  { x: 0, z: 1 }, // North
  { x: -1, z: -1 }, // Southwest
  { x: 1, z: -1 }, // Southeast
  { x: -1, z: 1 }, // Northwest
  { x: 1, z: 1 }, // Northeast
] as const;

/**
 * Cardinal directions only (N/E/S/W, no diagonals)
 * classic MMORPG uses all 4 cardinal directions for NPC step-out when on same tile
 *
 */
export const CARDINAL_DIRECTIONS = [
  { x: 0, z: 1 }, // North
  { x: 1, z: 0 }, // East
  { x: 0, z: -1 }, // South
  { x: -1, z: 0 }, // West
] as const;

/**
 * Get cardinal-adjacent tiles (N/E/S/W only, no diagonals)
 *
 * @param tile - Center tile
 * @returns Array of 4 cardinal-adjacent tiles
 */
export function getCardinalTiles(tile: TileCoord): TileCoord[] {
  return CARDINAL_DIRECTIONS.map((dir) => ({
    x: tile.x + dir.x,
    z: tile.z + dir.z,
  }));
}

/**
 * Get a random cardinal-adjacent tile
 * Used for rules-accurate NPC step-out when on same tile as target.
 *
 * Uses the four cardinal directions (north, east, west, south) so the NPC
 * moves one tile at a time.
 *
 * @param tile - Center tile
 * @param rng - Random number generator (for deterministic behavior)
 * @returns Random cardinal tile (N, E, S, or W)
 *
 */
export function getRandomCardinalTile(
  tile: TileCoord,
  rng: { nextInt: (max: number) => number },
): TileCoord {
  const direction = CARDINAL_DIRECTIONS[rng.nextInt(4)];
  return {
    x: tile.x + direction.x,
    z: tile.z + direction.z,
  };
}

// ============================================================================
// PRE-ALLOCATED BUFFER FOR STEP-OUT (Zero-allocation)
// ============================================================================

/**
 * Pre-allocated buffer for step-out tile selection.
 * Avoids creating new arrays on each call.
 */
const _stepOutBuffer: TileCoord[] = [
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
];

/**
 * Find the best cardinal tile to step out to when on same tile as target.
 *
 * rules-accurate: When an NPC is on the same tile as its target, it must
 * step out to a cardinal tile before it can attack. This function finds
 * the first valid tile by:
 * 1. Shuffling all 4 cardinal directions (maintains classic MMORPG randomness)
 * 2. Checking each for terrain walkability AND entity occupancy
 * 3. Returning the first valid tile found
 *
 * This prevents the "thrashing" bug where random single-direction picking
 * could repeatedly select blocked tiles while valid tiles exist.
 *
 * Memory: Uses pre-allocated buffer to avoid GC pressure in hot paths.
 *
 * @param currentTile - Mob's current tile (same as target)
 * @param occupancy - Entity occupancy map for collision checking
 * @param entityId - Mob's entity ID (excluded from occupancy check)
 * @param isWalkable - Terrain walkability check function
 * @param rng - RNG for shuffling directions (deterministic)
 * @returns Best tile to step to, or null if all 4 cardinal tiles are blocked
 *
 */
export function getBestStepOutTile(
  currentTile: TileCoord,
  occupancy: IEntityOccupancy,
  entityId: EntityID,
  isWalkable: (tile: TileCoord) => boolean,
  rng: { nextInt: (max: number) => number },
): TileCoord | null {
  // Populate buffer with cardinal tiles
  // South
  _stepOutBuffer[0].x = currentTile.x;
  _stepOutBuffer[0].z = currentTile.z - 1;
  // North
  _stepOutBuffer[1].x = currentTile.x;
  _stepOutBuffer[1].z = currentTile.z + 1;
  // West
  _stepOutBuffer[2].x = currentTile.x - 1;
  _stepOutBuffer[2].z = currentTile.z;
  // East
  _stepOutBuffer[3].x = currentTile.x + 1;
  _stepOutBuffer[3].z = currentTile.z;

  // Fisher-Yates shuffle for random order (classic MMORPG-style randomness)
  for (let i = 3; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    // Swap values (not references, to keep buffer intact)
    const tempX = _stepOutBuffer[i].x;
    const tempZ = _stepOutBuffer[i].z;
    _stepOutBuffer[i].x = _stepOutBuffer[j].x;
    _stepOutBuffer[i].z = _stepOutBuffer[j].z;
    _stepOutBuffer[j].x = tempX;
    _stepOutBuffer[j].z = tempZ;
  }

  // Find first valid tile
  for (let i = 0; i < 4; i++) {
    const tile = _stepOutBuffer[i];

    // Check terrain walkability first (cheaper check)
    if (!isWalkable(tile)) continue;

    // Check entity occupancy (exclude self)
    if (occupancy.isBlocked(tile, entityId)) continue;

    // Found a valid tile - return a copy (buffer will be reused)
    return { x: tile.x, z: tile.z };
  }

  // All tiles blocked
  return null;
}

// ============================================================================
// LINE OF SIGHT & COMBAT TILE GENERATION
// ============================================================================

/**
 * rules-accurate Line of Sight check for ranged/magic combat.
 * Traces a line between two tiles using Bresenham's algorithm and checks
 * for BLOCKS_RANGED obstacles on intermediate tiles.
 *
 * @param from - Attacker tile
 * @param to - Target tile
 * @param hasBlockingFlags - Function to check if a tile blocks LoS (e.g. BLOCKS_RANGED)
 * @returns true if there is a clear line of sight
 */
export function hasLineOfSight(
  from: TileCoord,
  to: TileCoord,
  hasBlockingFlags: (x: number, z: number) => boolean,
): boolean {
  let x0 = from.x;
  let z0 = from.z;
  const x1 = to.x;
  const z1 = to.z;
  const dx = Math.abs(x1 - x0);
  const dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;

  while (true) {
    // Skip start and end tiles (attacker and target positions)
    if ((x0 !== from.x || z0 !== from.z) && (x0 !== x1 || z0 !== z1)) {
      if (hasBlockingFlags(x0, z0)) return false;
    }
    if (x0 === x1 && z0 === z1) break;
    const e2 = 2 * err;
    if (e2 > -dz) {
      err -= dz;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      z0 += sz;
    }
  }
  return true;
}

/**
 * Generate all valid tiles for ranged/magic combat within Chebyshev range that
 * also have line of sight to the target.
 *
 * Used by movePlayerToward() to build the destination set for findPathToAny().
 *
 * @param target - Target's tile position
 * @param combatRange - Maximum combat range in tiles
 * @param isWalkable - Terrain walkability check
 * @param hasBlockingFlags - LoS blocking check (e.g. BLOCKS_RANGED)
 * @returns Array of valid combat tiles
 */
export function getValidRangedTiles(
  target: TileCoord,
  combatRange: number,
  isWalkable: (tile: TileCoord) => boolean,
  hasBlockingFlags: (x: number, z: number) => boolean,
): TileCoord[] {
  const effectiveRange = Math.max(1, Math.floor(combatRange));
  const tiles: TileCoord[] = [];

  for (let dx = -effectiveRange; dx <= effectiveRange; dx++) {
    for (let dz = -effectiveRange; dz <= effectiveRange; dz++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dz));
      if (dist < 1 || dist > effectiveRange) continue;

      const tile: TileCoord = { x: target.x + dx, z: target.z + dz };
      if (!isWalkable(tile)) continue;
      if (!hasLineOfSight(tile, target, hasBlockingFlags)) continue;

      tiles.push(tile);
    }
  }
  return tiles;
}

/**
 * Generate all valid tiles for melee combat.
 * Range 1 (standard): cardinal only (N/S/E/W) — classic MMORPG melee behavior.
 * Range 2+ (halberd): all Chebyshev tiles within range.
 *
 * @param target - Target's tile position
 * @param meleeRange - Weapon's melee range
 * @param isWalkable - Terrain walkability check
 * @returns Array of valid melee combat tiles
 */
export function getValidMeleeTiles(
  target: TileCoord,
  meleeRange: number,
  isWalkable: (tile: TileCoord) => boolean,
): TileCoord[] {
  const effectiveRange = Math.max(1, Math.floor(meleeRange));
  const tiles: TileCoord[] = [];

  if (effectiveRange === COMBAT_CONSTANTS.MELEE_RANGE_STANDARD) {
    // Range 1: cardinal only (classic MMORPG melee behavior)
    const cardinals = [
      { x: target.x - 1, z: target.z },
      { x: target.x + 1, z: target.z },
      { x: target.x, z: target.z - 1 },
      { x: target.x, z: target.z + 1 },
    ];
    for (const tile of cardinals) {
      if (isWalkable(tile)) tiles.push(tile);
    }
  } else {
    // Range 2+: Chebyshev distance
    for (let dx = -effectiveRange; dx <= effectiveRange; dx++) {
      for (let dz = -effectiveRange; dz <= effectiveRange; dz++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        if (dist < 1 || dist > effectiveRange) continue;
        const tile: TileCoord = { x: target.x + dx, z: target.z + dz };
        if (isWalkable(tile)) tiles.push(tile);
      }
    }
  }
  return tiles;
}

/**
 * Check if a direction is diagonal
 */
export function isDiagonal(dx: number, dz: number): boolean {
  return dx !== 0 && dz !== 0;
}

/**
 * Create a unique key for a tile (for Map/Set storage)
 *
 * PERFORMANCE NOTE: For hot paths (BFS, pathfinding), prefer tileKeyNumeric()
 * which uses a single number instead of string allocation.
 */
export function tileKey(tile: TileCoord): string {
  return `${tile.x},${tile.z}`;
}

/**
 * Create a unique NUMERIC key for a tile - FASTER for hot paths
 * Uses bit shifting to combine x and z into a single number.
 * Valid for coordinates in range [-1048576, 1048575] (21 bits signed)
 *
 * OPTIMIZATION: No string allocation, O(1) constant time
 */
export function tileKeyNumeric(tile: TileCoord): number {
  // Offset to handle negative coordinates (add 2^20 = 1048576)
  // This shifts the range from [-1048576, 1048575] to [0, 2097151]
  const offsetX = (tile.x + 1048576) | 0;
  const offsetZ = (tile.z + 1048576) | 0;
  // Combine into single number: x in upper 21 bits, z in lower 21 bits
  // Using Math.imul to ensure correct integer multiplication
  return offsetX * 2097152 + offsetZ;
}

/**
 * Parse a numeric tile key back into a TileCoord
 */
export function parseTileKeyNumeric(key: number): TileCoord {
  const offsetZ = key % 2097152;
  const offsetX = ((key - offsetZ) / 2097152) | 0;
  return {
    x: offsetX - 1048576,
    z: offsetZ - 1048576,
  };
}

/**
 * Parse a tile key back into a TileCoord
 */
export function parseTileKey(key: string): TileCoord {
  const [x, z] = key.split(",").map(Number);
  return { x, z };
}

/**
 * Clamp a tile coordinate within bounds
 */
export function clampTile(
  tile: TileCoord,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): TileCoord {
  return {
    x: Math.max(minX, Math.min(maxX, tile.x)),
    z: Math.max(minZ, Math.min(maxZ, tile.z)),
  };
}

/**
 * Create an empty tile movement state
 */
export function createTileMovementState(
  startTile: TileCoord,
): TileMovementState {
  return {
    currentTile: { ...startTile },
    path: [],
    pathIndex: 0,
    isRunning: false,
    moveSeq: 0,
    previousTile: null, // Set on first tick
    requestedDestination: null,
    requestedInteractionArrival: null,
    lastPathPartial: false,
    nextSegmentPrecomputed: false,
  };
}

// ============================================================================
// OCCUPANCY-AWARE TILE FUNCTIONS (Zero-Allocation)
// ============================================================================

/** Pre-allocated buffer for cardinal melee tiles (range 1) */
const _cardinalMeleeTiles: TileCoord[] = [
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
];

/** Pre-allocated buffer for extended melee tiles (range 2+, max 5x5 = 24 tiles) */
const _extendedMeleeTiles: TileCoord[] = Array.from({ length: 24 }, () => ({
  x: 0,
  z: 0,
}));

/**
 * Get cardinal melee tiles (range 1) into pre-allocated buffer
 *
 * classic MMORPG melee range 1: Cardinal only (N/S/E/W) - no diagonal attacks
 * Uses zero-allocation by writing to provided buffer.
 *
 * @param targetTile - Target's tile position
 * @param buffer - Pre-allocated buffer to fill (must have length >= 4)
 * @returns 4 (always 4 cardinal tiles)
 */
export function getCardinalMeleeTilesInto(
  targetTile: TileCoord,
  buffer: TileCoord[],
): number {
  buffer[0].x = targetTile.x;
  buffer[0].z = targetTile.z - 1; // South
  buffer[1].x = targetTile.x;
  buffer[1].z = targetTile.z + 1; // North
  buffer[2].x = targetTile.x - 1;
  buffer[2].z = targetTile.z; // West
  buffer[3].x = targetTile.x + 1;
  buffer[3].z = targetTile.z; // East
  return 4;
}

/**
 * Get extended melee tiles (range 2+) into pre-allocated buffer
 *
 * For halberd/spear range 2+ weapons that can attack diagonally.
 * Uses Chebyshev distance - all tiles within range.
 *
 * @param targetTile - Target's tile position
 * @param range - Attack range (2+)
 * @param buffer - Pre-allocated buffer to fill
 * @returns Number of tiles filled
 */
export function getExtendedMeleeTilesInto(
  targetTile: TileCoord,
  range: number,
  buffer: TileCoord[],
): number {
  let index = 0;

  for (let dx = -range; dx <= range && index < buffer.length; dx++) {
    for (let dz = -range; dz <= range && index < buffer.length; dz++) {
      // Skip target tile itself
      if (dx === 0 && dz === 0) continue;

      // Check if within Chebyshev distance
      if (Math.max(Math.abs(dx), Math.abs(dz)) <= range) {
        buffer[index].x = targetTile.x + dx;
        buffer[index].z = targetTile.z + dz;
        index++;
      }
    }
  }

  return index;
}

/**
 * Find best unoccupied combat tile for melee attack (zero-allocation)
 *
 * rules-accurate: Cardinal tiles only for range 1, diagonal allowed for range 2+.
 * Checks both terrain walkability AND entity occupancy.
 *
 * Uses internal pre-allocated buffers - DO NOT store returned tile reference
 * beyond the current call frame.
 *
 * @param attackerTile - Attacker's current tile
 * @param targetTile - Target's tile
 * @param occupancy - Entity occupancy map
 * @param attackerId - Attacker's ID (excluded from collision check)
 * @param isWalkable - Function to check terrain walkability
 * @param range - Attack range (default 1)
 * @returns Best tile reference (internal buffer) or null if all blocked
 *
 */
export function getBestUnoccupiedMeleeTile(
  attackerTile: TileCoord,
  targetTile: TileCoord,
  occupancy: IEntityOccupancy,
  attackerId: EntityID,
  isWalkable: (tile: TileCoord) => boolean,
  range: number = 1,
): TileCoord | null {
  // Get candidate tiles based on range
  const buffer =
    range === COMBAT_CONSTANTS.MELEE_RANGE_STANDARD
      ? _cardinalMeleeTiles
      : _extendedMeleeTiles;
  const tileCount =
    range === COMBAT_CONSTANTS.MELEE_RANGE_STANDARD
      ? getCardinalMeleeTilesInto(targetTile, buffer)
      : getExtendedMeleeTilesInto(targetTile, range, buffer);

  // Calculate distances and find best unoccupied tile
  let bestTile: TileCoord | null = null;
  let bestDistance = Infinity;

  for (let i = 0; i < tileCount; i++) {
    const tile = buffer[i];

    // Skip if blocked by another entity (excludes self)
    if (occupancy.isBlocked(tile, attackerId)) continue;

    // Skip if terrain is unwalkable
    if (!isWalkable(tile)) continue;

    // Calculate Chebyshev distance from attacker to this tile
    const distance = Math.max(
      Math.abs(attackerTile.x - tile.x),
      Math.abs(attackerTile.z - tile.z),
    );

    if (distance < bestDistance) {
      bestDistance = distance;
      bestTile = tile;
    }
  }

  return bestTile;
}

/**
 * Check if any cardinal tile around target is unoccupied (zero-allocation)
 *
 * Fast check to determine if any melee position is available.
 * Used before committing to path calculation.
 *
 * @param targetTile - Target's tile position
 * @param occupancy - Entity occupancy map
 * @param excludeEntityId - Entity to exclude from collision check
 * @param isWalkable - Function to check terrain walkability
 * @returns true if at least one cardinal tile is available
 */
export function hasUnoccupiedCardinalTile(
  targetTile: TileCoord,
  occupancy: IEntityOccupancy,
  excludeEntityId: EntityID,
  isWalkable: (tile: TileCoord) => boolean,
): boolean {
  getCardinalMeleeTilesInto(targetTile, _cardinalMeleeTiles);

  for (let i = 0; i < 4; i++) {
    const tile = _cardinalMeleeTiles[i];
    if (!occupancy.isBlocked(tile, excludeEntityId) && isWalkable(tile)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// RESOURCE INTERACTION TILE HELPERS
// ============================================================================

/**
 * Get all tiles adjacent to a multi-tile resource (valid standing positions)
 *
 * RULES ACCURACY: For multi-tile resources (like large trees), players can
 * interact from any adjacent tile around the resource's footprint.
 *
 * For a 2×2 resource at anchor (15,-10), this returns the 12 tiles surrounding it:
 * - North edge: (15,-8), (16,-8)
 * - South edge: (15,-11), (16,-11)
 * - East edge: (17,-10), (17,-9)
 * - West edge: (14,-10), (14,-9)
 * - Corners: (14,-11), (17,-11), (14,-8), (17,-8)
 *
 * @param anchorTile - SW corner tile of the resource
 * @param footprintX - Width of the resource in tiles
 * @param footprintZ - Depth of the resource in tiles
 * @returns Array of all adjacent tiles (valid interaction positions)
 */
export function getResourceAdjacentTiles(
  anchorTile: TileCoord,
  footprintX: number,
  footprintZ: number,
): TileCoord[] {
  const adjacent: TileCoord[] = [];

  // North edge (z + footprintZ)
  for (let dx = 0; dx < footprintX; dx++) {
    adjacent.push({ x: anchorTile.x + dx, z: anchorTile.z + footprintZ });
  }

  // South edge (z - 1)
  for (let dx = 0; dx < footprintX; dx++) {
    adjacent.push({ x: anchorTile.x + dx, z: anchorTile.z - 1 });
  }

  // East edge (x + footprintX)
  for (let dz = 0; dz < footprintZ; dz++) {
    adjacent.push({ x: anchorTile.x + footprintX, z: anchorTile.z + dz });
  }

  // West edge (x - 1)
  for (let dz = 0; dz < footprintZ; dz++) {
    adjacent.push({ x: anchorTile.x - 1, z: anchorTile.z + dz });
  }

  // Corner tiles (diagonal interaction)
  adjacent.push({ x: anchorTile.x - 1, z: anchorTile.z - 1 }); // SW
  adjacent.push({ x: anchorTile.x + footprintX, z: anchorTile.z - 1 }); // SE
  adjacent.push({ x: anchorTile.x - 1, z: anchorTile.z + footprintZ }); // NW
  adjacent.push({ x: anchorTile.x + footprintX, z: anchorTile.z + footprintZ }); // NE

  return adjacent;
}

/**
 * Find the best adjacent tile for a player to stand on when interacting with a resource
 *
 * RULES ACCURACY: Returns the walkable tile nearest to player's current position.
 * This creates natural pathing behavior where players move to the closest valid spot.
 *
 * @param playerTile - Player's current tile position
 * @param anchorTile - SW corner tile of the resource
 * @param footprintX - Width of the resource in tiles
 * @param footprintZ - Depth of the resource in tiles
 * @param isWalkable - Function to check if a tile is walkable
 * @returns Best tile to stand on, or null if all adjacent tiles are blocked
 */
export function findBestResourceInteractionTile(
  playerTile: TileCoord,
  anchorTile: TileCoord,
  footprintX: number,
  footprintZ: number,
  isWalkable: (tile: TileCoord) => boolean,
): TileCoord | null {
  const adjacent = getResourceAdjacentTiles(anchorTile, footprintX, footprintZ);

  let best: TileCoord | null = null;
  let bestDist = Infinity;

  for (const tile of adjacent) {
    if (!isWalkable(tile)) continue;

    // Use Manhattan distance for simplicity (could use Chebyshev for diagonal preference)
    const dist =
      Math.abs(tile.x - playerTile.x) + Math.abs(tile.z - playerTile.z);
    if (dist < bestDist) {
      bestDist = dist;
      best = tile;
    }
  }

  return best;
}

/**
 * Check if a player tile is adjacent to a resource (can interact)
 *
 * @param playerTile - Player's current tile position
 * @param anchorTile - SW corner tile of the resource
 * @param footprintX - Width of the resource in tiles
 * @param footprintZ - Depth of the resource in tiles
 * @returns true if player is on an adjacent tile
 */
export function isAdjacentToResource(
  playerTile: TileCoord,
  anchorTile: TileCoord,
  footprintX: number,
  footprintZ: number,
): boolean {
  // Check if player is within the interaction ring around the resource
  // Player must be:
  // - X: between anchorTile.x - 1 and anchorTile.x + footprintX (inclusive)
  // - Z: between anchorTile.z - 1 and anchorTile.z + footprintZ (inclusive)
  // - NOT inside the resource footprint itself

  const minX = anchorTile.x - 1;
  const maxX = anchorTile.x + footprintX;
  const minZ = anchorTile.z - 1;
  const maxZ = anchorTile.z + footprintZ;

  // Check if in the bounding ring
  if (
    playerTile.x < minX ||
    playerTile.x > maxX ||
    playerTile.z < minZ ||
    playerTile.z > maxZ
  ) {
    return false;
  }

  // Check if NOT inside the resource (would be standing on the resource)
  const insideX =
    playerTile.x >= anchorTile.x && playerTile.x < anchorTile.x + footprintX;
  const insideZ =
    playerTile.z >= anchorTile.z && playerTile.z < anchorTile.z + footprintZ;

  if (insideX && insideZ) {
    return false; // Standing on the resource, not adjacent
  }

  return true;
}

// ============================================================================
// CARDINAL-ONLY RESOURCE INTERACTION (AAA QUALITY)
// ============================================================================

/**
 * Cardinal direction type for resource interaction
 */
export type CardinalDirection = "N" | "E" | "S" | "W";

/**
 * Face angles for each cardinal direction (with VRM 1.0+ 180° offset)
 * These are the exact Y-axis rotation angles in radians
 */
export const CARDINAL_FACE_ANGLES: Record<CardinalDirection, number> = {
  N: Math.PI, // Face North (towards +Z) = 180° base + 180° VRM = 360° = 0°... wait
  E: Math.PI / 2 + Math.PI, // Face East (towards +X)
  S: 0 + Math.PI, // Face South (towards -Z)
  W: (3 * Math.PI) / 2 + Math.PI, // Face West (towards -X)
};

/**
 * Get ONLY cardinal adjacent tiles (N, E, S, W) for a resource.
 * Excludes diagonal corner tiles for consistent face direction.
 *
 * CARDINAL-ONLY: This ensures players always stand directly N, E, S, or W
 * of a resource, making face direction calculation deterministic.
 *
 * For a 1×1 resource at tile (15, -10):
 * - North: (15, -9)
 * - South: (15, -11)
 * - East:  (16, -10)
 * - West:  (14, -10)
 *
 * @param anchorTile - SW corner tile of the resource
 * @param footprintX - Width of the resource in tiles
 * @param footprintZ - Depth of the resource in tiles
 * @returns Array of cardinal adjacent tiles only (no corners)
 */
export function getCardinalAdjacentTiles(
  anchorTile: TileCoord,
  footprintX: number,
  footprintZ: number,
): TileCoord[] {
  const adjacent: TileCoord[] = [];

  // North edge (z + footprintZ) - tiles directly north of resource
  for (let dx = 0; dx < footprintX; dx++) {
    adjacent.push({ x: anchorTile.x + dx, z: anchorTile.z + footprintZ });
  }

  // South edge (z - 1) - tiles directly south of resource
  for (let dx = 0; dx < footprintX; dx++) {
    adjacent.push({ x: anchorTile.x + dx, z: anchorTile.z - 1 });
  }

  // East edge (x + footprintX) - tiles directly east of resource
  for (let dz = 0; dz < footprintZ; dz++) {
    adjacent.push({ x: anchorTile.x + footprintX, z: anchorTile.z + dz });
  }

  // West edge (x - 1) - tiles directly west of resource
  for (let dz = 0; dz < footprintZ; dz++) {
    adjacent.push({ x: anchorTile.x - 1, z: anchorTile.z + dz });
  }

  // NO corner tiles - cardinal only for consistent facing!
  return adjacent;
}

/**
 * Find the best CARDINAL adjacent tile for resource interaction.
 * Only considers N, E, S, W tiles (no diagonals).
 *
 * @param playerTile - Player's current tile position
 * @param anchorTile - SW corner tile of the resource
 * @param footprintX - Width of the resource in tiles
 * @param footprintZ - Depth of the resource in tiles
 * @param isWalkable - Function to check if a tile is walkable
 * @returns Best cardinal tile to stand on, or null if all are blocked
 */
export function findBestCardinalInteractionTile(
  playerTile: TileCoord,
  anchorTile: TileCoord,
  footprintX: number,
  footprintZ: number,
  isWalkable: (tile: TileCoord) => boolean,
): TileCoord | null {
  const adjacent = getCardinalAdjacentTiles(anchorTile, footprintX, footprintZ);

  let best: TileCoord | null = null;
  let bestDist = Infinity;

  for (const tile of adjacent) {
    if (!isWalkable(tile)) continue;

    // Manhattan distance - natural for cardinal movement
    const dist =
      Math.abs(tile.x - playerTile.x) + Math.abs(tile.z - playerTile.z);
    if (dist < bestDist) {
      bestDist = dist;
      best = tile;
    }
  }

  return best;
}

/**
 * Check if player is on a CARDINAL adjacent tile (not diagonal)
 *
 * @param playerTile - Player's current tile position
 * @param anchorTile - SW corner tile of the resource
 * @param footprintX - Width of the resource in tiles
 * @param footprintZ - Depth of the resource in tiles
 * @returns true if player is on a cardinal adjacent tile
 */
export function isCardinallyAdjacentToResource(
  playerTile: TileCoord,
  anchorTile: TileCoord,
  footprintX: number,
  footprintZ: number,
): boolean {
  const cardinalTiles = getCardinalAdjacentTiles(
    anchorTile,
    footprintX,
    footprintZ,
  );
  return cardinalTiles.some(
    (t) => t.x === playerTile.x && t.z === playerTile.z,
  );
}

/**
 * Determine which cardinal direction the player should face based on their position
 * relative to the resource. This is deterministic for cardinal positions.
 *
 * Standing North of resource → Face South (towards resource)
 * Standing East of resource → Face West (towards resource)
 * Standing South of resource → Face North (towards resource)
 * Standing West of resource → Face East (towards resource)
 *
 * @param playerTile - Player's current tile position
 * @param anchorTile - SW corner tile of the resource
 * @param footprintX - Width of the resource in tiles
 * @param footprintZ - Depth of the resource in tiles
 * @returns The cardinal direction to face, or null if not on cardinal tile
 */
export function getCardinalFaceDirection(
  playerTile: TileCoord,
  anchorTile: TileCoord,
  footprintX: number,
  footprintZ: number,
): CardinalDirection | null {
  // Check if player is on North edge (z >= anchorTile.z + footprintZ)
  if (playerTile.z >= anchorTile.z + footprintZ) {
    // Player is North, should face South
    if (
      playerTile.x >= anchorTile.x &&
      playerTile.x < anchorTile.x + footprintX
    ) {
      return "S";
    }
  }

  // Check if player is on South edge (z < anchorTile.z)
  if (playerTile.z < anchorTile.z) {
    // Player is South, should face North
    if (
      playerTile.x >= anchorTile.x &&
      playerTile.x < anchorTile.x + footprintX
    ) {
      return "N";
    }
  }

  // Check if player is on East edge (x >= anchorTile.x + footprintX)
  if (playerTile.x >= anchorTile.x + footprintX) {
    // Player is East, should face West
    if (
      playerTile.z >= anchorTile.z &&
      playerTile.z < anchorTile.z + footprintZ
    ) {
      return "W";
    }
  }

  // Check if player is on West edge (x < anchorTile.x)
  if (playerTile.x < anchorTile.x) {
    // Player is West, should face East
    if (
      playerTile.z >= anchorTile.z &&
      playerTile.z < anchorTile.z + footprintZ
    ) {
      return "E";
    }
  }

  // Not on a cardinal edge (might be on a corner or inside)
  return null;
}

/**
 * Get the exact Y-axis rotation angle for a cardinal face direction.
 * Includes VRM 1.0+ 180° base rotation offset.
 *
 * @param direction - Cardinal direction to face
 * @returns Y-axis rotation angle in radians
 */
export function getCardinalFaceAngle(direction: CardinalDirection): number {
  // Base angles (without VRM offset):
  // N (towards +Z): atan2(0, 1) = 0
  // E (towards +X): atan2(1, 0) = π/2
  // S (towards -Z): atan2(0, -1) = π
  // W (towards -X): atan2(-1, 0) = -π/2 = 3π/2

  // With VRM 1.0+ 180° offset (add π):
  switch (direction) {
    case "N":
      return 0 + Math.PI; // 0 + π = π
    case "E":
      return Math.PI / 2 + Math.PI; // π/2 + π = 3π/2
    case "S":
      return Math.PI + Math.PI; // π + π = 2π (normalize to 0)
    case "W":
      return -Math.PI / 2 + Math.PI; // -π/2 + π = π/2
    default:
      return Math.PI; // Default to facing South
  }
}
