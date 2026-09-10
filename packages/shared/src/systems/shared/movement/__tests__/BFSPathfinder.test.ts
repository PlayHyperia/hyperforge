/**
 * BFS Pathfinder Unit Tests
 *
 * Tests the BFS pathfinding system with classic MMORPG-style diagonal pathing.
 *
 * Key behaviors tested:
 * - Basic straight-line pathfinding
 * - Naive diagonal pathing (classic MMORPG follow-mode style)
 * - BFS fallback when naive path is blocked
 * - Obstacle avoidance
 * - Corner clipping prevention
 * - Path length limits
 * - Edge cases (same tile, unreachable destinations)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BFSPathfinder } from "../BFSPathfinder";
import { TileCoord, tilesEqual } from "../TileSystem";

describe("BFSPathfinder", () => {
  let pathfinder: BFSPathfinder;

  // Helper to create walkability checker with blocked tiles
  const createWalkabilityChecker = (blockedTiles: TileCoord[]) => {
    return (tile: TileCoord) => !blockedTiles.some((b) => tilesEqual(b, tile));
  };

  // Helper to check if path is valid (each step is adjacent)
  const isValidPath = (path: TileCoord[], start: TileCoord): boolean => {
    if (path.length === 0) return true;

    // Check first tile is adjacent to start
    const first = path[0];
    const dx = Math.abs(first.x - start.x);
    const dz = Math.abs(first.z - start.z);
    if (dx > 1 || dz > 1 || (dx === 0 && dz === 0)) {
      return false;
    }

    // Check each subsequent tile is adjacent to previous
    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1];
      const curr = path[i];
      const stepDx = Math.abs(curr.x - prev.x);
      const stepDz = Math.abs(curr.z - prev.z);
      if (stepDx > 1 || stepDz > 1 || (stepDx === 0 && stepDz === 0)) {
        return false;
      }
    }

    return true;
  };

  beforeEach(() => {
    pathfinder = new BFSPathfinder();
  });

  describe("Basic Pathfinding", () => {
    it("returns empty array when start equals end", () => {
      const start = { x: 0, z: 0 };
      const path = pathfinder.findPath(start, start, () => true);
      expect(path).toEqual([]);
    });

    it("finds straight horizontal path", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 5, z: 0 };
      const path = pathfinder.findPath(start, end, () => true);

      expect(path.length).toBe(5);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });

    it("finds straight vertical path", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 0, z: 5 };
      const path = pathfinder.findPath(start, end, () => true);

      expect(path.length).toBe(5);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });

    it("owns path coordinates when callers reuse a mutable destination", () => {
      const sharedDestination = { x: 0, z: 4 };
      const firstPath = pathfinder.findPath(
        { x: 0, z: 0 },
        sharedDestination,
        () => true,
      );

      sharedDestination.x = 7;
      sharedDestination.z = 3;
      const secondPath = pathfinder.findPath(
        { x: 5, z: 3 },
        sharedDestination,
        () => true,
      );

      expect(firstPath[firstPath.length - 1]).toEqual({ x: 0, z: 4 });
      expect(secondPath[secondPath.length - 1]).toEqual({ x: 7, z: 3 });
    });

    it("finds diagonal path (naive diagonal)", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 3, z: 3 };
      const path = pathfinder.findPath(start, end, () => true);

      // Naive diagonal: 3 steps diagonally
      expect(path.length).toBe(3);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });

    it("handles asymmetric diagonal (more X than Z)", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 5, z: 3 };
      const path = pathfinder.findPath(start, end, () => true);

      // Should be 5 steps: 3 diagonal + 2 horizontal
      expect(path.length).toBe(5);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });

    it("handles asymmetric diagonal (more Z than X)", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 2, z: 5 };
      const path = pathfinder.findPath(start, end, () => true);

      // Should be 5 steps: 2 diagonal + 3 vertical
      expect(path.length).toBe(5);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });

    it.each([
      ["north", 0, -1],
      ["north-east", 1, -1],
      ["east", 1, 0],
      ["south-east", 1, 1],
      ["south", 0, 1],
      ["south-west", -1, 1],
      ["west", -1, 0],
      ["north-west", -1, -1],
    ] as const)("supports one-tile %s movement", (_label, x, z) => {
      const start = { x: 0, z: 0 };
      const end = { x, z };
      const path = pathfinder.findPath(start, end, () => true);

      expect(path).toEqual([end]);
      expect(isValidPath(path, start)).toBe(true);
    });
  });

  describe("Negative Coordinates", () => {
    it("handles negative start coordinates", () => {
      const start = { x: -5, z: -5 };
      const end = { x: 0, z: 0 };
      const path = pathfinder.findPath(start, end, () => true);

      expect(path.length).toBe(5);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });

    it("handles negative end coordinates", () => {
      const start = { x: 0, z: 0 };
      const end = { x: -5, z: -5 };
      const path = pathfinder.findPath(start, end, () => true);

      expect(path.length).toBe(5);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });

    it("handles both negative coordinates", () => {
      const start = { x: -10, z: -10 };
      const end = { x: -5, z: -5 };
      const path = pathfinder.findPath(start, end, () => true);

      expect(path.length).toBe(5);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });
  });

  describe("Obstacle Avoidance", () => {
    it("paths around single obstacle", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 2, z: 0 };
      const blocked = [{ x: 1, z: 0 }];

      const path = pathfinder.findPath(
        start,
        end,
        createWalkabilityChecker(blocked),
      );

      expect(path.length).toBeGreaterThan(2); // Must go around
      expect(path[path.length - 1]).toEqual(end);
      expect(path.some((t) => tilesEqual(t, blocked[0]))).toBe(false);
      expect(isValidPath(path, start)).toBe(true);
    });

    it("paths around wall", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 0, z: 3 };
      // Wall blocking direct path
      const blocked = [
        { x: -1, z: 1 },
        { x: 0, z: 1 },
        { x: 1, z: 1 },
      ];

      const path = pathfinder.findPath(
        start,
        end,
        createWalkabilityChecker(blocked),
      );

      expect(path.length).toBeGreaterThan(3);
      expect(path[path.length - 1]).toEqual(end);
      blocked.forEach((b) => {
        expect(path.some((t) => tilesEqual(t, b))).toBe(false);
      });
      expect(isValidPath(path, start)).toBe(true);
    });

    it("handles blocked destination (finds nearest walkable)", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 5, z: 0 };
      const blocked = [{ x: 5, z: 0 }]; // Destination blocked

      const path = pathfinder.findPath(
        start,
        end,
        createWalkabilityChecker(blocked),
      );

      // Should path to a tile adjacent to the blocked destination
      if (path.length > 0) {
        const lastTile = path[path.length - 1];
        expect(blocked.some((b) => tilesEqual(b, lastTile))).toBe(false);
      }
    });
  });

  describe("Corner Clipping Prevention", () => {
    it("prevents diagonal through blocked corners", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 1, z: 1 };
      // Block the two tiles that would cause corner clipping
      const blocked = [
        { x: 1, z: 0 },
        { x: 0, z: 1 },
      ];

      const path = pathfinder.findPath(
        start,
        end,
        createWalkabilityChecker(blocked),
      );

      // Should not be able to reach diagonally
      // Either empty or finds a longer path
      if (path.length > 0) {
        expect(path.length).toBeGreaterThan(1);
        expect(isValidPath(path, start)).toBe(true);
      }
    });
  });

  describe("Unreachable Destinations", () => {
    it("returns empty when completely surrounded", () => {
      const start = { x: 5, z: 5 };
      const end = { x: 10, z: 10 };
      // Completely surround start tile
      const blocked = [
        { x: 4, z: 4 },
        { x: 5, z: 4 },
        { x: 6, z: 4 },
        { x: 4, z: 5 },
        { x: 6, z: 5 },
        { x: 4, z: 6 },
        { x: 5, z: 6 },
        { x: 6, z: 6 },
      ];

      const path = pathfinder.findPath(
        start,
        end,
        createWalkabilityChecker(blocked),
      );

      expect(path).toEqual([]);
    });

    it("returns partial path when destination unreachable", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 10, z: 0 };
      // Wall blocking at x=5
      const blocked: TileCoord[] = [];
      for (let z = -128; z <= 128; z++) {
        blocked.push({ x: 5, z });
      }

      const path = pathfinder.findPath(
        start,
        end,
        createWalkabilityChecker(blocked),
      );

      // Should return partial path or empty
      if (path.length > 0) {
        // Verify doesn't cross the wall
        expect(path.every((t) => t.x < 5)).toBe(true);
      }
    });
  });

  describe("Long Paths", () => {
    it("handles 100+ tile path", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 100, z: 50 };
      const path = pathfinder.findPath(start, end, () => true);

      expect(path.length).toBeGreaterThan(0);
      expect(path.length).toBeLessThanOrEqual(200); // Max path length
      expect(isValidPath(path, start)).toBe(true);
    });

    it("respects maximum path length of 200", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 150, z: 150 }; // Would be 150 diagonal steps
      const path = pathfinder.findPath(start, end, () => true);

      expect(path.length).toBeLessThanOrEqual(200);
    });
  });

  describe("Path Length Calculation", () => {
    it("calculates straight path length correctly", () => {
      // Path has 3 tiles, but getPathLength counts steps between them (2 segments)
      const path: TileCoord[] = [
        { x: 1, z: 0 },
        { x: 2, z: 0 },
        { x: 3, z: 0 },
      ];

      const length = pathfinder.getPathLength(path);
      expect(length).toBe(2); // 2 steps: (1,0)->(2,0)->(3,0)
    });

    it("calculates diagonal path length correctly (Chebyshev)", () => {
      // Diagonal steps count as 1 tile each (Chebyshev distance)
      const path: TileCoord[] = [
        { x: 1, z: 1 },
        { x: 2, z: 2 },
        { x: 3, z: 3 },
      ];

      const length = pathfinder.getPathLength(path);
      expect(length).toBe(2); // 2 diagonal steps
    });

    it("returns 0 for empty path", () => {
      expect(pathfinder.getPathLength([])).toBe(0);
    });

    it("returns 1 for single-tile path", () => {
      expect(pathfinder.getPathLength([{ x: 5, z: 5 }])).toBe(1);
    });
  });

  describe("Object Pool Usage", () => {
    it("handles multiple concurrent pathfinding calls", () => {
      // This tests that the object pool works correctly under load
      const paths: TileCoord[][] = [];

      for (let i = 0; i < 20; i++) {
        const start = { x: i * 10, z: 0 };
        const end = { x: i * 10 + 5, z: 5 };
        const path = pathfinder.findPath(start, end, () => true);
        paths.push(path);
      }

      // All paths should be valid
      expect(paths.length).toBe(20);
      paths.forEach((path, i) => {
        const start = { x: i * 10, z: 0 };
        expect(isValidPath(path, start)).toBe(true);
      });
    });
  });

  describe("Edge Cases", () => {
    it("handles single tile distance", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 1, z: 0 };
      const path = pathfinder.findPath(start, end, () => true);

      expect(path.length).toBe(1);
      expect(path[0]).toEqual(end);
    });

    it("handles zero tile distance", () => {
      const tile = { x: 42, z: 42 };
      const path = pathfinder.findPath(tile, tile, () => true);

      expect(path).toEqual([]);
    });

    it("handles large coordinate values", () => {
      const start = { x: 5000, z: 5000 };
      const end = { x: 5010, z: 5010 };
      const path = pathfinder.findPath(start, end, () => true);

      expect(path.length).toBe(10);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });
  });

  describe("BFS Iteration Budget", () => {
    it("respects maxIterations parameter", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 100, z: 100 }; // Far destination
      // Very low budget forces partial path
      const path = pathfinder.findPath(start, end, () => true, 50);

      expect(pathfinder.wasLastPathPartial()).toBe(true);
      expect(pathfinder.getLastIterationsUsed()).toBeLessThanOrEqual(50);
      expect(path.length).toBeGreaterThan(0);
    });

    it("tracks iterations used across calls", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 5, z: 0 };
      pathfinder.findPath(start, end, () => true);

      expect(pathfinder.getLastIterationsUsed()).toBeGreaterThan(0);
      expect(pathfinder.wasLastPathPartial()).toBe(false);
    });

    it("resets iterations to 0 on early exit (same tile)", () => {
      // First call uses iterations
      pathfinder.findPath({ x: 0, z: 0 }, { x: 5, z: 0 }, () => true);
      expect(pathfinder.getLastIterationsUsed()).toBeGreaterThan(0);

      // Same-tile call should reset to 0, not return stale value
      pathfinder.findPath({ x: 3, z: 3 }, { x: 3, z: 3 }, () => true);
      expect(pathfinder.getLastIterationsUsed()).toBe(0);
    });

    it("returns complete path when budget is sufficient", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 10, z: 10 };
      const path = pathfinder.findPath(start, end, () => true, 4000);

      expect(pathfinder.wasLastPathPartial()).toBe(false);
      expect(path[path.length - 1]).toEqual(end);
    });

    it("partial path gets closer to destination than start", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 100, z: 0 };
      const path = pathfinder.findPath(start, end, () => true, 30);

      expect(pathfinder.wasLastPathPartial()).toBe(true);
      if (path.length > 0) {
        const lastTile = path[path.length - 1];
        const startDist = Math.abs(end.x - start.x);
        const endDist = Math.abs(end.x - lastTile.x);
        expect(endDist).toBeLessThan(startDist);
      }
    });

    it("resets partial flag on each call", () => {
      // First call: partial
      pathfinder.findPath({ x: 0, z: 0 }, { x: 100, z: 100 }, () => true, 10);
      expect(pathfinder.wasLastPathPartial()).toBe(true);

      // Second call: complete
      pathfinder.findPath({ x: 0, z: 0 }, { x: 2, z: 0 }, () => true);
      expect(pathfinder.wasLastPathPartial()).toBe(false);
    });
  });

  describe("Guided long-route search", () => {
    it("reaches a distant diagonal destination without radial expansion", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 100, z: 100 };

      const path = pathfinder.findPathGuided(start, end, () => true, 4000);

      expect(pathfinder.wasLastPathPartial()).toBe(false);
      expect(pathfinder.getLastIterationsUsed()).toBeLessThanOrEqual(101);
      expect(path).toHaveLength(100);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });

    it("preserves shortest diagonal-safe routing around an obstruction", () => {
      const blocked = Array.from({ length: 9 }, (_, index) => ({
        x: 5,
        z: index - 4,
      }));
      const start = { x: 0, z: 0 };
      const end = { x: 10, z: 0 };
      const path = pathfinder.findPathGuided(
        start,
        end,
        createWalkabilityChecker(blocked),
      );

      expect(pathfinder.wasLastPathPartial()).toBe(false);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
      expect(
        path.every((tile) => !(tile.x === 5 && Math.abs(tile.z) <= 4)),
      ).toBe(true);
      const breadthFirstPath = new BFSPathfinder().findPath(
        start,
        end,
        createWalkabilityChecker(blocked),
      );
      expect(path).toHaveLength(breadthFirstPath.length);
    });

    it("returns bounded forward progress when its budget is exhausted", () => {
      const start = { x: 0, z: 0 };
      const end = { x: 100, z: 0 };
      const path = pathfinder.findPathGuided(start, end, () => true, 12);

      expect(pathfinder.wasLastPathPartial()).toBe(true);
      expect(pathfinder.getLastIterationsUsed()).toBeLessThanOrEqual(12);
      expect(path.length).toBeGreaterThan(0);
      expect(Math.abs(end.x - path[path.length - 1].x)).toBeLessThan(100);
    });

    it("reaches the nearest member of a destination set efficiently", () => {
      const destinations = [
        { x: 80, z: 80 },
        { x: 75, z: 80 },
        { x: 80, z: 75 },
      ];
      const path = pathfinder.findPathToAnyGuided(
        { x: 0, z: 0 },
        destinations,
        () => true,
        4000,
      );

      expect(pathfinder.wasLastPathPartial()).toBe(false);
      expect(pathfinder.getLastIterationsUsed()).toBeLessThan(200);
      expect(destinations).toContainEqual(path[path.length - 1]);
    });
  });

  describe("Multi-Destination BFS (findPathToAny)", () => {
    it("finds path to nearest destination", () => {
      const start = { x: 0, z: 0 };
      const destinations = [
        { x: 10, z: 0 }, // Far
        { x: 3, z: 0 }, // Close
        { x: 20, z: 0 }, // Very far
      ];

      const path = pathfinder.findPathToAny(start, destinations, () => true);

      expect(path.length).toBe(3); // Nearest is 3 tiles away
      expect(path[path.length - 1]).toEqual({ x: 3, z: 0 });
    });

    it("returns empty when already at a destination", () => {
      const start = { x: 5, z: 5 };
      const destinations = [
        { x: 10, z: 10 },
        { x: 5, z: 5 }, // Same as start
      ];

      const path = pathfinder.findPathToAny(start, destinations, () => true);
      expect(path).toEqual([]);
    });

    it("returns empty for empty destinations array", () => {
      const path = pathfinder.findPathToAny({ x: 0, z: 0 }, [], () => true);
      expect(path).toEqual([]);
    });

    it("respects maxIterations budget", () => {
      const start = { x: 0, z: 0 };
      const destinations = [{ x: 100, z: 100 }];

      pathfinder.findPathToAny(start, destinations, () => true, 30);

      expect(pathfinder.wasLastPathPartial()).toBe(true);
      expect(pathfinder.getLastIterationsUsed()).toBeLessThanOrEqual(30);
    });

    it("skips unreachable destinations and finds reachable ones", () => {
      const start = { x: 0, z: 0 };
      // Destination at (5,0) is behind a wall, but (3,3) is reachable
      const blocked: TileCoord[] = [];
      for (let z = -10; z <= 10; z++) {
        blocked.push({ x: 4, z });
      }
      const destinations = [
        { x: 5, z: 0 }, // Behind wall
        { x: 3, z: 3 }, // Reachable
      ];

      const path = pathfinder.findPathToAny(
        start,
        destinations,
        createWalkabilityChecker(blocked),
      );

      expect(path.length).toBeGreaterThan(0);
      expect(path[path.length - 1]).toEqual({ x: 3, z: 3 });
    });
  });

  describe("Directional Wall Blocking", () => {
    // These tests verify the pathfinder correctly handles directional blocking
    // (like building walls that block movement in specific directions)

    it("respects directional wall blocking from fromTile", () => {
      // Simulate a wall at (5,5) that blocks entry from the west (from 4,5)
      const wallsBlocking = new Map<string, Set<string>>();
      wallsBlocking.set("5,5", new Set(["4,5"])); // Can't enter (5,5) from (4,5)

      const isWalkable = (tile: TileCoord, fromTile?: TileCoord): boolean => {
        const key = `${tile.x},${tile.z}`;
        if (fromTile) {
          const fromKey = `${fromTile.x},${fromTile.z}`;
          const blockedFrom = wallsBlocking.get(key);
          if (blockedFrom?.has(fromKey)) {
            return false; // Movement from this direction is blocked
          }
        }
        return true; // Tile is walkable from other directions
      };

      const start = { x: 0, z: 5 };
      const end = { x: 10, z: 5 };

      const path = pathfinder.findPath(start, end, isWalkable);

      // Path should still be found, but should go around the wall
      expect(path.length).toBeGreaterThan(0);
      expect(path[path.length - 1]).toEqual(end);

      // The path should NOT include stepping from (4,5) to (5,5)
      let hasBlockedStep = false;
      let prevTile = start;
      for (const tile of path) {
        if (
          prevTile.x === 4 &&
          prevTile.z === 5 &&
          tile.x === 5 &&
          tile.z === 5
        ) {
          hasBlockedStep = true;
        }
        prevTile = tile;
      }
      expect(hasBlockedStep).toBe(false);
    });

    it("allows movement to tile from non-blocked directions", () => {
      // Wall at (5,5) that only blocks entry from the west
      const wallsBlocking = new Map<string, Set<string>>();
      wallsBlocking.set("5,5", new Set(["4,5"]));

      const isWalkable = (tile: TileCoord, fromTile?: TileCoord): boolean => {
        const key = `${tile.x},${tile.z}`;
        if (fromTile) {
          const fromKey = `${fromTile.x},${fromTile.z}`;
          const blockedFrom = wallsBlocking.get(key);
          if (blockedFrom?.has(fromKey)) {
            return false;
          }
        }
        return true;
      };

      // Start from the east side - should be able to walk directly
      const start = { x: 10, z: 5 };
      const end = { x: 5, z: 5 };

      const path = pathfinder.findPath(start, end, isWalkable);

      // Should find a direct path (no wall blocks entry from the east)
      expect(path.length).toBeGreaterThan(0);
      expect(path[path.length - 1]).toEqual(end);
      expect(isValidPath(path, start)).toBe(true);
    });

    it("handles building-like wall pattern (door on one side)", () => {
      // Simulate a 3x3 building with a door on the south side
      // Building covers tiles (5,5) to (7,7)
      // Walls block entry from all sides except through the door at (6,5) from (6,4)

      const buildingTiles = new Set([
        "5,5",
        "6,5",
        "7,5",
        "5,6",
        "6,6",
        "7,6",
        "5,7",
        "6,7",
        "7,7",
      ]);

      const isWalkable = (tile: TileCoord, fromTile?: TileCoord): boolean => {
        const key = `${tile.x},${tile.z}`;

        // Check if moving INTO the building
        if (buildingTiles.has(key) && fromTile) {
          const fromKey = `${fromTile.x},${fromTile.z}`;
          const isFromOutside = !buildingTiles.has(fromKey);

          if (isFromOutside) {
            // Only allow entry through the door at (6,5) from (6,4)
            const isDoorEntry =
              tile.x === 6 &&
              tile.z === 5 &&
              fromTile.x === 6 &&
              fromTile.z === 4;
            if (!isDoorEntry) {
              return false; // Blocked by wall
            }
          }
        }

        return true;
      };

      // Try to walk into the building center from outside
      const start = { x: 6, z: 0 };
      const end = { x: 6, z: 6 }; // Center of building

      const path = pathfinder.findPath(start, end, isWalkable);

      // Should find a path through the door
      expect(path.length).toBeGreaterThan(0);
      expect(path[path.length - 1]).toEqual(end);

      // Verify path goes through the door (6,4) -> (6,5)
      let wentThroughDoor = false;
      let prevTile = start;
      for (const tile of path) {
        if (
          prevTile.x === 6 &&
          prevTile.z === 4 &&
          tile.x === 6 &&
          tile.z === 5
        ) {
          wentThroughDoor = true;
        }
        prevTile = tile;
      }
      expect(wentThroughDoor).toBe(true);
    });
  });
});
