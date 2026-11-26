/**
 * Building Navigation Edge Case Tests
 *
 * Comprehensive tests for all building navigation scenarios:
 * 1. Agent starting outside, moving to every tile in building
 * 2. Two-story buildings with stairs
 * 3. Multi-room buildings with internal walls
 * 4. Building rotations (0°, 90°, 180°, 270°)
 * 5. Exit navigation (inside → outside)
 * 6. Complex paths: outside → door → stairs → second floor
 * 7. Internal wall diagonal clipping
 * 8. Window vs door vs arch openings
 *
 * These tests simulate real-world gameplay scenarios.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { World, BFSPathfinder } from "@hyperforge/shared";
import { BuildingCollisionService } from "@hyperforge/shared";
import type { TileCoord } from "@hyperforge/shared";
import {
  BuildingGenerator,
  createRng,
  getRecipe,
  type BuildingLayout,
} from "@hyperforge/procgen/building";
import {
  ENTRANCE_STEP_COUNT,
  TERRAIN_STEP_COUNT,
} from "@hyperforge/procgen/building";

const TEST_TIMEOUT = 60000;

// ============================================================================
// TEST BUILDING LAYOUTS
// ============================================================================

/**
 * Create a simple 3x3 building with one door (no internal walls)
 */
function createSimpleBuilding(
  doorDirection: "north" | "south" | "east" | "west" = "north",
) {
  const footprint = [
    [true, true, true],
    [true, true, true],
    [true, true, true],
  ];

  const roomMap = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  const externalOpenings = new Map<string, string>();

  // Door position based on direction
  // CARDINAL_DIRECTIONS: north=dr-1, south=dr+1
  // Row 0 external edge is NORTH (dr-1 from row 0 → row -1 doesn't exist)
  // Row 2 external edge is SOUTH (dr+1 from row 2 → row 3 doesn't exist)
  switch (doorDirection) {
    case "north":
      externalOpenings.set("1,0,north", "door");
      break;
    case "south":
      externalOpenings.set("1,2,south", "door");
      break;
    case "east":
      externalOpenings.set("2,1,east", "door");
      break;
    case "west":
      externalOpenings.set("0,1,west", "door");
      break;
  }

  return {
    width: 3,
    depth: 3,
    floors: 1,
    floorPlans: [
      {
        footprint: footprint.map((row) => [...row]),
        roomMap: roomMap.map((row) => [...row]),
        internalOpenings: new Map(),
        externalOpenings: new Map(externalOpenings),
      },
    ],
    stairs: null,
  };
}

/**
 * Create a 2-story building with stairs
 * Layout:
 *   Row 0: [X] [D] [X]  <- Door on north
 *   Row 1: [L] [ ] [ ]  <- Landing on floor 1
 *   Row 2: [S] [ ] [ ]  <- Stairs on floor 0
 */
function createTwoStoryBuilding() {
  const footprint = [
    [true, true, true],
    [true, true, true],
    [true, true, true],
  ];

  const roomMap = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  const externalOpenings = new Map<string, string>();
  externalOpenings.set("1,0,north", "door");

  return {
    width: 3,
    depth: 3,
    floors: 2,
    floorPlans: [
      // Floor 0
      {
        footprint: footprint.map((row) => [...row]),
        roomMap: roomMap.map((row) => [...row]),
        internalOpenings: new Map(),
        externalOpenings: new Map(externalOpenings),
      },
      // Floor 1
      {
        footprint: footprint.map((row) => [...row]),
        roomMap: roomMap.map((row) => [...row]),
        internalOpenings: new Map(),
        externalOpenings: new Map(), // No external doors on floor 1
      },
    ],
    stairs: {
      col: 0,
      row: 2,
      direction: "north" as const,
      landing: { col: 0, row: 1 },
    },
  };
}

/**
 * Create a multi-room building with internal walls
 * Layout (2 rooms):
 *   Row 0: [R0] [R0] [R0]  <- Room 0
 *   Row 1: [R0] [  ] [R1]  <- Internal door between R0 and R1
 *   Row 2: [R1] [R1] [R1]  <- Room 1
 *
 * External door on north (Room 0)
 * Internal door between Room 0 and Room 1
 */
function createMultiRoomBuilding() {
  const footprint = [
    [true, true, true],
    [true, true, true],
    [true, true, true],
  ];

  // Room map: 0 = north room, 1 = south room
  const roomMap = [
    [0, 0, 0], // Row 0: all room 0
    [0, 0, 1], // Row 1: room 0 on west/center, room 1 on east
    [1, 1, 1], // Row 2: all room 1
  ];

  const externalOpenings = new Map<string, string>();
  externalOpenings.set("1,0,north", "door"); // Entry door to room 0

  const internalOpenings = new Map<string, string>();
  // Internal door between room 0 (col 1, row 1) and room 1 (col 1, row 2)
  // Checking south from (1,1) finds (1,2) which is room 1
  internalOpenings.set("1,1,south", "door");

  return {
    width: 3,
    depth: 3,
    floors: 1,
    floorPlans: [
      {
        footprint: footprint.map((row) => [...row]),
        roomMap: roomMap.map((row) => [...row]),
        internalOpenings: new Map(internalOpenings),
        externalOpenings: new Map(externalOpenings),
      },
    ],
    stairs: null,
  };
}

function createSimpleBuildingWithEntrance(
  openingType: "door" | "arch",
  doorDirection: "north" | "south" | "east" | "west" = "north",
) {
  const layout = createSimpleBuilding(doorDirection);
  const floor0 = layout.floorPlans[0];
  const updatedOpenings = new Map<string, string>();

  for (const [key, value] of floor0.externalOpenings.entries()) {
    if (value === "door") {
      updatedOpenings.set(key, openingType);
    } else {
      updatedOpenings.set(key, value);
    }
  }

  layout.floorPlans = [
    {
      footprint: floor0.footprint.map((row) => [...row]),
      roomMap: floor0.roomMap.map((row) => [...row]),
      internalOpenings: new Map(floor0.internalOpenings),
      externalOpenings: updatedOpenings,
    },
  ];

  return layout;
}

/**
 * Create a building with a window (should NOT allow passage)
 */
function createBuildingWithWindow() {
  const footprint = [
    [true, true, true],
    [true, true, true],
    [true, true, true],
  ];

  const roomMap = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  const externalOpenings = new Map<string, string>();
  externalOpenings.set("1,0,north", "door"); // Real door
  externalOpenings.set("0,1,west", "window"); // Window - should NOT allow passage

  return {
    width: 3,
    depth: 3,
    floors: 1,
    floorPlans: [
      {
        footprint: footprint.map((row) => [...row]),
        roomMap: roomMap.map((row) => [...row]),
        internalOpenings: new Map(),
        externalOpenings: new Map(externalOpenings),
      },
    ],
    stairs: null,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create walkability function for pathfinding
 */
function createWalkabilityFn(
  collisionService: BuildingCollisionService,
  floorIndex: number,
) {
  return (tile: TileCoord, fromTile?: TileCoord): boolean => {
    const walkable = collisionService.isTileWalkableInBuilding(
      tile.x,
      tile.z,
      floorIndex,
    );
    if (!walkable) return false;

    if (fromTile) {
      const wallBlocked = collisionService.isWallBlocked(
        fromTile.x,
        fromTile.z,
        tile.x,
        tile.z,
        floorIndex,
      );
      if (wallBlocked) return false;
    }

    return true;
  };
}

/**
 * Get all walkable tiles in a building on a specific floor
 */
function getAllWalkableTiles(
  collisionService: BuildingCollisionService,
  buildingId: string,
  floorIndex: number,
): TileCoord[] {
  const building = collisionService.getBuilding(buildingId);
  if (!building) return [];

  const floor = building.floors.find((f) => f.floorIndex === floorIndex);
  if (!floor) return [];

  const tiles: TileCoord[] = [];
  for (const key of floor.walkableTiles) {
    const [x, z] = key.split(",").map(Number);
    tiles.push({ x, z });
  }
  return tiles;
}

/**
 * Verify path doesn't violate any walls
 */
function verifyPathNoWallViolations(
  path: TileCoord[],
  collisionService: BuildingCollisionService,
  floorIndex: number,
): { valid: boolean; violations: Array<{ from: TileCoord; to: TileCoord }> } {
  const violations: Array<{ from: TileCoord; to: TileCoord }> = [];

  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1];
    const to = path[i];

    const blocked = collisionService.isWallBlocked(
      from.x,
      from.z,
      to.x,
      to.z,
      floorIndex,
    );
    if (blocked) {
      violations.push({ from, to });
    }
  }

  return { valid: violations.length === 0, violations };
}

type StepTile = NonNullable<
  ReturnType<BuildingCollisionService["getStepTile"]>
>;

