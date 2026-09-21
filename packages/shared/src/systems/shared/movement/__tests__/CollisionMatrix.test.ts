/**
 * CollisionMatrix Unit Tests
 *
 * Tests the zone-based collision storage system.
 *
 * Key behaviors tested:
 * - Zone allocation and storage
 * - Flag operations (get, set, add, remove, has)
 * - Tile blocking and walkability checks
 * - Directional wall collision
 * - Diagonal movement blocking
 * - Cross-zone boundary handling
 * - Network serialization/deserialization
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CollisionMatrix, ZONE_SIZE } from "../CollisionMatrix";
import { CollisionFlag } from "../CollisionFlags";
import { EntityOccupancyMap } from "../EntityOccupancyMap";
import { createEntityID } from "../../../../types/core/identifiers";

describe("CollisionMatrix", () => {
  let matrix: CollisionMatrix;

  beforeEach(() => {
    matrix = new CollisionMatrix();
  });

  describe("effective collision change subscriptions", () => {
    const record = (matrix: CollisionMatrix) => {
      const changes: Array<[number | null, number | null, number]> = [];
      const unsubscribe = matrix.onChange((x, z, flags) => {
        changes.push([x, z, flags]);
      });
      return { changes, unsubscribe };
    };

    it("reports exact changed bits after writes, suppresses no-ops and unsubscribes", () => {
      const { changes, unsubscribe } = record(matrix);
      const observed: number[] = [];
      matrix.onChange((x, z) => {
        if (x !== null && z !== null) observed.push(matrix.getFlags(x, z));
      });
      matrix.setFlags(-9, 8, CollisionFlag.WATER);
      matrix.setFlags(-9, 8, CollisionFlag.WATER);
      matrix.addFlags(-9, 8, CollisionFlag.BLOCKED);
      matrix.addFlags(-9, 8, CollisionFlag.BLOCKED);
      matrix.removeFlags(-9, 8, CollisionFlag.WATER);
      matrix.removeFlags(-9, 8, CollisionFlag.WATER);
      matrix.removeFlags(100, 100, CollisionFlag.WATER);
      matrix.setFlags(20, 20, 0);
      expect(changes).toEqual([
        [-9, 8, CollisionFlag.WATER],
        [-9, 8, CollisionFlag.BLOCKED],
        [-9, 8, CollisionFlag.WATER],
      ]);
      expect(observed).toEqual([
        CollisionFlag.WATER,
        CollisionFlag.WATER | CollisionFlag.BLOCKED,
        CollisionFlag.BLOCKED,
      ]);
      unsubscribe();
      unsubscribe();
      matrix.setFlags(-9, 8, 0);
      expect(changes).toHaveLength(3);
      expect(observed.at(-1)).toBe(0);
    });

    it("reports only effective region changes, including negative zone boundaries", () => {
      const deck = matrix.acquireWalkableDeck([{ x: -1, z: 7 }], []);
      const { changes } = record(matrix);
      const values = new Int32Array([
        CollisionFlag.WATER,
        CollisionFlag.WATER,
        CollisionFlag.WATER,
        0,
      ]);
      matrix.replaceFlagsInRegion(-1, 7, 2, 2, CollisionFlag.WATER, values);
      expect(changes).toEqual([
        [-1, 8, CollisionFlag.WATER],
        [0, 7, CollisionFlag.WATER],
      ]);
      matrix.replaceFlagsInRegion(-1, 7, 2, 2, CollisionFlag.WATER, values);
      expect(changes).toHaveLength(2);
      deck.release();
      expect(changes.at(-1)).toEqual([
        -1,
        7,
        CollisionFlag.DOCK | CollisionFlag.WATER,
      ]);
    });

    it("publishes committed static leases and suppresses masked or overlapping changes", () => {
      matrix.setFlags(-1, -9, CollisionFlag.BLOCKED);
      const { changes } = record(matrix);
      const snapshots: number[][] = [];
      matrix.onChange(() =>
        snapshots.push([matrix.getFlags(-1, -9), matrix.getFlags(8, 9)]),
      );
      const first = matrix.acquireStaticFootprint([
        { x: -1, z: -9 },
        { x: 8, z: 9 },
      ]);
      expect(changes).toEqual([[8, 9, CollisionFlag.BLOCKED]]);
      expect(snapshots).toEqual([
        [CollisionFlag.BLOCKED, CollisionFlag.BLOCKED],
      ]);
      const second = matrix.acquireStaticFootprint([{ x: 8, z: 9 }]);
      matrix.removeFlags(-1, -9, CollisionFlag.BLOCKED);
      expect(changes).toHaveLength(1);
      expect(first.release()).toBe(true);
      expect(changes.at(-1)).toEqual([-1, -9, CollisionFlag.BLOCKED]);
      expect(matrix.getFlags(8, 9)).toBe(CollisionFlag.BLOCKED);
      expect(first.release()).toBe(false);
      expect(changes).toHaveLength(2);
      expect(second.release()).toBe(true);
      expect(changes.at(-1)).toEqual([8, 9, CollisionFlag.BLOCKED]);
      expect(snapshots.at(-1)).toEqual([0, 0]);
    });

    it("tracks deck masking and independently owned rails without stale release events", () => {
      matrix.setFlags(-8, -1, CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE);
      const { changes } = record(matrix);
      const tiles = [{ x: -8, z: -1 }];
      const walls = [{ x: -9, z: -1, flags: CollisionFlag.WALL_EAST }];
      const first = matrix.acquireWalkableDeck(tiles, walls);
      expect(changes).toEqual([
        [
          -8,
          -1,
          CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE | CollisionFlag.DOCK,
        ],
        [-9, -1, CollisionFlag.WALL_EAST],
      ]);
      const second = matrix.acquireWalkableDeck(tiles, walls);
      matrix.setFlags(-8, -1, CollisionFlag.WATER);
      expect(first.release()).toBe(true);
      expect(first.release()).toBe(false);
      expect(changes).toHaveLength(2);
      expect(second.release()).toBe(true);
      expect(changes.slice(2)).toEqual([
        [-8, -1, CollisionFlag.WATER | CollisionFlag.DOCK],
        [-9, -1, CollisionFlag.WALL_EAST],
      ]);
      expect(matrix.getFlags(-8, -1)).toBe(CollisionFlag.WATER);
      expect(matrix.getFlags(-9, -1)).toBe(0);
    });

    it("covers zone replacement, deserialization and network batches without duplicate notifications", () => {
      const { changes } = record(matrix);
      const zone = new Int32Array(ZONE_SIZE * ZONE_SIZE);
      zone[0] = CollisionFlag.WATER;
      zone[63] = CollisionFlag.BLOCKED;
      matrix.setZoneData(-1, -2, zone);
      matrix.setZoneData(-1, -2, zone);
      expect(changes).toEqual([
        [-8, -16, CollisionFlag.WATER],
        [-1, -9, CollisionFlag.BLOCKED],
      ]);
      const source = new CollisionMatrix();
      source.setFlags(-8, -16, CollisionFlag.STEEP_SLOPE);
      const serialized = source.serializeZone(-1, -2)!;
      expect(matrix.deserializeZone(-1, -2, serialized)).toBe(true);
      matrix.applyNetworkZones([
        { zoneX: -1, zoneZ: -2, base64Data: serialized },
      ]);
      expect(changes.slice(2)).toEqual([
        [-8, -16, CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE],
        [-1, -9, CollisionFlag.BLOCKED],
      ]);
      const lease = matrix.acquireStaticFootprint([{ x: -1, z: -9 }]);
      const combined = matrix.getZoneData(-1, -2)!;
      const count = changes.length;
      matrix.setZoneData(-1, -2, combined);
      expect(lease.release()).toBe(true);
      expect(changes).toHaveLength(count);
      expect(matrix.getFlags(-1, -9)).toBe(CollisionFlag.BLOCKED);
    });

    it("observes actual occupancy moves and vacates with occupancy-only flag differences", () => {
      const occupancy = new EntityOccupancyMap();
      occupancy.setCollisionMatrix(matrix);
      const { changes } = record(matrix);
      const playerId = createEntityID("collision-change-player");
      occupancy.occupy(playerId, [{ x: 4, z: 5 }], 1, "player", false);
      occupancy.move(playerId, [{ x: 5, z: 5 }], 1);
      occupancy.vacate(playerId);
      occupancy.vacate(playerId);
      expect(changes).toEqual([
        [4, 5, CollisionFlag.OCCUPIED_PLAYER],
        [4, 5, CollisionFlag.OCCUPIED_PLAYER],
        [5, 5, CollisionFlag.OCCUPIED_PLAYER],
        [5, 5, CollisionFlag.OCCUPIED_PLAYER],
      ]);
      expect(matrix.getFlags(4, 5)).toBe(0);
      expect(matrix.getFlags(5, 5)).toBe(0);
    });

    it("notifies a bulk reset once, retains subscribers and invalidates old leases", () => {
      const { changes } = record(matrix);
      const staticLease = matrix.acquireStaticFootprint([{ x: 0, z: 0 }]);
      const deckLease = matrix.acquireWalkableDeck([{ x: 1, z: 1 }], []);
      matrix.clear();
      expect(changes.at(-1)).toEqual([null, null, 0]);
      const count = changes.length;
      matrix.clear();
      expect(staticLease.release()).toBe(false);
      expect(deckLease.release()).toBe(false);
      expect(changes).toHaveLength(count);
      matrix.addFlags(2, 2, CollisionFlag.WALL_NORTH);
      expect(changes.at(-1)).toEqual([2, 2, CollisionFlag.WALL_NORTH]);
    });
  });

  describe("zone allocation", () => {
    it("starts with no zones allocated", () => {
      expect(matrix.getZoneCount()).toBe(0);
    });

    it("allocates zone on first write", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      expect(matrix.getZoneCount()).toBe(1);
    });

    it("does not allocate zone on read of empty area", () => {
      matrix.getFlags(0, 0);
      expect(matrix.getZoneCount()).toBe(0);
    });

    it("allocates separate zones for different areas", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      matrix.setFlags(100, 100, CollisionFlag.BLOCKED);
      expect(matrix.getZoneCount()).toBe(2);
    });

    it("reuses same zone for tiles in same zone", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      matrix.setFlags(1, 1, CollisionFlag.BLOCKED);
      matrix.setFlags(ZONE_SIZE - 1, ZONE_SIZE - 1, CollisionFlag.BLOCKED);
      expect(matrix.getZoneCount()).toBe(1);
    });
  });

  describe("getFlags / setFlags", () => {
    it("returns 0 for unset tiles", () => {
      expect(matrix.getFlags(5, 5)).toBe(0);
    });

    it("returns set flags", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      expect(matrix.getFlags(5, 5)).toBe(CollisionFlag.BLOCKED);
    });

    it("replaces existing flags", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      matrix.setFlags(5, 5, CollisionFlag.WATER);
      expect(matrix.getFlags(5, 5)).toBe(CollisionFlag.WATER);
    });

    it("handles combined flags", () => {
      const combinedFlags = CollisionFlag.BLOCKED | CollisionFlag.BLOCK_LOS;
      matrix.setFlags(5, 5, combinedFlags);
      expect(matrix.getFlags(5, 5)).toBe(combinedFlags);
    });

    it("handles negative coordinates", () => {
      matrix.setFlags(-5, -10, CollisionFlag.BLOCKED);
      expect(matrix.getFlags(-5, -10)).toBe(CollisionFlag.BLOCKED);
    });

    it("handles large positive coordinates", () => {
      matrix.setFlags(1000, 2000, CollisionFlag.BLOCKED);
      expect(matrix.getFlags(1000, 2000)).toBe(CollisionFlag.BLOCKED);
    });

    it("handles large negative coordinates", () => {
      matrix.setFlags(-1000, -2000, CollisionFlag.BLOCKED);
      expect(matrix.getFlags(-1000, -2000)).toBe(CollisionFlag.BLOCKED);
    });
  });

  describe("addFlags", () => {
    it("adds flags to empty tile", () => {
      matrix.addFlags(5, 5, CollisionFlag.BLOCKED);
      expect(matrix.getFlags(5, 5)).toBe(CollisionFlag.BLOCKED);
    });

    it("combines flags with existing", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      matrix.addFlags(5, 5, CollisionFlag.BLOCK_LOS);
      expect(matrix.getFlags(5, 5)).toBe(
        CollisionFlag.BLOCKED | CollisionFlag.BLOCK_LOS,
      );
    });

    it("does not duplicate existing flags", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      matrix.addFlags(5, 5, CollisionFlag.BLOCKED);
      expect(matrix.getFlags(5, 5)).toBe(CollisionFlag.BLOCKED);
    });

    it("can add multiple flags at once", () => {
      matrix.addFlags(5, 5, CollisionFlag.BLOCKED | CollisionFlag.WATER);
      expect(matrix.getFlags(5, 5)).toBe(
        CollisionFlag.BLOCKED | CollisionFlag.WATER,
      );
    });
  });

  describe("removeFlags", () => {
    it("removes flags from tile", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED | CollisionFlag.WATER);
      matrix.removeFlags(5, 5, CollisionFlag.WATER);
      expect(matrix.getFlags(5, 5)).toBe(CollisionFlag.BLOCKED);
    });

    it("does nothing when removing non-existent flags", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      matrix.removeFlags(5, 5, CollisionFlag.WATER);
      expect(matrix.getFlags(5, 5)).toBe(CollisionFlag.BLOCKED);
    });

    it("does nothing on unallocated zone", () => {
      matrix.removeFlags(5, 5, CollisionFlag.BLOCKED);
      expect(matrix.getFlags(5, 5)).toBe(0);
      expect(matrix.getZoneCount()).toBe(0);
    });

    it("can remove all flags", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED | CollisionFlag.WATER);
      matrix.removeFlags(5, 5, CollisionFlag.BLOCKED | CollisionFlag.WATER);
      expect(matrix.getFlags(5, 5)).toBe(0);
    });
  });

  describe("hasFlags", () => {
    it("returns false for unset tiles", () => {
      expect(matrix.hasFlags(5, 5, CollisionFlag.BLOCKED)).toBe(false);
    });

    it("returns true when tile has flag", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      expect(matrix.hasFlags(5, 5, CollisionFlag.BLOCKED)).toBe(true);
    });

    it("returns false when tile has different flag", () => {
      matrix.setFlags(5, 5, CollisionFlag.WATER);
      expect(matrix.hasFlags(5, 5, CollisionFlag.BLOCKED)).toBe(false);
    });

    it("returns true when any of multiple flags match", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      expect(
        matrix.hasFlags(5, 5, CollisionFlag.BLOCKED | CollisionFlag.WATER),
      ).toBe(true);
    });

    it("returns true when tile has all queried flags", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED | CollisionFlag.WATER);
      expect(
        matrix.hasFlags(5, 5, CollisionFlag.BLOCKED | CollisionFlag.WATER),
      ).toBe(true);
    });
  });

  describe("isWalkable", () => {
    it("returns true for empty tiles", () => {
      expect(matrix.isWalkable(5, 5)).toBe(true);
    });

    it("returns false for blocked tiles", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      expect(matrix.isWalkable(5, 5)).toBe(false);
    });

    it("returns false for water tiles", () => {
      matrix.setFlags(5, 5, CollisionFlag.WATER);
      expect(matrix.isWalkable(5, 5)).toBe(false);
    });

    it("returns false for steep slope tiles", () => {
      matrix.setFlags(5, 5, CollisionFlag.STEEP_SLOPE);
      expect(matrix.isWalkable(5, 5)).toBe(false);
    });

    it("returns false for player-occupied tiles", () => {
      matrix.setFlags(5, 5, CollisionFlag.OCCUPIED_PLAYER);
      expect(matrix.isWalkable(5, 5)).toBe(false);
    });

    it("returns false for NPC-occupied tiles", () => {
      matrix.setFlags(5, 5, CollisionFlag.OCCUPIED_NPC);
      expect(matrix.isWalkable(5, 5)).toBe(false);
    });

    it("returns true for decoration tiles", () => {
      matrix.setFlags(5, 5, CollisionFlag.DECORATION);
      expect(matrix.isWalkable(5, 5)).toBe(true);
    });

    it("returns true for tiles with only wall flags", () => {
      matrix.setFlags(5, 5, CollisionFlag.WALL_NORTH);
      expect(matrix.isWalkable(5, 5)).toBe(true);
    });
  });

  describe("isBlocked - cardinal movement", () => {
    it("returns false for unblocked movement", () => {
      expect(matrix.isBlocked(5, 5, 6, 5)).toBe(false); // east
    });

    it("returns true when destination is blocked", () => {
      matrix.setFlags(6, 5, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(5, 5, 6, 5)).toBe(true);
    });

    it("returns true when destination has water", () => {
      matrix.setFlags(6, 5, CollisionFlag.WATER);
      expect(matrix.isBlocked(5, 5, 6, 5)).toBe(true);
    });

    it("returns true when destination is occupied", () => {
      matrix.setFlags(6, 5, CollisionFlag.OCCUPIED_NPC);
      expect(matrix.isBlocked(5, 5, 6, 5)).toBe(true);
    });

    it("allows movement to decoration tiles", () => {
      matrix.setFlags(6, 5, CollisionFlag.DECORATION);
      expect(matrix.isBlocked(5, 5, 6, 5)).toBe(false);
    });
  });

  describe("isBlocked - directional walls", () => {
    // Coordinate system: North = -Z, South = +Z, East = +X, West = -X
    // Moving from z=6 to z=5 = dz=-1 = moving NORTH = coming FROM south
    // Moving from z=4 to z=5 = dz=+1 = moving SOUTH = coming FROM north

    it("blocks entry from north when destination has WALL_NORTH", () => {
      matrix.setFlags(5, 5, CollisionFlag.WALL_NORTH);
      // Moving from (5,4) to (5,5) - dz=+1 = moving south = coming from NORTH
      expect(matrix.isBlocked(5, 4, 5, 5)).toBe(true);
    });

    it("allows entry from south when destination has WALL_NORTH", () => {
      matrix.setFlags(5, 5, CollisionFlag.WALL_NORTH);
      // Moving from (5,6) to (5,5) - dz=-1 = moving north = coming from SOUTH
      expect(matrix.isBlocked(5, 6, 5, 5)).toBe(false);
    });

    it("blocks entry from east when destination has WALL_EAST", () => {
      matrix.setFlags(5, 5, CollisionFlag.WALL_EAST);
      // Moving from (6,5) to (5,5) - dx=-1 = moving west = coming from EAST
      expect(matrix.isBlocked(6, 5, 5, 5)).toBe(true);
    });

    it("blocks entry from south when destination has WALL_SOUTH", () => {
      matrix.setFlags(5, 5, CollisionFlag.WALL_SOUTH);
      // Moving from (5,6) to (5,5) - dz=-1 = moving north = coming from SOUTH
      expect(matrix.isBlocked(5, 6, 5, 5)).toBe(true);
    });

    it("blocks entry from west when destination has WALL_WEST", () => {
      matrix.setFlags(5, 5, CollisionFlag.WALL_WEST);
      // Moving from (4,5) to (5,5) - dx=+1 = moving east = coming from WEST
      expect(matrix.isBlocked(4, 5, 5, 5)).toBe(true);
    });

    it("blocks exit when source has wall in movement direction", () => {
      matrix.setFlags(5, 5, CollisionFlag.WALL_EAST);
      // Moving from (5,5) to (6,5) - exiting east, but wall blocks east entry
      // Need opposite wall flag check - WALL_WEST on source blocks exit east
      matrix.setFlags(5, 5, CollisionFlag.WALL_EAST);
      // Actually, WALL_EAST on source means wall blocks entry FROM east
      // To block EXIT to east, we need to check differently
      // Let me re-read the isBlocked logic...
      // The source check uses getOppositeWallFlag on the entry flag
      // So if moving east (dx=1), entry flag is WALL_WEST (coming from west)
      // Opposite of WALL_WEST is WALL_EAST
      // So if source has WALL_EAST, it blocks exit east
      expect(matrix.isBlocked(5, 5, 6, 5)).toBe(true);
    });
  });

  describe("isBlocked - diagonal movement", () => {
    it("returns false for unblocked diagonal movement", () => {
      expect(matrix.isBlocked(5, 5, 6, 6)).toBe(false); // northeast
    });

    it("blocks diagonal when destination is blocked", () => {
      matrix.setFlags(6, 6, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(5, 5, 6, 6)).toBe(true);
    });

    it("blocks diagonal when horizontal adjacent tile is blocked", () => {
      // Moving northeast (5,5) -> (6,6)
      // Horizontal adjacent is (6,5) - directly east
      matrix.setFlags(6, 5, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(5, 5, 6, 6)).toBe(true);
    });

    it("blocks diagonal when vertical adjacent tile is blocked", () => {
      // Moving northeast (5,5) -> (6,6)
      // Vertical adjacent is (5,6) - directly north
      matrix.setFlags(5, 6, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(5, 5, 6, 6)).toBe(true);
    });

    it("allows diagonal when adjacent tiles are walkable", () => {
      // Only destination has decoration (walkable)
      matrix.setFlags(6, 6, CollisionFlag.DECORATION);
      expect(matrix.isBlocked(5, 5, 6, 6)).toBe(false);
    });

    it("blocks southeast when east tile is blocked", () => {
      matrix.setFlags(6, 5, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(5, 5, 6, 4)).toBe(true); // southeast
    });

    it("blocks southwest when west tile is blocked", () => {
      matrix.setFlags(4, 5, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(5, 5, 4, 4)).toBe(true); // southwest
    });

    it("blocks northwest when north tile is blocked", () => {
      matrix.setFlags(5, 6, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(5, 5, 4, 6)).toBe(true); // northwest
    });
  });

  describe("isBlocked - diagonal wall clipping", () => {
    // Coordinate system: North = -Z, South = +Z, East = +X, West = -X
    // Moving (5,5) -> (6,6) = dx=+1, dz=+1 = moving SOUTHEAST (east + south)

    it("blocks diagonal when horizontal adjacent has wall blocking Z direction", () => {
      // Moving southeast (5,5) -> (6,6): dx=+1, dz=+1
      // Horizontal adjacent is (6,5) - the tile east of source
      // To get from (6,5) to (6,6) we move south (dz=+1), coming FROM north
      // horizWallFlag = getWallFlagForDirection(0, -dz) = getWallFlagForDirection(0, -1)
      // Coming from north (-Z) → WALL_NORTH blocks us
      matrix.setFlags(6, 5, CollisionFlag.WALL_NORTH);
      expect(matrix.isBlocked(5, 5, 6, 6)).toBe(true);
    });

    it("blocks diagonal when vertical adjacent has wall blocking X direction", () => {
      // Moving southeast (5,5) -> (6,6): dx=+1, dz=+1
      // Vertical adjacent is (5,6) - the tile south of source
      // To get from (5,6) to (6,6) we move east (dx=+1), coming FROM west
      // vertWallFlag = getWallFlagForDirection(-dx, 0) = getWallFlagForDirection(-1, 0)
      // Coming from west (-X) → WALL_WEST blocks us
      matrix.setFlags(5, 6, CollisionFlag.WALL_WEST);
      expect(matrix.isBlocked(5, 5, 6, 6)).toBe(true);
    });

    it("blocks diagonal when exterior wall faces outward (building corner case)", () => {
      // Building walls register OPPOSITE flags on exterior tiles
      // If interior corner at (6,6) has WALL_NORTH and WALL_WEST,
      // exterior tile (6,5) has WALL_SOUTH (opposite of NORTH)
      // exterior tile (5,6) has WALL_EAST (opposite of WEST)
      //
      // Moving southeast (5,5) -> (6,6): should be blocked by exterior walls
      matrix.setFlags(6, 5, CollisionFlag.WALL_SOUTH); // exterior wall facing south
      expect(matrix.isBlocked(5, 5, 6, 6)).toBe(true);
    });

    it("blocks diagonal when exterior wall on vertical adjacent faces outward", () => {
      // Same as above but for vertical intermediate
      matrix.setFlags(5, 6, CollisionFlag.WALL_EAST); // exterior wall facing east
      expect(matrix.isBlocked(5, 5, 6, 6)).toBe(true);
    });

    it("blocks diagonal when destination has walls on both entry edges (corner tile)", () => {
      // Building corner tile has walls on two cardinal edges
      // E.g., northwest corner has WALL_NORTH and WALL_WEST
      // Entering diagonally from SW should be blocked
      matrix.setFlags(6, 6, CollisionFlag.WALL_NORTH | CollisionFlag.WALL_WEST);
      expect(matrix.isBlocked(5, 5, 6, 6)).toBe(true);
    });
  });

  describe("cross-zone boundaries", () => {
    it("handles tiles at zone boundary correctly", () => {
      // Tile at edge of zone 0
      matrix.setFlags(ZONE_SIZE - 1, ZONE_SIZE - 1, CollisionFlag.BLOCKED);
      expect(matrix.getFlags(ZONE_SIZE - 1, ZONE_SIZE - 1)).toBe(
        CollisionFlag.BLOCKED,
      );
      // Tile in next zone
      matrix.setFlags(ZONE_SIZE, ZONE_SIZE, CollisionFlag.WATER);
      expect(matrix.getFlags(ZONE_SIZE, ZONE_SIZE)).toBe(CollisionFlag.WATER);
      expect(matrix.getZoneCount()).toBe(2);
    });

    it("checks movement across zone boundary", () => {
      // Block tile in next zone
      matrix.setFlags(ZONE_SIZE, 0, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(ZONE_SIZE - 1, 0, ZONE_SIZE, 0)).toBe(true);
    });

    it("handles negative zone boundaries", () => {
      matrix.setFlags(-1, -1, CollisionFlag.BLOCKED);
      expect(matrix.getFlags(-1, -1)).toBe(CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(-2, -1, -1, -1)).toBe(true);
    });
  });

  describe("clear", () => {
    it("removes all zones", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      matrix.setFlags(100, 100, CollisionFlag.BLOCKED);
      expect(matrix.getZoneCount()).toBe(2);

      matrix.clear();
      expect(matrix.getZoneCount()).toBe(0);
    });

    it("clears all collision data", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      matrix.clear();
      expect(matrix.getFlags(5, 5)).toBe(0);
    });
  });

  describe("zone data operations", () => {
    it("getZoneData returns null for unallocated zone", () => {
      expect(matrix.getZoneData(0, 0)).toBe(null);
    });

    it("getZoneData returns data for allocated zone", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      const data = matrix.getZoneData(0, 0);
      expect(data).not.toBe(null);
      expect(data!.length).toBe(ZONE_SIZE * ZONE_SIZE);
    });

    it("setZoneData applies zone data", () => {
      const data = new Int32Array(ZONE_SIZE * ZONE_SIZE);
      data[0] = CollisionFlag.BLOCKED;
      data[10] = CollisionFlag.WATER;

      matrix.setZoneData(0, 0, data);

      expect(matrix.getFlags(0, 0)).toBe(CollisionFlag.BLOCKED);
    });

    it("setZoneData creates a copy", () => {
      const data = new Int32Array(ZONE_SIZE * ZONE_SIZE);
      data[0] = CollisionFlag.BLOCKED;

      matrix.setZoneData(0, 0, data);

      // Modify original
      data[0] = CollisionFlag.WATER;

      // Matrix should still have original value
      expect(matrix.getFlags(0, 0)).toBe(CollisionFlag.BLOCKED);
    });

    it("setZoneData rejects invalid length", () => {
      const data = new Int32Array(10); // Wrong size
      matrix.setZoneData(0, 0, data);
      expect(matrix.getZoneData(0, 0)).toBe(null);
    });
  });

  describe("serialization", () => {
    it("serializeZone returns null for unallocated zone", () => {
      expect(matrix.serializeZone(0, 0)).toBe(null);
    });

    it("serializeZone returns base64 string", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      const serialized = matrix.serializeZone(0, 0);
      expect(typeof serialized).toBe("string");
      expect(serialized!.length).toBeGreaterThan(0);
    });

    it("deserializeZone restores data", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      matrix.setFlags(5, 5, CollisionFlag.WATER);
      const serialized = matrix.serializeZone(0, 0)!;

      // Create new matrix and deserialize
      const matrix2 = new CollisionMatrix();
      const success = matrix2.deserializeZone(0, 0, serialized);

      expect(success).toBe(true);
      expect(matrix2.getFlags(0, 0)).toBe(CollisionFlag.BLOCKED);
      expect(matrix2.getFlags(5, 5)).toBe(CollisionFlag.WATER);
    });

    it("deserializeZone returns false for invalid data", () => {
      const success = matrix.deserializeZone(0, 0, "invalid base64!!!");
      expect(success).toBe(false);
    });
  });

  describe("getZonesInRadius", () => {
    it("returns empty array when no zones allocated", () => {
      const zones = matrix.getZonesInRadius(0, 0, 10);
      expect(zones).toEqual([]);
    });

    it("returns zones within radius", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      matrix.setFlags(ZONE_SIZE, 0, CollisionFlag.BLOCKED);

      const zones = matrix.getZonesInRadius(0, 0, ZONE_SIZE * 2);
      expect(zones.length).toBe(2);
    });

    it("excludes zones outside radius", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      matrix.setFlags(1000, 1000, CollisionFlag.BLOCKED);

      const zones = matrix.getZonesInRadius(0, 0, ZONE_SIZE);
      expect(zones.length).toBe(1);
    });
  });

  describe("debugPrint", () => {
    it("returns grid representation", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      matrix.setFlags(6, 5, CollisionFlag.WATER);
      matrix.setFlags(7, 5, CollisionFlag.OCCUPIED_NPC);

      const grid = matrix.debugPrint(4, 4, 8, 6);
      expect(Array.isArray(grid)).toBe(true);
      expect(grid.length).toBe(3); // 3 rows (z: 6, 5, 4)
    });

    it("shows blocked tiles as #", () => {
      matrix.setFlags(5, 5, CollisionFlag.BLOCKED);
      const grid = matrix.debugPrint(5, 5, 5, 5);
      expect(grid[0][0]).toBe("#");
    });

    it("shows empty tiles as .", () => {
      const grid = matrix.debugPrint(0, 0, 0, 0);
      expect(grid[0][0]).toBe(".");
    });

    it("shows water tiles as ~", () => {
      matrix.setFlags(5, 5, CollisionFlag.WATER);
      const grid = matrix.debugPrint(5, 5, 5, 5);
      expect(grid[0][0]).toBe("~");
    });

    it("shows occupied tiles as @", () => {
      matrix.setFlags(5, 5, CollisionFlag.OCCUPIED_PLAYER);
      const grid = matrix.debugPrint(5, 5, 5, 5);
      expect(grid[0][0]).toBe("@");
    });
  });

  describe("getZoneKeys", () => {
    it("returns empty array for empty matrix", () => {
      expect(matrix.getZoneKeys()).toEqual([]);
    });

    it("returns zone coordinates for allocated zones", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      const keys = matrix.getZoneKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toEqual({ zoneX: 0, zoneZ: 0 });
    });

    it("returns correct coordinates for positive zones", () => {
      // Zone at x=100, z=200 (zone coords depend on ZONE_SIZE)
      matrix.setFlags(ZONE_SIZE * 3, ZONE_SIZE * 5, CollisionFlag.BLOCKED);
      const keys = matrix.getZoneKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toEqual({ zoneX: 3, zoneZ: 5 });
    });

    it("returns correct coordinates for negative zones", () => {
      matrix.setFlags(-ZONE_SIZE, -ZONE_SIZE, CollisionFlag.BLOCKED);
      const keys = matrix.getZoneKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toEqual({ zoneX: -1, zoneZ: -1 });
    });

    it("returns correct coordinates for mixed positive/negative zones", () => {
      matrix.setFlags(-ZONE_SIZE * 2, ZONE_SIZE * 3, CollisionFlag.BLOCKED);
      const keys = matrix.getZoneKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toEqual({ zoneX: -2, zoneZ: 3 });
    });

    it("handles large positive zone coordinates", () => {
      // Large positive zone (near int32 max range)
      const largeCoord = ZONE_SIZE * 10000;
      matrix.setFlags(largeCoord, largeCoord, CollisionFlag.BLOCKED);
      const keys = matrix.getZoneKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toEqual({ zoneX: 10000, zoneZ: 10000 });
    });

    it("handles large negative zone coordinates", () => {
      const largeCoord = -ZONE_SIZE * 10000;
      matrix.setFlags(largeCoord, largeCoord, CollisionFlag.BLOCKED);
      const keys = matrix.getZoneKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]).toEqual({ zoneX: -10000, zoneZ: -10000 });
    });

    it("returns all zone keys when multiple zones exist", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      matrix.setFlags(ZONE_SIZE * 2, ZONE_SIZE * 3, CollisionFlag.WATER);
      matrix.setFlags(-ZONE_SIZE, -ZONE_SIZE * 2, CollisionFlag.STEEP_SLOPE);

      const keys = matrix.getZoneKeys();
      expect(keys.length).toBe(3);

      // Convert to set of strings for easier comparison
      const keySet = new Set(keys.map((k) => `${k.zoneX},${k.zoneZ}`));
      expect(keySet.has("0,0")).toBe(true);
      expect(keySet.has("2,3")).toBe(true);
      expect(keySet.has("-1,-2")).toBe(true);
    });
  });

  describe("zone cache consistency", () => {
    it("maintains consistent state across sequential lookups", () => {
      // Fill multiple zones
      for (let i = 0; i < 10; i++) {
        matrix.setFlags(i * ZONE_SIZE, i * ZONE_SIZE, CollisionFlag.BLOCKED);
      }

      // Sequential lookups should all succeed
      for (let i = 0; i < 10; i++) {
        expect(matrix.getFlags(i * ZONE_SIZE, i * ZONE_SIZE)).toBe(
          CollisionFlag.BLOCKED,
        );
      }
    });

    it("clear() resets cache state", () => {
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      matrix.setFlags(ZONE_SIZE, ZONE_SIZE, CollisionFlag.WATER);

      // Access tiles to potentially warm any internal cache
      matrix.getFlags(0, 0);
      matrix.getFlags(ZONE_SIZE, ZONE_SIZE);

      matrix.clear();

      // After clear, all should return 0
      expect(matrix.getFlags(0, 0)).toBe(0);
      expect(matrix.getFlags(ZONE_SIZE, ZONE_SIZE)).toBe(0);
      expect(matrix.getZoneCount()).toBe(0);
    });

    it("handles interleaved reads and writes to different zones", () => {
      // Interleave operations to stress cache
      matrix.setFlags(0, 0, CollisionFlag.BLOCKED);
      expect(matrix.getFlags(ZONE_SIZE * 5, ZONE_SIZE * 5)).toBe(0);
      matrix.setFlags(ZONE_SIZE * 5, ZONE_SIZE * 5, CollisionFlag.WATER);
      expect(matrix.getFlags(0, 0)).toBe(CollisionFlag.BLOCKED);
      matrix.setFlags(-ZONE_SIZE, -ZONE_SIZE, CollisionFlag.STEEP_SLOPE);
      expect(matrix.getFlags(ZONE_SIZE * 5, ZONE_SIZE * 5)).toBe(
        CollisionFlag.WATER,
      );
      expect(matrix.getFlags(-ZONE_SIZE, -ZONE_SIZE)).toBe(
        CollisionFlag.STEEP_SLOPE,
      );
    });
  });

  describe("high-volume operations (performance sanity)", () => {
    it("replaces masked flags across zone boundaries without touching other flags", () => {
      const originX = -3;
      const originZ = 6;
      const width = 13;
      const height = 11;
      const terrainMask = CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE;
      const flags = new Int32Array(width * height);

      matrix.addFlags(0, 8, CollisionFlag.BLOCKED | CollisionFlag.WATER);
      matrix.addFlags(9, 16, CollisionFlag.WALL_NORTH);
      flags[(0 - originX) * height + (8 - originZ)] = CollisionFlag.STEEP_SLOPE;
      flags[(9 - originX) * height + (16 - originZ)] = CollisionFlag.WATER;

      matrix.replaceFlagsInRegion(
        originX,
        originZ,
        width,
        height,
        terrainMask,
        flags,
      );

      expect(matrix.getFlags(0, 8)).toBe(
        CollisionFlag.BLOCKED | CollisionFlag.STEEP_SLOPE,
      );
      expect(matrix.getFlags(9, 16)).toBe(
        CollisionFlag.WALL_NORTH | CollisionFlag.WATER,
      );
      expect(matrix.getFlags(-3, 6)).toBe(0);
      expect(matrix.getFlags(10, 16)).toBe(0);
    });

    it("does not allocate zones when a batch only clears absent flags", () => {
      matrix.replaceFlagsInRegion(
        -50,
        -50,
        100,
        100,
        CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE,
        new Int32Array(10_000),
      );

      expect(matrix.getZoneCount()).toBe(0);
    });

    it("rejects malformed region batches", () => {
      expect(() =>
        matrix.replaceFlagsInRegion(
          0,
          0,
          2,
          2,
          CollisionFlag.WATER,
          new Int32Array(3),
        ),
      ).toThrow(/flags length/);
    });

    it("handles 1000 sequential tile operations", () => {
      const start = Date.now();

      for (let i = 0; i < 1000; i++) {
        matrix.setFlags(i, 0, CollisionFlag.BLOCKED);
      }

      for (let i = 0; i < 1000; i++) {
        expect(matrix.getFlags(i, 0)).toBe(CollisionFlag.BLOCKED);
      }

      const elapsed = Date.now() - start;
      // Should complete quickly even under load
      expect(elapsed).toBeLessThan(300);
    });

    it("handles scattered tiles across many zones", () => {
      const start = Date.now();

      // Scatter tiles across 100 different zones
      for (let i = 0; i < 100; i++) {
        matrix.setFlags(
          i * ZONE_SIZE + 5,
          i * ZONE_SIZE + 5,
          CollisionFlag.BLOCKED,
        );
      }

      expect(matrix.getZoneCount()).toBe(100);

      // Verify all can be read back
      for (let i = 0; i < 100; i++) {
        expect(matrix.getFlags(i * ZONE_SIZE + 5, i * ZONE_SIZE + 5)).toBe(
          CollisionFlag.BLOCKED,
        );
      }

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(300);
    });
  });

  describe("edge cases for isBlocked", () => {
    it("handles stationary movement (dx=0, dz=0)", () => {
      // Moving to same tile should not be blocked
      expect(matrix.isBlocked(5, 5, 5, 5)).toBe(false);
    });

    it("handles long-distance movement (multiple tiles)", () => {
      // isBlocked should still work for non-adjacent tiles
      matrix.setFlags(100, 100, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(0, 0, 100, 100)).toBe(true);
    });

    it("handles destination at exact zone boundary", () => {
      matrix.setFlags(ZONE_SIZE, 0, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(ZONE_SIZE - 1, 0, ZONE_SIZE, 0)).toBe(true);
    });

    it("handles source at exact zone boundary", () => {
      matrix.setFlags(ZONE_SIZE + 1, 0, CollisionFlag.BLOCKED);
      expect(matrix.isBlocked(ZONE_SIZE, 0, ZONE_SIZE + 1, 0)).toBe(true);
    });

    it("handles movement crossing zone boundary (both zones blocked)", () => {
      matrix.setFlags(ZONE_SIZE - 1, 0, CollisionFlag.WALL_EAST);
      matrix.setFlags(ZONE_SIZE, 0, CollisionFlag.WALL_WEST);
      // Should be blocked in both directions
      expect(matrix.isBlocked(ZONE_SIZE - 1, 0, ZONE_SIZE, 0)).toBe(true);
      expect(matrix.isBlocked(ZONE_SIZE, 0, ZONE_SIZE - 1, 0)).toBe(true);
    });
  });
});
