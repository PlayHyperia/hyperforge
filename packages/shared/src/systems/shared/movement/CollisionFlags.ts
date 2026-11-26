/**
 * CollisionFlags - rules-accurate collision bitmask flags
 *
 * Each tile has an int32 bitmask combining these flags.
 * Bitwise operations allow efficient queries:
 *   if (flags & CollisionFlag.BLOCKED) { // can't walk }
 *
 * Flag values match classic MMORPG conventions where possible:
 * - Wall flags: 0x1 - 0x80 (directional)
 * - Occupied: 0x100 - 0x200 (entities)
 * - Blocked: 0x200000 (full tile block)
 * - LoS block: 0x400000 (ranged combat)
 *
 */

/**
 * Individual collision flags (bitmask values)
 *
 * Usage:
 *   // Check if tile is blocked
 *   if (flags & CollisionFlag.BLOCKED) { ... }
 *
 *   // Add blocking to tile
 *   flags |= CollisionFlag.BLOCKED;
 *
 *   // Remove blocking from tile
 *   flags &= ~CollisionFlag.BLOCKED;
 */
export const CollisionFlag = {
  // ============================================================================
  // DIRECTIONAL WALL FLAGS
  // These block movement FROM that direction into the tile
  // E.g., WALL_NORTH means you cannot enter this tile from the north
  // ============================================================================

  /** Wall on NW corner - blocks diagonal movement from NW */
  WALL_NORTH_WEST: 0x00000001,

  /** Wall on north edge - blocks movement from north */
  WALL_NORTH: 0x00000002,

  /** Wall on NE corner - blocks diagonal movement from NE */
  WALL_NORTH_EAST: 0x00000004,

  /** Wall on east edge - blocks movement from east */
  WALL_EAST: 0x00000008,

  /** Wall on SE corner - blocks diagonal movement from SE */
  WALL_SOUTH_EAST: 0x00000010,

  /** Wall on south edge - blocks movement from south */
  WALL_SOUTH: 0x00000020,

  /** Wall on SW corner - blocks diagonal movement from SW */
  WALL_SOUTH_WEST: 0x00000040,

  /** Wall on west edge - blocks movement from west */
  WALL_WEST: 0x00000080,

  // ============================================================================
  // ENTITY OCCUPANCY FLAGS
  // Set when entities (players/NPCs) occupy the tile
  // ============================================================================

  /** Tile occupied by a player */
  OCCUPIED_PLAYER: 0x00000100,

  /** Tile occupied by an NPC/mob */
  OCCUPIED_NPC: 0x00000200,

  // ============================================================================
  // OBJECT FLAGS
  // Set by static world objects (resources, stations, decorations)
  // ============================================================================

  /** Decoration object - marks tile but doesn't block */
  DECORATION: 0x00040000,

  /** Full tile blocking - trees, rocks, furnaces, anvils, etc. */
  BLOCKED: 0x00200000,

  /** Blocks line of sight - for ranged combat checks */
  BLOCK_LOS: 0x00400000,

  /** Water tile - impassable for ground entities */
  WATER: 0x00800000,

  /** Steep slope - impassable terrain */
  STEEP_SLOPE: 0x01000000,

  /** Bridge deck tile - walkable over water, uses bridge deck height for Y */
  BRIDGE: 0x02000000,

  /** Dock tile - walkable over water, uses dock deck height for Y */
  DOCK: 0x04000000,
} as const;

/**
 * Combined masks for common collision queries
 *
 * Usage:
 *   // Check if tile blocks walking
 *   if (flags & CollisionMask.BLOCKS_WALK) { ... }
 */