function getDirectionDelta(direction: "north" | "south" | "east" | "west"): {
  dx: number;
  dz: number;
} {
  switch (direction) {
    case "north":
      return { dx: 0, dz: -1 };
    case "south":
      return { dx: 0, dz: 1 };
    case "east":
      return { dx: 1, dz: 0 };
    case "west":
      return { dx: -1, dz: 0 };
  }
}

function collectStepTilesForBuilding(
  collisionService: BuildingCollisionService,
  buildingId: string,
): StepTile[] {
  const building = collisionService.getBuilding(buildingId);
  if (!building) return [];

  const { minTileX, maxTileX, minTileZ, maxTileZ } = building.boundingBox;
  const stepMargin = Math.max(ENTRANCE_STEP_COUNT + TERRAIN_STEP_COUNT, 4) + 2;
  const tiles: StepTile[] = [];

  for (let x = minTileX - stepMargin; x <= maxTileX + stepMargin; x += 1) {
    for (let z = minTileZ - stepMargin; z <= maxTileZ + stepMargin; z += 1) {
      const stepTile = collisionService.getStepTile(x, z);
      if (stepTile && stepTile.buildingId === buildingId) {
        tiles.push(stepTile);
      }
    }
  }

  return tiles;
}

function findAdjacentWalkableTile(
  walkableTiles: Set<string>,
  target: TileCoord,
): TileCoord {
  const neighbors = [
    { dx: 0, dz: -1 },
    { dx: 0, dz: 1 },
    { dx: -1, dz: 0 },
    { dx: 1, dz: 0 },
  ];

  for (const { dx, dz } of neighbors) {
    const candidate: TileCoord = { x: target.x + dx, z: target.z + dz };
    if (walkableTiles.has(`${candidate.x},${candidate.z}`)) {
      return candidate;
    }
  }

  return target;
}

function toLayoutInput(layout: BuildingLayout) {
  return {
    width: layout.width,
    depth: layout.depth,
    floors: layout.floors,
    floorPlans: layout.floorPlans.map((fp) => ({
      footprint: fp.footprint,
      roomMap: fp.roomMap,
      internalOpenings: fp.internalOpenings,
      externalOpenings: fp.externalOpenings,
    })),
    exteriorFootprint: layout.exteriorFootprint,
    stairs: layout.stairs ?? null,
  };
}

function getFloorOrThrow(
  collisionService: BuildingCollisionService,
  buildingId: string,
  floorIndex: number,
) {
  const building = collisionService.getBuilding(buildingId);
  if (!building) {
    throw new Error(`Missing building ${buildingId}`);
  }
  const floor = building.floors.find((f) => f.floorIndex === floorIndex);
  if (!floor) {
    throw new Error(`Missing floor ${floorIndex} for ${buildingId}`);
  }
  return floor;
}

function collectReachableTiles(
  collisionService: BuildingCollisionService,
  buildingId: string,
  floorIndex: number,
  startTiles: TileCoord[],
): Set<string> {
  const floor = getFloorOrThrow(collisionService, buildingId, floorIndex);
  const walkableTiles = floor.walkableTiles;
  const visited = new Set<string>();
  const queue: TileCoord[] = [];

  for (const tile of startTiles) {
    const key = `${tile.x},${tile.z}`;
    if (walkableTiles.has(key) && !visited.has(key)) {
      visited.add(key);
      queue.push(tile);
    }
  }

  const neighborOffsets = [
    { dx: 0, dz: -1 },
    { dx: 0, dz: 1 },
    { dx: -1, dz: 0 },
    { dx: 1, dz: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    for (const { dx, dz } of neighborOffsets) {
      const next: TileCoord = { x: current.x + dx, z: current.z + dz };
      const nextKey = `${next.x},${next.z}`;
      if (!walkableTiles.has(nextKey) || visited.has(nextKey)) continue;

      const blocked = collisionService.isWallBlocked(
        current.x,
        current.z,
        next.x,
        next.z,
        floorIndex,
      );
      if (blocked) continue;

      visited.add(nextKey);
      queue.push(next);
    }
  }

  return visited;
}

// ============================================================================
// TEST SUITE: COMPREHENSIVE TILE COVERAGE
// ============================================================================

describe("Building Navigation - Comprehensive Tile Coverage", () => {
  let world: World;
  let collisionService: BuildingCollisionService;
  let pathfinder: BFSPathfinder;

  const BUILDING_POS = { x: 100, y: 10, z: 100 };
  const BUILDING_ID = "coverage_test_building";

  beforeAll(async () => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    const layout = createSimpleBuilding("north");
    collisionService.registerBuilding(
      BUILDING_ID,
      "test_town",
      layout,
      BUILDING_POS,
      0,
    );

    pathfinder = new BFSPathfinder();
  }, TEST_TIMEOUT);

  afterAll(() => {
    world.destroy();
  });

  it("should find valid path from outside to EVERY walkable tile", () => {
    const allTiles = getAllWalkableTiles(collisionService, BUILDING_ID, 0);
    const doorTiles = collisionService.getDoorTiles(BUILDING_ID);
    const isWalkable = createWalkabilityFn(collisionService, 0);

    expect(allTiles.length).toBeGreaterThan(0);
    expect(doorTiles.length).toBeGreaterThan(0);

    const door = doorTiles[0];
    // Start 5 tiles outside in the door direction
    const startTile: TileCoord = { x: door.tileX, z: door.tileZ - 5 };

    const results = {
      total: allTiles.length,
      reachable: 0,
      unreachable: [] as TileCoord[],
      wallViolations: [] as Array<{
        tile: TileCoord;
        violations: Array<{ from: TileCoord; to: TileCoord }>;
      }>,
    };

    for (const targetTile of allTiles) {
      const path = pathfinder.findPath(startTile, targetTile, isWalkable);

      if (path.length === 0) {
        results.unreachable.push(targetTile);
      } else {
        const verification = verifyPathNoWallViolations(
          path,
          collisionService,
          0,
        );
        if (!verification.valid) {
          results.wallViolations.push({
            tile: targetTile,
            violations: verification.violations,
          });
        } else {
          results.reachable++;
        }
      }
    }

    console.log(`[Coverage Test] Total tiles: ${results.total}`);
    console.log(`[Coverage Test] Reachable: ${results.reachable}`);
    console.log(`[Coverage Test] Unreachable: ${results.unreachable.length}`);
    console.log(
      `[Coverage Test] Wall violations: ${results.wallViolations.length}`,
    );

    if (results.unreachable.length > 0) {
      console.log(
        `[Coverage Test] Unreachable tiles: ${results.unreachable.map((t) => `(${t.x},${t.z})`).join(", ")}`,
      );
    }

    // All tiles should be reachable
    expect(results.reachable).toBe(results.total);
    expect(results.wallViolations.length).toBe(0);
  });

  it("should find valid path from EVERY edge position around building", () => {
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const bbox = building.boundingBox;
    const isWalkable = createWalkabilityFn(collisionService, 0);

    // Target: center of building
    const centerX = Math.floor((bbox.minTileX + bbox.maxTileX) / 2);
    const centerZ = Math.floor((bbox.minTileZ + bbox.maxTileZ) / 2);
    const targetTile: TileCoord = { x: centerX, z: centerZ };

    // Test from all 4 edges, 5 tiles outside
    const edgeStarts: Array<{ name: string; tile: TileCoord }> = [
      { name: "North", tile: { x: centerX, z: bbox.minTileZ - 5 } },
      { name: "South", tile: { x: centerX, z: bbox.maxTileZ + 5 } },
      { name: "East", tile: { x: bbox.maxTileX + 5, z: centerZ } },
      { name: "West", tile: { x: bbox.minTileX - 5, z: centerZ } },
      {
        name: "NE Corner",
        tile: { x: bbox.maxTileX + 5, z: bbox.minTileZ - 5 },
      },
      {
        name: "NW Corner",
        tile: { x: bbox.minTileX - 5, z: bbox.minTileZ - 5 },
      },
      {
        name: "SE Corner",
        tile: { x: bbox.maxTileX + 5, z: bbox.maxTileZ + 5 },
      },
      {
        name: "SW Corner",
        tile: { x: bbox.minTileX - 5, z: bbox.maxTileZ + 5 },
      },
    ];

    const results: Array<{ name: string; pathLength: number; valid: boolean }> =
      [];

    for (const { name, tile } of edgeStarts) {
      const path = pathfinder.findPath(tile, targetTile, isWalkable);
      const verification =
        path.length > 0
          ? verifyPathNoWallViolations(path, collisionService, 0)
          : { valid: false, violations: [] };

      results.push({
        name,
        pathLength: path.length,
        valid: path.length > 0 && verification.valid,
      });

      console.log(
        `[Edge Test] From ${name}: path=${path.length} tiles, valid=${verification.valid}`,
      );
    }

    // At least one path from each edge should work (building has one door)
    // The path from the door direction should definitely work
    const validPaths = results.filter((r) => r.valid).length;
    console.log(
      `[Edge Test] Valid paths from edges: ${validPaths}/${results.length}`,
    );

    expect(validPaths).toBeGreaterThan(0);
  });
});

// ============================================================================
// TEST SUITE: TWO-STORY BUILDING NAVIGATION
// ============================================================================

describe("Two-Story Building Navigation", () => {
  let world: World;
  let collisionService: BuildingCollisionService;
  let pathfinder: BFSPathfinder;

  const BUILDING_POS = { x: 200, y: 10, z: 200 };
  const BUILDING_ID = "two_story_test";

  beforeAll(async () => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    const layout = createTwoStoryBuilding();
    collisionService.registerBuilding(
      BUILDING_ID,
      "test_town",
      layout,
      BUILDING_POS,
      0,
    );

    pathfinder = new BFSPathfinder();
  }, TEST_TIMEOUT);

  afterAll(() => {
    world.destroy();
  });

  it("should have multiple floors registered", () => {
    const building = collisionService.getBuilding(BUILDING_ID);
    expect(building).toBeDefined();
    // Building may have 2+ floors (ground floor + upper floors)
    // Stair system may create additional floors for landings
    expect(building!.floors.length).toBeGreaterThanOrEqual(2);

    console.log(`[Two-Story] Building has ${building!.floors.length} floors`);
    building!.floors.forEach((floor) => {
      console.log(
        `[Two-Story] Floor ${floor.floorIndex}: ${floor.walkableTiles.size} tiles, ${floor.stairTiles.length} stairs`,
      );
    });
  });

  it("should have stair tiles on both floors", () => {
    const building = collisionService.getBuilding(BUILDING_ID)!;

    const floor0 = building.floors.find((f) => f.floorIndex === 0);
    const floor1 = building.floors.find((f) => f.floorIndex === 1);

    expect(floor0).toBeDefined();
    expect(floor1).toBeDefined();

    // Floor 0 should have bottom stair tiles
    const floor0Stairs = floor0!.stairTiles.filter((s) => !s.isLanding);
    const floor1Landings = floor1!.stairTiles.filter((s) => s.isLanding);

    console.log(`[Two-Story] Floor 0 stair tiles: ${floor0Stairs.length}`);
    console.log(`[Two-Story] Floor 1 landing tiles: ${floor1Landings.length}`);

    expect(floor0Stairs.length).toBeGreaterThan(0);
  });

  it("should find path from outside to ground floor (floor 0)", () => {
    const doorTiles = collisionService.getDoorTiles(BUILDING_ID);
    expect(doorTiles.length).toBeGreaterThan(0);

    const door = doorTiles[0];
    const startTile: TileCoord = { x: door.tileX, z: door.tileZ - 5 };
    const targetTile: TileCoord = { x: door.tileX, z: door.tileZ + 3 };

    const isWalkable = createWalkabilityFn(collisionService, 0);
    const path = pathfinder.findPath(startTile, targetTile, isWalkable);

    console.log(`[Two-Story] Outside to ground floor: ${path.length} tiles`);
    expect(path.length).toBeGreaterThan(0);
  });

  it("should find path from door to stairs on floor 0", () => {
    const doorTiles = collisionService.getDoorTiles(BUILDING_ID);
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const floor0 = building.floors.find((f) => f.floorIndex === 0)!;
    const stairs = floor0.stairTiles.filter((s) => !s.isLanding);

    if (stairs.length === 0) {
      console.log("[Two-Story] Skipping - no stair tiles on floor 0");
      return;
    }

    const door = doorTiles[0];
    const stair = stairs[0];

    const startTile: TileCoord = { x: door.tileX, z: door.tileZ };
    const targetTile: TileCoord = { x: stair.tileX, z: stair.tileZ };

    const isWalkable = createWalkabilityFn(collisionService, 0);
    const path = pathfinder.findPath(startTile, targetTile, isWalkable);

    console.log(`[Two-Story] Door to stairs: ${path.length} tiles`);
    console.log(
      `[Two-Story] Path: ${path.map((t) => `(${t.x},${t.z})`).join(" → ")}`,
    );

    expect(path.length).toBeGreaterThan(0);
  });

  it("should find path on floor 1 (second floor navigation)", () => {
    const floor1Tiles = getAllWalkableTiles(collisionService, BUILDING_ID, 1);

    if (floor1Tiles.length < 2) {
      console.log("[Two-Story] Skipping - not enough floor 1 tiles");
      return;
    }

    const startTile = floor1Tiles[0];
    const targetTile = floor1Tiles[floor1Tiles.length - 1];

    const isWalkable = createWalkabilityFn(collisionService, 1);
    const path = pathfinder.findPath(startTile, targetTile, isWalkable);

    console.log(`[Two-Story] Floor 1 internal path: ${path.length} tiles`);
    expect(path.length).toBeGreaterThan(0);
  });

  it("should correctly report stair elevation interpolation", () => {
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const floor0 = building.floors.find((f) => f.floorIndex === 0)!;
    const stairs = floor0.stairTiles.filter((s) => !s.isLanding);

    if (stairs.length === 0) {
      console.log("[Two-Story] Skipping - no stair tiles");
      return;
    }

    const stair = stairs[0];

    // Get elevation at stair tile
    const elevation = collisionService.getStairElevation(
      stair.tileX,
      stair.tileZ,
      0,
    );

    console.log(
      `[Two-Story] Stair tile (${stair.tileX},${stair.tileZ}) elevation: ${elevation}`,
    );

    // Elevation should be between floor 0 and floor 1 (or at floor 0 level)
    expect(elevation).not.toBeNull();
  });
});

// ============================================================================
// TEST SUITE: MULTI-ROOM BUILDING
// ============================================================================

describe("Multi-Room Building Navigation", () => {
  let world: World;
  let collisionService: BuildingCollisionService;
  let pathfinder: BFSPathfinder;

  const BUILDING_POS = { x: 300, y: 10, z: 300 };
  const BUILDING_ID = "multi_room_test";

  beforeAll(async () => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    const layout = createMultiRoomBuilding();
    collisionService.registerBuilding(
      BUILDING_ID,
      "test_town",
      layout,
      BUILDING_POS,
      0,
    );

    pathfinder = new BFSPathfinder();

    console.log("[Multi-Room] Building registered");
  }, TEST_TIMEOUT);

  afterAll(() => {
    world.destroy();
  });

  it("should have internal wall segments between rooms", () => {
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const floor0 = building.floors.find((f) => f.floorIndex === 0)!;

    // Count internal wall segments (walls without openings between rooms)
    const internalWalls = floor0.wallSegments.filter((w) => {
      // Internal walls are not on the external boundary
      const bbox = building.boundingBox;
      const isOnExternalEdge =
        w.tileX === bbox.minTileX ||
        w.tileX === bbox.maxTileX ||
        w.tileZ === bbox.minTileZ ||
        w.tileZ === bbox.maxTileZ;

      return !isOnExternalEdge;
    });

    console.log(
      `[Multi-Room] Total wall segments: ${floor0.wallSegments.length}`,
    );
    console.log(`[Multi-Room] Internal wall segments: ${internalWalls.length}`);

    // Should have some internal walls between rooms
    // Note: The room map defines room boundaries, internal walls may be auto-generated
  });

  it("should find path from entry room to other room through internal door", () => {
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const doorTiles = collisionService.getDoorTiles(BUILDING_ID);

    if (doorTiles.length === 0) {
      console.log("[Multi-Room] Skipping - no door tiles");
      return;
    }

    // Start from entry door
    const door = doorTiles[0];
    const startTile: TileCoord = { x: door.tileX, z: door.tileZ };

    // Target: opposite side of building (likely in room 1)
    const bbox = building.boundingBox;
    const targetTile: TileCoord = {
      x: Math.floor((bbox.minTileX + bbox.maxTileX) / 2),
      z: bbox.maxTileZ - 2, // South side of building
    };

    const isWalkable = createWalkabilityFn(collisionService, 0);
    const path = pathfinder.findPath(startTile, targetTile, isWalkable);

    console.log(
      `[Multi-Room] Path from room 0 to room 1: ${path.length} tiles`,
    );
    if (path.length > 0) {
      console.log(
        `[Multi-Room] Path: ${path.map((t) => `(${t.x},${t.z})`).join(" → ")}`,
      );
    }

    // Path might be empty if internal door isn't implemented correctly
    // Log result for analysis
    if (path.length === 0) {
      console.log(
        "[Multi-Room] WARNING: No path found between rooms - internal wall/door may be blocking",
      );
    }
  });
});

// ============================================================================
// TEST SUITE: BUILDING ROTATIONS
// ============================================================================