export const CollisionMask = {
  /** Any blocking for ground movement (static objects) */
  BLOCKS_WALK:
    CollisionFlag.BLOCKED | CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE,

  /** Any entity occupying tile */
  OCCUPIED: CollisionFlag.OCCUPIED_PLAYER | CollisionFlag.OCCUPIED_NPC,

  /** Full blocking including entities */
  BLOCKS_MOVEMENT:
    CollisionFlag.BLOCKED |
    CollisionFlag.WATER |
    CollisionFlag.STEEP_SLOPE |
    CollisionFlag.OCCUPIED_PLAYER |
    CollisionFlag.OCCUPIED_NPC,

  /** Blocks ranged attacks / line of sight */
  BLOCKS_RANGED: CollisionFlag.BLOCK_LOS | CollisionFlag.BLOCKED,

  /** All cardinal wall flags combined */
  WALLS_CARDINAL:
    CollisionFlag.WALL_NORTH |
    CollisionFlag.WALL_EAST |
    CollisionFlag.WALL_SOUTH |
    CollisionFlag.WALL_WEST,

  /** All diagonal wall flags combined */
  WALLS_DIAGONAL:
    CollisionFlag.WALL_NORTH_WEST |
    CollisionFlag.WALL_NORTH_EAST |
    CollisionFlag.WALL_SOUTH_EAST |
    CollisionFlag.WALL_SOUTH_WEST,

  /** All wall flags combined */
  WALLS:
    CollisionFlag.WALL_NORTH |
    CollisionFlag.WALL_EAST |
    CollisionFlag.WALL_SOUTH |
    CollisionFlag.WALL_WEST |
    CollisionFlag.WALL_NORTH_WEST |
    CollisionFlag.WALL_NORTH_EAST |
    CollisionFlag.WALL_SOUTH_EAST |
    CollisionFlag.WALL_SOUTH_WEST,
} as const;

/**
 * Type for individual collision flag values
 */
export type CollisionFlagValue =
  (typeof CollisionFlag)[keyof typeof CollisionFlag];

/**
 * Type for collision mask values
 */
export type CollisionMaskValue =
  (typeof CollisionMask)[keyof typeof CollisionMask];

/**
 * Get the wall flag that blocks movement from a given direction
 *
 * When checking if movement from tile A to tile B is blocked:
 * - Check if A has a wall blocking exit in that direction
 * - Check if B has a wall blocking entry from that direction
 *
 * Coordinate system: North = -Z, South = +Z, East = +X, West = -X
 *
 * @param dx - X direction (-1, 0, 1) of the direction we're coming FROM
 * @param dz - Z direction (-1, 0, 1) of the direction we're coming FROM
 * @returns Wall flag that blocks entry from that direction, or 0
 */
export function getWallFlagForDirection(dx: number, dz: number): number {
  // Cardinal directions
  // Coming from north (-Z direction) = wall on north side blocks us
  if (dx === 0 && dz === -1) return CollisionFlag.WALL_NORTH;
  // Coming from south (+Z direction) = wall on south side blocks us
  if (dx === 0 && dz === 1) return CollisionFlag.WALL_SOUTH;
  // Coming from east (+X direction) = wall on east side blocks us
  if (dx === 1 && dz === 0) return CollisionFlag.WALL_EAST;
  // Coming from west (-X direction) = wall on west side blocks us
  if (dx === -1 && dz === 0) return CollisionFlag.WALL_WEST;

  // Diagonal directions
  // NW = (-X, -Z), NE = (+X, -Z), SE = (+X, +Z), SW = (-X, +Z)
  if (dx === -1 && dz === -1) return CollisionFlag.WALL_NORTH_WEST;
  if (dx === 1 && dz === -1) return CollisionFlag.WALL_NORTH_EAST;
  if (dx === 1 && dz === 1) return CollisionFlag.WALL_SOUTH_EAST;
  if (dx === -1 && dz === 1) return CollisionFlag.WALL_SOUTH_WEST;

  return 0;
}

/**
 * Get the opposite wall flag (for checking entry from the other side)
 *
 * @param flag - Wall flag to get opposite of
 * @returns Opposite wall flag
 */
export function getOppositeWallFlag(flag: number): number {
  switch (flag) {
    case CollisionFlag.WALL_NORTH:
      return CollisionFlag.WALL_SOUTH;
    case CollisionFlag.WALL_SOUTH:
      return CollisionFlag.WALL_NORTH;
    case CollisionFlag.WALL_EAST:
      return CollisionFlag.WALL_WEST;
    case CollisionFlag.WALL_WEST:
      return CollisionFlag.WALL_EAST;
    case CollisionFlag.WALL_NORTH_WEST:
      return CollisionFlag.WALL_SOUTH_EAST;
    case CollisionFlag.WALL_NORTH_EAST:
      return CollisionFlag.WALL_SOUTH_WEST;
    case CollisionFlag.WALL_SOUTH_EAST:
      return CollisionFlag.WALL_NORTH_WEST;
    case CollisionFlag.WALL_SOUTH_WEST:
      return CollisionFlag.WALL_NORTH_EAST;
    default:
      return 0;
  }
}