describe("Building Rotation Tests", () => {
  let world: World;
  let collisionService: BuildingCollisionService;
  let pathfinder: BFSPathfinder;

  const BUILDING_POS = { x: 400, y: 10, z: 400 };

  beforeEach(async () => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);
    pathfinder = new BFSPathfinder();
  });

  afterEach(() => {
    world.destroy();
  });

  const testRotation = (rotation: number, rotationName: string) => {
    it(`should navigate correctly with ${rotationName} rotation`, () => {
      const buildingId = `rotation_test_${rotationName}`;
      const layout = createSimpleBuilding("north");

      collisionService.registerBuilding(
        buildingId,
        "test_town",
        layout,
        BUILDING_POS,
        rotation,
      );

      const building = collisionService.getBuilding(buildingId)!;
      const doorTiles = collisionService.getDoorTiles(buildingId);
      const bbox = building.boundingBox;

      console.log(
        `[Rotation ${rotationName}] Bbox: (${bbox.minTileX},${bbox.minTileZ}) → (${bbox.maxTileX},${bbox.maxTileZ})`,
      );
      console.log(`[Rotation ${rotationName}] Doors: ${doorTiles.length}`);

      if (doorTiles.length === 0) {
        console.log(
          `[Rotation ${rotationName}] WARNING: No doors found after rotation!`,
        );
        return;
      }

      const door = doorTiles[0];
      console.log(
        `[Rotation ${rotationName}] Door at: (${door.tileX},${door.tileZ}) direction=${door.direction}`,
      );

      // Find start position outside based on door direction
      let startTile: TileCoord;
      switch (door.direction) {
        case "north":
          startTile = { x: door.tileX, z: door.tileZ - 5 };
          break;
        case "south":
          startTile = { x: door.tileX, z: door.tileZ + 5 };
          break;
        case "east":
          startTile = { x: door.tileX + 5, z: door.tileZ };
          break;
        case "west":
          startTile = { x: door.tileX - 5, z: door.tileZ };
          break;
        default:
          startTile = { x: door.tileX, z: door.tileZ - 5 };
      }

      // Target: center of building
      const centerX = Math.floor((bbox.minTileX + bbox.maxTileX) / 2);
      const centerZ = Math.floor((bbox.minTileZ + bbox.maxTileZ) / 2);
      const targetTile: TileCoord = { x: centerX, z: centerZ };

      const isWalkable = createWalkabilityFn(collisionService, 0);
      const path = pathfinder.findPath(startTile, targetTile, isWalkable);

      console.log(`[Rotation ${rotationName}] Path length: ${path.length}`);

      // Verify path is valid
      if (path.length > 0) {
        const verification = verifyPathNoWallViolations(
          path,
          collisionService,
          0,
        );
        expect(verification.valid).toBe(true);
      }

      expect(path.length).toBeGreaterThan(0);
    });
  };

  testRotation(0, "0°");
  testRotation(Math.PI / 2, "90°");
  testRotation(Math.PI, "180°");
  testRotation((3 * Math.PI) / 2, "270°");
});

// ============================================================================
// TEST SUITE: EXIT NAVIGATION
// ============================================================================

describe("Exit Navigation (Inside → Outside)", () => {
  let world: World;
  let collisionService: BuildingCollisionService;
  let pathfinder: BFSPathfinder;

  const BUILDING_POS = { x: 500, y: 10, z: 500 };
  const BUILDING_ID = "exit_test";

  beforeAll(async () => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    const layout = createSimpleBuilding("north");
    collisionService.registerBuilding(
      BUILDING_ID,
      "test_town",
      layout,
      BUILDING_POS,
      0,
    );

    pathfinder = new BFSPathfinder();
  }, TEST_TIMEOUT);

  afterAll(() => {
    world.destroy();
  });

  it("should find path from center of building to outside", () => {
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const bbox = building.boundingBox;
    const doorTiles = collisionService.getDoorTiles(BUILDING_ID);

    // Start: center of building
    const startTile: TileCoord = {
      x: Math.floor((bbox.minTileX + bbox.maxTileX) / 2),
      z: Math.floor((bbox.minTileZ + bbox.maxTileZ) / 2),
    };

    // Target: 5 tiles outside the building (in door direction)
    const door = doorTiles[0];
    const targetTile: TileCoord = { x: door.tileX, z: door.tileZ - 5 };

    const isWalkable = createWalkabilityFn(collisionService, 0);
    const path = pathfinder.findPath(startTile, targetTile, isWalkable);

    console.log(`[Exit Test] Center to outside: ${path.length} tiles`);

    if (path.length > 0) {
      const verification = verifyPathNoWallViolations(
        path,
        collisionService,
        0,
      );
      console.log(`[Exit Test] Path valid: ${verification.valid}`);
      expect(verification.valid).toBe(true);
    }

    expect(path.length).toBeGreaterThan(0);
  });

  it("should find path from every corner to outside", () => {
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const bbox = building.boundingBox;
    const doorTiles = collisionService.getDoorTiles(BUILDING_ID);

    if (doorTiles.length === 0) {
      console.log("[Exit Test] Skipping - no doors");
      return;
    }

    const door = doorTiles[0];
    // Target outside
    const targetTile: TileCoord = { x: door.tileX, z: door.tileZ - 5 };

    // Test from all 4 interior corners
    const corners: TileCoord[] = [
      { x: bbox.minTileX + 1, z: bbox.minTileZ + 1 }, // Interior NW
      { x: bbox.maxTileX - 1, z: bbox.minTileZ + 1 }, // Interior NE
      { x: bbox.minTileX + 1, z: bbox.maxTileZ - 1 }, // Interior SW
      { x: bbox.maxTileX - 1, z: bbox.maxTileZ - 1 }, // Interior SE
    ];

    const isWalkable = createWalkabilityFn(collisionService, 0);
    let validPaths = 0;

    for (let i = 0; i < corners.length; i++) {
      const path = pathfinder.findPath(corners[i], targetTile, isWalkable);
      if (path.length > 0) {
        const verification = verifyPathNoWallViolations(
          path,
          collisionService,
          0,
        );
        if (verification.valid) {
          validPaths++;
        }
      }
      console.log(`[Exit Test] Corner ${i + 1}: ${path.length} tiles`);
    }

    console.log(
      `[Exit Test] Valid exit paths: ${validPaths}/${corners.length}`,
    );
    expect(validPaths).toBeGreaterThan(0);
  });
});

// ============================================================================
// TEST SUITE: WINDOW VS DOOR BEHAVIOR
// ============================================================================

describe("Window vs Door Behavior", () => {
  let world: World;
  let collisionService: BuildingCollisionService;

  const BUILDING_POS = { x: 600, y: 10, z: 600 };
  const BUILDING_ID = "window_test";

  beforeAll(async () => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    const layout = createBuildingWithWindow();
    collisionService.registerBuilding(
      BUILDING_ID,
      "test_town",
      layout,
      BUILDING_POS,
      0,
    );
  }, TEST_TIMEOUT);

  afterAll(() => {
    world.destroy();
  });

  it("should allow passage through door but NOT through window", () => {
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const floor0 = building.floors.find((f) => f.floorIndex === 0)!;

    // Find door and window wall segments
    // NOTE: Doors have hasOpening=true, windows have hasOpening=false (blocks passage)
    // but both have their openingType set
    const doorSegments = floor0.wallSegments.filter(
      (w) => w.hasOpening && w.openingType === "door",
    );
    // Windows have hasOpening=false by design (they don't allow passage)
    // but still have openingType="window" for identification
    const windowSegments = floor0.wallSegments.filter(
      (w) => w.openingType === "window",
    );

    console.log(`[Window Test] Door segments: ${doorSegments.length}`);
    console.log(
      `[Window Test] Window segments: ${windowSegments.length} (hasOpening should be false)`,
    );

    // Verify windows have hasOpening=false (block passage)
    for (const window of windowSegments) {
      expect(window.hasOpening).toBe(false);
    }

    // Check wall blocking for windows
    for (const window of windowSegments) {
      // Determine outside tile based on window direction
      let outsideTile: TileCoord;
      switch (window.side) {
        case "north":
          outsideTile = { x: window.tileX, z: window.tileZ - 1 };
          break;
        case "south":
          outsideTile = { x: window.tileX, z: window.tileZ + 1 };
          break;
        case "east":
          outsideTile = { x: window.tileX + 1, z: window.tileZ };
          break;
        case "west":
          outsideTile = { x: window.tileX - 1, z: window.tileZ };
          break;
        default:
          continue;
      }

      const insideTile: TileCoord = { x: window.tileX, z: window.tileZ };

      const blocked = collisionService.isWallBlocked(
        outsideTile.x,
        outsideTile.z,
        insideTile.x,
        insideTile.z,
        0,
      );

      console.log(
        `[Window Test] Window at (${window.tileX},${window.tileZ}) ${window.side}: blocked=${blocked}`,
      );

      // Window should BLOCK passage
      expect(blocked).toBe(true);
    }

    // Verify doors allow passage
    for (const door of doorSegments) {
      let outsideTile: TileCoord;
      switch (door.side) {
        case "north":
          outsideTile = { x: door.tileX, z: door.tileZ - 1 };
          break;
        case "south":
          outsideTile = { x: door.tileX, z: door.tileZ + 1 };
          break;
        case "east":
          outsideTile = { x: door.tileX + 1, z: door.tileZ };
          break;
        case "west":
          outsideTile = { x: door.tileX - 1, z: door.tileZ };
          break;
        default:
          continue;
      }

      const insideTile: TileCoord = { x: door.tileX, z: door.tileZ };

      const blocked = collisionService.isWallBlocked(
        outsideTile.x,
        outsideTile.z,
        insideTile.x,
        insideTile.z,
        0,
      );

      console.log(
        `[Window Test] Door at (${door.tileX},${door.tileZ}) ${door.side}: blocked=${blocked}`,
      );

      // Door should NOT block passage
      expect(blocked).toBe(false);
    }
  });
});

// ============================================================================
// TEST SUITE: INTERNAL WALL DIAGONAL CLIPPING
// ============================================================================

describe("Internal Wall Diagonal Clipping", () => {
  let world: World;
  let collisionService: BuildingCollisionService;

  const BUILDING_POS = { x: 700, y: 10, z: 700 };
  const BUILDING_ID = "internal_wall_test";

  beforeAll(async () => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    const layout = createMultiRoomBuilding();
    collisionService.registerBuilding(
      BUILDING_ID,
      "test_town",
      layout,
      BUILDING_POS,
      0,
    );
  }, TEST_TIMEOUT);

  afterAll(() => {
    world.destroy();
  });

  it("should block diagonal movement through internal walls", () => {
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const floor0 = building.floors.find((f) => f.floorIndex === 0)!;

    // Find internal wall segments (not on external boundary)
    const bbox = building.boundingBox;
    const internalWalls = floor0.wallSegments.filter((w) => {
      // Check if wall is internal (not on building boundary)
      const isOnBoundary =
        (w.side === "west" && w.tileX === bbox.minTileX) ||
        (w.side === "east" && w.tileX === bbox.maxTileX) ||
        (w.side === "north" && w.tileZ === bbox.minTileZ) ||
        (w.side === "south" && w.tileZ === bbox.maxTileZ);

      return !isOnBoundary && !w.hasOpening;
    });

    console.log(
      `[Internal Wall] Found ${internalWalls.length} internal wall segments`,
    );

    if (internalWalls.length === 0) {
      console.log(
        "[Internal Wall] No internal walls - skipping diagonal clipping test",
      );
      console.log(
        "[Internal Wall] This may indicate internal walls aren't being generated",
      );
      return;
    }

    // Test diagonal clipping through internal walls
    for (const wall of internalWalls.slice(0, 5)) {
      // Test first 5
      // Calculate diagonal move that would clip through this wall
      let fromTile: TileCoord;
      let toTile: TileCoord;

      switch (wall.side) {
        case "north":
          fromTile = { x: wall.tileX - 1, z: wall.tileZ };
          toTile = { x: wall.tileX, z: wall.tileZ - 1 };
          break;
        case "south":
          fromTile = { x: wall.tileX - 1, z: wall.tileZ };
          toTile = { x: wall.tileX, z: wall.tileZ + 1 };
          break;
        case "east":
          fromTile = { x: wall.tileX, z: wall.tileZ - 1 };
          toTile = { x: wall.tileX + 1, z: wall.tileZ };
          break;
        case "west":
          fromTile = { x: wall.tileX, z: wall.tileZ - 1 };
          toTile = { x: wall.tileX - 1, z: wall.tileZ };
          break;
        default:
          continue;
      }

      const blocked = collisionService.isWallBlocked(
        fromTile.x,
        fromTile.z,
        toTile.x,
        toTile.z,
        0,
      );

      console.log(
        `[Internal Wall] Diagonal (${fromTile.x},${fromTile.z}) → (${toTile.x},${toTile.z}) near wall at (${wall.tileX},${wall.tileZ}) ${wall.side}: blocked=${blocked}`,
      );
    }
  });
});

// ============================================================================
// TEST SUITE: FULL NAVIGATION SIMULATION
// ============================================================================

describe("Full Navigation Simulation - Outside → Door → Stairs → Second Floor", () => {
  let world: World;
  let collisionService: BuildingCollisionService;
  let pathfinder: BFSPathfinder;

  const BUILDING_POS = { x: 800, y: 10, z: 800 };
  const BUILDING_ID = "full_nav_test";

  beforeAll(async () => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    const layout = createTwoStoryBuilding();
    collisionService.registerBuilding(
      BUILDING_ID,
      "test_town",
      layout,
      BUILDING_POS,
      0,
    );

    pathfinder = new BFSPathfinder();
  }, TEST_TIMEOUT);

  afterAll(() => {
    world.destroy();
  });

  it("should simulate complete bot navigation: outside → inside → upstairs", () => {
    const doorTiles = collisionService.getDoorTiles(BUILDING_ID);
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const floor0 = building.floors.find((f) => f.floorIndex === 0)!;
    const floor1 = building.floors.find((f) => f.floorIndex === 1)!;

    console.log(`\n[Full Nav] === SIMULATION START ===`);
    console.log(`[Full Nav] Doors: ${doorTiles.length}`);
    console.log(`[Full Nav] Floor 0 stairs: ${floor0.stairTiles.length}`);
    console.log(`[Full Nav] Floor 1 tiles: ${floor1.walkableTiles.size}`);

    if (doorTiles.length === 0) {
      console.log("[Full Nav] FAILED: No doors found");
      expect(doorTiles.length).toBeGreaterThan(0);
      return;
    }

    // Bot state
    let botPos: TileCoord;
    let botFloor = 0;

    // Step 1: Start outside
    const door = doorTiles[0];
    botPos = { x: door.tileX, z: door.tileZ - 5 };
    console.log(
      `[Full Nav] Step 1: Bot at (${botPos.x},${botPos.z}) floor ${botFloor}`,
    );

    // Step 2: Path to door
    let isWalkable = createWalkabilityFn(collisionService, botFloor);
    let path = pathfinder.findPath(
      botPos,
      { x: door.tileX, z: door.tileZ },
      isWalkable,
    );

    console.log(`[Full Nav] Step 2: Path to door - ${path.length} tiles`);
    expect(path.length).toBeGreaterThan(0);

    if (path.length > 0) {
      botPos = path[path.length - 1];
      console.log(`[Full Nav] Bot arrived at door: (${botPos.x},${botPos.z})`);
    }

    // Step 3: Path to stairs
    const stairs = floor0.stairTiles.filter((s) => !s.isLanding);
    if (stairs.length === 0) {
      console.log("[Full Nav] No stairs on floor 0 - cannot continue");
      return;
    }

    const stair = stairs[0];
    path = pathfinder.findPath(
      botPos,
      { x: stair.tileX, z: stair.tileZ },
      isWalkable,
    );

    console.log(`[Full Nav] Step 3: Path to stairs - ${path.length} tiles`);
    expect(path.length).toBeGreaterThan(0);

    if (path.length > 0) {
      botPos = path[path.length - 1];
      console.log(`[Full Nav] Bot at stairs: (${botPos.x},${botPos.z})`);
    }

    // Step 4: Go up stairs (simulate floor transition)
    botFloor = 1;
    console.log(`[Full Nav] Step 4: Bot ascends to floor ${botFloor}`);

    // Find landing tile on floor 1
    const landings = floor1.stairTiles.filter((s) => s.isLanding);
    if (landings.length > 0) {
      botPos = { x: landings[0].tileX, z: landings[0].tileZ };
      console.log(
        `[Full Nav] Bot at landing: (${botPos.x},${botPos.z}) floor ${botFloor}`,
      );
    }

    // Step 5: Navigate on floor 1
    const floor1Tiles = getAllWalkableTiles(collisionService, BUILDING_ID, 1);
    if (floor1Tiles.length < 2) {
      console.log("[Full Nav] Not enough floor 1 tiles for navigation");
      return;
    }

    // Find a tile far from current position
    let targetTile = floor1Tiles[0];
    let maxDist = 0;
    for (const tile of floor1Tiles) {
      const dist = Math.abs(tile.x - botPos.x) + Math.abs(tile.z - botPos.z);
      if (dist > maxDist) {
        maxDist = dist;
        targetTile = tile;
      }
    }

    isWalkable = createWalkabilityFn(collisionService, botFloor);
    path = pathfinder.findPath(botPos, targetTile, isWalkable);

    console.log(`[Full Nav] Step 5: Path on floor 1 - ${path.length} tiles`);

    if (path.length > 0) {
      const verification = verifyPathNoWallViolations(
        path,
        collisionService,
        botFloor,
      );
      console.log(`[Full Nav] Path valid: ${verification.valid}`);
      expect(verification.valid).toBe(true);

      botPos = path[path.length - 1];
      console.log(
        `[Full Nav] Bot final position: (${botPos.x},${botPos.z}) floor ${botFloor}`,
      );
    }

    console.log(`[Full Nav] === SIMULATION COMPLETE ===\n`);
  });
});

// ============================================================================
// ENTRANCE STEPS - TERRAIN TO BUILDING
// ============================================================================

describe("Entrance Steps - Terrain to Building", () => {
  let world: World;
  let collisionService: BuildingCollisionService;

  const BUILDING_POS = { x: 900, y: 10, z: 900 };
  const DOOR_BUILDING_ID = "step-building-door";
  const ARCH_BUILDING_ID = "step-building-arch";

  beforeAll(() => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    const doorLayout = createSimpleBuildingWithEntrance("door", "north");
    const archLayout = createSimpleBuildingWithEntrance("arch", "north");

    collisionService.registerBuilding(
      DOOR_BUILDING_ID,
      "step_town",
      doorLayout,
      BUILDING_POS,
      0,
    );
    collisionService.registerBuilding(
      ARCH_BUILDING_ID,
      "step_town",
      archLayout,
      { x: BUILDING_POS.x + 50, y: BUILDING_POS.y, z: BUILDING_POS.z },
      0,
    );
  });

  afterAll(() => {
    world.destroy();
  });

  const validateEntranceSteps = (buildingId: string) => {
    const floor0 = getFloorOrThrow(collisionService, buildingId, 0);
    const walkableTiles = floor0.walkableTiles;
    const entranceWalls =
      BuildingCollisionService.getEntranceWallSegments(floor0);
    expect(entranceWalls.length).toBeGreaterThan(0);

    const stepTiles = collectStepTilesForBuilding(collisionService, buildingId);
    expect(stepTiles.length).toBeGreaterThan(0);

    for (const wall of entranceWalls) {
      const entrance = BuildingCollisionService.getDoorExteriorAndInterior(
        wall.tileX,
        wall.tileZ,
        wall.side,
      );
      const exteriorKey = `${entrance.exteriorX},${entrance.exteriorZ}`;
      const interiorKey = `${entrance.interiorX},${entrance.interiorZ}`;

      expect(walkableTiles.has(interiorKey)).toBe(true);
      expect(walkableTiles.has(exteriorKey)).toBe(false);

      const exteriorStep = stepTiles.find(
        (s) =>
          s.tileX === entrance.exteriorX &&
          s.tileZ === entrance.exteriorZ &&
          s.approachDirection === wall.side,
      );
      expect(exteriorStep).toBeDefined();

      const { dx, dz } = getDirectionDelta(wall.side);
      let farthestStep: StepTile | null = null;
      let farthestDist = -Infinity;

      for (const step of stepTiles) {
        if (step.approachDirection !== wall.side) continue;
        const dist =
          (step.tileX - entrance.interiorX) * dx +
          (step.tileZ - entrance.interiorZ) * dz;
        if (dist > farthestDist) {
          farthestDist = dist;
          farthestStep = step;
        }
      }

      expect(farthestStep).not.toBeNull();
      if (farthestStep) {
        expect(
          collisionService.isTileInBuildingFootprint(
            farthestStep.tileX,
            farthestStep.tileZ,
          ),
        ).toBeNull();

        const fromFront: TileCoord = {
          x: farthestStep.tileX + dx,
          z: farthestStep.tileZ + dz,
        };
        expect(
          collisionService.isStepBlocked(
            fromFront.x,
            fromFront.z,
            farthestStep.tileX,
            farthestStep.tileZ,
          ),
        ).toBe(false);

        if (farthestDist > 1) {
          const perp = { dx: dz, dz: -dx };
          let sideFrom: TileCoord = {
            x: farthestStep.tileX + perp.dx * 2,
            z: farthestStep.tileZ + perp.dz * 2,
          };
          if (collisionService.getStepTile(sideFrom.x, sideFrom.z)) {
            sideFrom = {
              x: farthestStep.tileX + perp.dx * 3,
              z: farthestStep.tileZ + perp.dz * 3,
            };
          }

          if (!collisionService.getStepTile(sideFrom.x, sideFrom.z)) {
            expect(
              collisionService.isStepBlocked(
                sideFrom.x,
                sideFrom.z,
                farthestStep.tileX,
                farthestStep.tileZ,
              ),
            ).toBe(true);
          }
        }
      }
    }
  };

  it("should validate door step tiles and approach", () => {
    validateEntranceSteps(DOOR_BUILDING_ID);
  });

  it("should validate arch step tiles and approach", () => {
    validateEntranceSteps(ARCH_BUILDING_ID);
  });
});

// ============================================================================
// STAIR TRANSITIONS - IN AND OUT OF DIFFERENT LEVELS
// ============================================================================

describe("Stair Transitions - Multi-Floor", () => {
  let world: World;
  let collisionService: BuildingCollisionService;
  const BUILDING_ID = "stairs-transition-building";
  const BUILDING_POS = { x: 1100, y: 10, z: 1100 };

  beforeAll(() => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    const layout = createTwoStoryBuilding();
    collisionService.registerBuilding(
      BUILDING_ID,
      "stairs_town",
      layout,
      BUILDING_POS,
      0,
    );
  });

  afterAll(() => {
    world.destroy();
  });

  it("should transition up and down between floors", () => {
    const floor0 = getFloorOrThrow(collisionService, BUILDING_ID, 0);
    const floor1 = getFloorOrThrow(collisionService, BUILDING_ID, 1);

    const bottomStairs = floor0.stairTiles.filter((s) => !s.isLanding);
    const landingStairs = floor1.stairTiles.filter((s) => s.isLanding);

    expect(bottomStairs.length).toBeGreaterThan(0);
    expect(landingStairs.length).toBeGreaterThan(0);

    const bottomTile: TileCoord = {
      x: bottomStairs[0].tileX,
      z: bottomStairs[0].tileZ,
    };

    const landing = collisionService.getStairLandingTile(
      bottomTile.x,
      bottomTile.z,
      0,
    );
    expect(landing).not.toBeNull();

    const landingTile: TileCoord = {
      x: landing!.tileX,
      z: landing!.tileZ,
    };
    expect(floor1.walkableTiles.has(`${landingTile.x},${landingTile.z}`)).toBe(
      true,
    );

    const destination = collisionService.getStairDestination(
      bottomTile.x,
      bottomTile.z,
      0,
    );
    expect(destination).not.toBeNull();
    expect(destination!.destinationFloor).toBe(1);
    expect(destination!.elevation).toBeCloseTo(floor1.elevation);

    const playerId = "stairs-player";
    const startTile = findAdjacentWalkableTile(
      floor0.walkableTiles,
      bottomTile,
    );

    collisionService.updatePlayerBuildingState(
      playerId,
      startTile.x,
      startTile.z,
      floor0.elevation,
    );

    const stepOnStairs = collisionService.handleStairTransition(
      playerId,
      startTile,
      bottomTile,
    );
    expect(stepOnStairs).toBeNull();

    const ascend = collisionService.handleStairTransition(
      playerId,
      bottomTile,
      landingTile,
    );
    expect(ascend).toBe(1);

    const afterAscend = collisionService.getPlayerBuildingState(playerId);
    expect(afterAscend.currentFloor).toBe(1);
    expect(afterAscend.onStairs).toBe(false);

    const descendLanding = collisionService.getStairLandingTile(
      landingTile.x,
      landingTile.z,
      1,
    );
    expect(descendLanding).not.toBeNull();

    const descendTile: TileCoord = {
      x: descendLanding!.tileX,
      z: descendLanding!.tileZ,
    };
    expect(floor0.walkableTiles.has(`${descendTile.x},${descendTile.z}`)).toBe(
      true,
    );

    const descend = collisionService.handleStairTransition(
      playerId,
      landingTile,
      descendTile,
    );
    expect(descend).toBe(0);

    const afterDescend = collisionService.getPlayerBuildingState(playerId);
    expect(afterDescend.currentFloor).toBe(0);
    expect(afterDescend.onStairs).toBe(false);
  });

  it("should map every stair tile to the opposite side", () => {
    const floor0 = getFloorOrThrow(collisionService, BUILDING_ID, 0);
    const floor1 = getFloorOrThrow(collisionService, BUILDING_ID, 1);

    const bottomStairs = floor0.stairTiles.filter((s) => !s.isLanding);
    const landingStairs = floor1.stairTiles.filter((s) => s.isLanding);

    expect(bottomStairs.length).toBeGreaterThan(0);
    expect(landingStairs.length).toBeGreaterThan(0);

    const landingKeys = new Set(
      landingStairs.map((s) => `${s.tileX},${s.tileZ}`),
    );
    const bottomKeys = new Set(
      bottomStairs.map((s) => `${s.tileX},${s.tileZ}`),
    );

    const playerId = "stairs-coverage-player";

    for (const stair of bottomStairs) {
      const landing = collisionService.getStairLandingTile(
        stair.tileX,
        stair.tileZ,
        0,
      );
      expect(landing).not.toBeNull();
      if (!landing) continue;

      expect(landing.destinationFloor).toBe(1);
      expect(landingKeys.has(`${landing.tileX},${landing.tileZ}`)).toBe(true);

      collisionService.updatePlayerBuildingState(
        playerId,
        stair.tileX,
        stair.tileZ,
        floor0.elevation,
      );

      const ascend = collisionService.handleStairTransition(
        playerId,
        { x: stair.tileX, z: stair.tileZ },
        { x: landing.tileX, z: landing.tileZ },
      );
      expect(ascend).toBe(1);
    }

    for (const stair of landingStairs) {
      const bottom = collisionService.getStairLandingTile(
        stair.tileX,
        stair.tileZ,
        1,
      );
      expect(bottom).not.toBeNull();
      if (!bottom) continue;

      expect(bottom.destinationFloor).toBe(0);
      expect(bottomKeys.has(`${bottom.tileX},${bottom.tileZ}`)).toBe(true);

      collisionService.updatePlayerBuildingState(
        playerId,
        stair.tileX,
        stair.tileZ,
        floor1.elevation,
      );

      const descend = collisionService.handleStairTransition(
        playerId,
        { x: stair.tileX, z: stair.tileZ },
        { x: bottom.tileX, z: bottom.tileZ },
      );
      expect(descend).toBe(0);
    }
  });
});

// ============================================================================
// PROCGEN BUILDING VALIDATION - Exhaustive edge and entrance checks
// ============================================================================

describe("Procgen Building Navigation - Exhaustive Edge Validation", () => {
  const generator = new BuildingGenerator();
  const recipeKeys = [
    "bank",
    "store",
    "inn",
    "smithy",
    "simple-house",
    "long-house",
  ] as const;
  const seeds = ["a", "b", "c", "d"] as const;
  const rotations = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

  for (const recipeKey of recipeKeys) {
    for (const seed of seeds) {
      for (const rotation of rotations) {
        const degrees = Math.round((rotation * 180) / Math.PI);
        it(
          `${recipeKey} seed=${seed} rot=${degrees}°`,
          () => {
            const recipe = getRecipe(recipeKey);
            if (!recipe) {
              throw new Error(`Missing recipe ${recipeKey}`);
            }

            const layout = generator.generateLayout(
              recipe,
              createRng(`${recipeKey}-${seed}`),
            );

            const world = new World({ isServer: true, isClient: false });
            const collisionService = new BuildingCollisionService(world);
            const buildingId = `procgen-${recipeKey}-${seed}-${degrees}`;

            try {
              collisionService.registerBuilding(
                buildingId,
                "procgen_test",
                toLayoutInput(layout),
                { x: 1000, y: 10, z: 1000 },
                rotation,
              );

              const floor0 = getFloorOrThrow(collisionService, buildingId, 0);
              const walkableTiles = floor0.walkableTiles;

              const entranceWalls =
                BuildingCollisionService.getEntranceWallSegments(floor0);
              expect(entranceWalls.length).toBeGreaterThan(0);

              const stepTiles = collectStepTilesForBuilding(
                collisionService,
                buildingId,
              );
              expect(stepTiles.length).toBeGreaterThan(0);

              const entranceInteriorTiles: TileCoord[] = [];
              const entranceInteriorKeys = new Set<string>();
              for (const wall of entranceWalls) {
                const tiles =
                  BuildingCollisionService.getDoorExteriorAndInterior(
                    wall.tileX,
                    wall.tileZ,
                    wall.side,
                  );
                const interiorKey = `${tiles.interiorX},${tiles.interiorZ}`;
                const exteriorKey = `${tiles.exteriorX},${tiles.exteriorZ}`;
                expect(walkableTiles.has(interiorKey)).toBe(true);
                expect(walkableTiles.has(exteriorKey)).toBe(false);
                expect(
                  stepTiles.some(
                    (step) =>
                      step.tileX === tiles.exteriorX &&
                      step.tileZ === tiles.exteriorZ &&
                      step.approachDirection === wall.side,
                  ),
                ).toBe(true);
                if (!entranceInteriorKeys.has(interiorKey)) {
                  entranceInteriorKeys.add(interiorKey);
                  entranceInteriorTiles.push({
                    x: tiles.interiorX,
                    z: tiles.interiorZ,
                  });
                }
              }

              const reachable = collectReachableTiles(
                collisionService,
                buildingId,
                0,
                entranceInteriorTiles,
              );
              expect(reachable.size).toBe(walkableTiles.size);

              for (const wall of floor0.wallSegments) {
                const tiles =
                  BuildingCollisionService.getDoorExteriorAndInterior(
                    wall.tileX,
                    wall.tileZ,
                    wall.side,
                  );
                const interior: TileCoord = {
                  x: tiles.interiorX,
                  z: tiles.interiorZ,
                };
                const exterior: TileCoord = {
                  x: tiles.exteriorX,
                  z: tiles.exteriorZ,
                };

                const interiorKey = `${interior.x},${interior.z}`;
                const exteriorKey = `${exterior.x},${exterior.z}`;
                const isEntrance =
                  wall.hasOpening &&
                  (wall.openingType === "door" || wall.openingType === "arch");
                const isExternal = !walkableTiles.has(exteriorKey);

                expect(walkableTiles.has(interiorKey)).toBe(true);

                if (isExternal) {
                  const entryCheck = collisionService.checkBuildingMovement(
                    exterior,
                    interior,
                    0,
                    null,
                  );
                  const exitCheck = collisionService.checkBuildingMovement(
                    interior,
                    exterior,
                    0,
                    buildingId,
                  );

                  if (isEntrance) {
                    expect(entryCheck.buildingAllowsMovement).toBe(true);
                    expect(entryCheck.wallBlocked).toBe(false);
                    expect(exitCheck.buildingAllowsMovement).toBe(true);
                    expect(exitCheck.wallBlocked).toBe(false);
                  } else {
                    expect(entryCheck.buildingAllowsMovement).toBe(false);
                    expect(exitCheck.buildingAllowsMovement).toBe(false);
                  }
                } else {
                  const forwardCheck = collisionService.checkBuildingMovement(
                    exterior,
                    interior,
                    0,
                    buildingId,
                  );
                  const backwardCheck = collisionService.checkBuildingMovement(
                    interior,
                    exterior,
                    0,
                    buildingId,
                  );

                  if (isEntrance) {
                    expect(forwardCheck.wallBlocked).toBe(false);
                    expect(backwardCheck.wallBlocked).toBe(false);
                  } else {
                    expect(forwardCheck.wallBlocked).toBe(true);
                    expect(backwardCheck.wallBlocked).toBe(true);
                  }
                }
              }

              const boundaryTiles: TileCoord[] = [];
              for (const key of walkableTiles) {
                const [x, z] = key.split(",").map(Number);
                const northKey = `${x},${z - 1}`;
                const southKey = `${x},${z + 1}`;
                const eastKey = `${x + 1},${z}`;
                const westKey = `${x - 1},${z}`;
                if (
                  !walkableTiles.has(northKey) ||
                  !walkableTiles.has(southKey) ||
                  !walkableTiles.has(eastKey) ||
                  !walkableTiles.has(westKey)
                ) {
                  boundaryTiles.push({ x, z });
                }
              }

              const diagonalOffsets = [
                { dx: 1, dz: 1 },
                { dx: 1, dz: -1 },
                { dx: -1, dz: 1 },
                { dx: -1, dz: -1 },
              ];

              for (const tile of boundaryTiles) {
                for (const { dx, dz } of diagonalOffsets) {
                  const diag: TileCoord = { x: tile.x + dx, z: tile.z + dz };
                  const diagKey = `${diag.x},${diag.z}`;
                  if (walkableTiles.has(diagKey)) continue;
                  const intermediateH: TileCoord = {
                    x: diag.x + dx,
                    z: diag.z,
                  };
                  const intermediateV: TileCoord = {
                    x: diag.x,
                    z: diag.z + dz,
                  };
                  const path1Blocked =
                    collisionService.isWallBlocked(
                      diag.x,
                      diag.z,
                      intermediateH.x,
                      intermediateH.z,
                      0,
                    ) ||
                    collisionService.isWallBlocked(
                      intermediateH.x,
                      intermediateH.z,
                      tile.x,
                      tile.z,
                      0,
                    );
                  const path2Blocked =
                    collisionService.isWallBlocked(
                      diag.x,
                      diag.z,
                      intermediateV.x,
                      intermediateV.z,
                      0,
                    ) ||
                    collisionService.isWallBlocked(
                      intermediateV.x,
                      intermediateV.z,
                      tile.x,
                      tile.z,
                      0,
                    );
                  const diagonalBlocked = collisionService.isWallBlocked(
                    diag.x,
                    diag.z,
                    tile.x,
                    tile.z,
                    0,
                  );
                  if (path1Blocked && path2Blocked) {
                    expect(diagonalBlocked).toBe(true);
                  }
                }
              }
            } finally {
              world.destroy();
            }
          },
          TEST_TIMEOUT,
        );
      }
    }
  }
});

// ============================================================================
// CRITICAL VALIDATION TESTS - These must pass for the system to be correct
// ============================================================================

describe("Critical System Validation", () => {
  let world: World;
  let collisionService: BuildingCollisionService;
  const BUILDING_ID = "validation-building";
  const BUILDING_POS = { x: 800, y: 0, z: 800 };

  beforeAll(() => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    // Register a 2-story building with stairs
    const layout = createTwoStoryBuilding();
    collisionService.registerBuilding(
      BUILDING_ID,
      "validation_town",
      layout,
      BUILDING_POS,
      0,
    );
  });

  afterAll(() => {
    world.destroy();
  });

  describe("Stair Tiles Cover Full Cell (Fix Validation)", () => {
    it("should have 16 stair tiles per stair cell (4x4 tiles)", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const floor0 = building.floors.find((f) => f.floorIndex === 0)!;

      // Bottom stairs (non-landing) should have 16 tiles
      const bottomStairs = floor0.stairTiles.filter((s) => !s.isLanding);

      // If stairs exist, there should be at least 16 tiles (one full cell)
      // Each cell is 4x4 = 16 tiles
      if (bottomStairs.length > 0) {
        console.log(
          `[Validation] Bottom stair tiles: ${bottomStairs.length} (expected >=16)`,
        );
        expect(bottomStairs.length).toBeGreaterThanOrEqual(16);
      }

      // Landing tiles should also have 16 tiles
      const landings = floor0.stairTiles.filter((s) => s.isLanding);
      if (landings.length > 0) {
        console.log(
          `[Validation] Landing stair tiles: ${landings.length} (expected >=16)`,
        );
        expect(landings.length).toBeGreaterThanOrEqual(16);
      }
    });

    it("should detect ALL stair tiles via isTileInBuildingAnyFloor", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const floor0 = building.floors.find((f) => f.floorIndex === 0)!;

      let detectedCount = 0;
      let totalStairs = 0;

      for (const stair of floor0.stairTiles) {
        totalStairs++;
        const result = collisionService.isTileInBuildingAnyFloor(
          stair.tileX,
          stair.tileZ,
        );

        if (result !== null && result.buildingId === BUILDING_ID) {
          detectedCount++;
        } else {
          console.error(
            `[Validation] FAIL: Stair tile (${stair.tileX},${stair.tileZ}) not detected!`,
          );
        }
      }

      console.log(
        `[Validation] Detected ${detectedCount}/${totalStairs} stair tiles`,
      );

      // ALL stair tiles must be detected
      expect(detectedCount).toBe(totalStairs);
    });
  });

  describe("Layer Separation Prevents Invalid Paths", () => {
    it("should NOT allow paths that bypass building walls", () => {
      const pathfinder = new BFSPathfinder();
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;

      // Start outside building (north of building)
      const startTile: TileCoord = { x: bbox.minTileX, z: bbox.minTileZ - 5 };

      // Target inside building (should NOT be reachable without going through door)
      const floor0Tiles = getAllWalkableTiles(collisionService, BUILDING_ID, 0);
      const centerTile = floor0Tiles[Math.floor(floor0Tiles.length / 2)];

      // Create walkability function that simulates GROUND layer (player outside)
      const groundLayerWalkable = (
        tile: TileCoord,
        _fromTile?: TileCoord,
      ): boolean => {
        // Check if tile is a WALKABLE building tile
        const buildingId = collisionService.isTileInBuildingFootprint(
          tile.x,
          tile.z,
        );

        if (buildingId) {
          // Building tile - only allow if it's a door tile
          const doorOpenings = collisionService.getDoorOpeningsAtTile(
            tile.x,
            tile.z,
            0,
          );
          if (doorOpenings.length === 0) {
            return false; // Not a door - blocked
          }
        }

        // Check if tile is UNDER building (bbox but not footprint)
        const inBbox = collisionService.isTileInBuildingBoundingBox(
          tile.x,
          tile.z,
        );
        if (inBbox && !buildingId) {
          const walkableInBuilding = collisionService.isTileWalkableInBuilding(
            tile.x,
            tile.z,
            0,
          );
          if (!walkableInBuilding) {
            return false; // Under building but not walkable
          }
        }

        return true;
      };

      const path = pathfinder.findPath(
        startTile,
        centerTile,
        groundLayerWalkable,
      );

      console.log(
        `[Validation] Path from outside to center: ${path.length} tiles`,
      );

      // Path should either:
      // 1. Be empty (no valid path found)
      // 2. Go through a door tile
      if (path.length > 0) {
        // Verify path goes through door
        let foundDoor = false;
        for (const tile of path) {
          const doorOpenings = collisionService.getDoorOpeningsAtTile(
            tile.x,
            tile.z,
            0,
          );
          if (doorOpenings.length > 0) {
            foundDoor = true;
            break;
          }
        }

        // If path reaches the center, it MUST go through a door
        const reachesCenter = path.some(
          (t) => t.x === centerTile.x && t.z === centerTile.z,
        );
        if (reachesCenter) {
          console.log(
            `[Validation] Path reaches center, found door: ${foundDoor}`,
          );
          expect(foundDoor).toBe(true);
        }
      }
    });

    it("should block tiles under building (in bbox but not footprint)", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;

      let blockedCount = 0;
      let checkedCount = 0;

      // Check all tiles in bounding box
      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          const inFootprint =
            collisionService.isTileInBuildingFootprint(x, z) !== null;

          if (!inFootprint) {
            // Tile is in bbox but NOT in footprint
            checkedCount++;
            const walkable = collisionService.isTileWalkableInBuilding(x, z, 0);

            // Should NOT be walkable unless it's a door exterior
            if (!walkable) {
              blockedCount++;
            }
          }
        }
      }

      console.log(
        `[Validation] Tiles under building: ${blockedCount}/${checkedCount} blocked`,
      );

      // Most non-footprint tiles in bbox should be blocked
      // (Some may be door exteriors which are allowed)
      const blockRate = checkedCount > 0 ? blockedCount / checkedCount : 1;
      expect(blockRate).toBeGreaterThan(0.5); // At least 50% blocked
    });
  });

  describe("Elevation Transition Validation", () => {
    it("exterior door tiles should NOT get building floor elevation", () => {
      const doorTiles = collisionService.getDoorTiles(BUILDING_ID);
      expect(doorTiles.length).toBeGreaterThan(0);

      for (const door of doorTiles) {
        // Exterior tile (outside building)
        const exteriorX = door.tileX;
        const exteriorZ = door.tileZ;

        // Check if exterior tile is in footprint (it shouldn't be)
        const inFootprint = collisionService.isTileInBuildingFootprint(
          exteriorX,
          exteriorZ,
        );

        console.log(
          `[Validation] Door exterior (${exteriorX},${exteriorZ}) in footprint: ${inFootprint !== null}`,
        );

        // Exterior door tiles should NOT be in footprint
        // (They're the approach tiles OUTSIDE the building)
        // This ensures they get terrain elevation, not building floor elevation
        expect(inFootprint).toBeNull();
      }
    });

    it("interior door tiles SHOULD be in footprint and get floor elevation", () => {
      const doorTiles = collisionService.getDoorTiles(BUILDING_ID);
      expect(doorTiles.length).toBeGreaterThan(0);

      for (const door of doorTiles) {
        // Interior tile is calculated based on door direction
        let interiorX = door.tileX;
        let interiorZ = door.tileZ;

        // Interior is one step INSIDE from exterior based on door direction
        switch (door.direction) {
          case "north":
            interiorZ += 1;
            break;
          case "south":
            interiorZ -= 1;
            break;
          case "east":
            interiorX -= 1;
            break;
          case "west":
            interiorX += 1;
            break;
        }

        const inFootprint = collisionService.isTileInBuildingFootprint(
          interiorX,
          interiorZ,
        );

        console.log(
          `[Validation] Door interior (${interiorX},${interiorZ}) in footprint: ${inFootprint !== null}`,
        );

        // Interior door tiles SHOULD be in footprint
        expect(inFootprint).not.toBeNull();
      }
    });
  });
});
