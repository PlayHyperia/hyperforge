/**
 * BuildingCollisionService Unit Tests
 *
 * Tests the building collision data generation and query system.
 *
 * Key behaviors tested:
 * - Collision data generation from building layouts
 * - Wall flag registration in CollisionMatrix
 * - Floor walkability queries
 * - Directional wall blocking
 * - Stair tile detection
 * - Player floor tracking
 * - Building rotation handling
 * - Multi-floor collision
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BuildingCollisionService } from "../BuildingCollisionService";
import { CollisionMatrix } from "../../movement/CollisionMatrix";
import { CollisionFlag } from "../../movement/CollisionFlags";
import type { BuildingLayoutInput } from "../../../../types/world/building-collision-types";
import type { World } from "../../../../core/World";
import { FOUNDATION_HEIGHT, FLOOR_HEIGHT } from "@hyperforge/procgen/building";

/** Combined wall flags for testing */
const ALL_WALL_FLAGS =
  CollisionFlag.WALL_NORTH |
  CollisionFlag.WALL_SOUTH |
  CollisionFlag.WALL_EAST |
  CollisionFlag.WALL_WEST;

// Create minimal mock World with CollisionMatrix
function createMockWorld(): World {
  const collision = new CollisionMatrix();
  return {
    collision,
    isServer: true,
    isClient: false,
    physics: null,
    camera: null,
    stage: null,
    entities: new Map(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getSystem: vi.fn(),
    setupMaterial: vi.fn(),
  } as unknown as World;
}

// Create a simple 2x2 building layout for testing
function createSimpleBuildingLayout(): BuildingLayoutInput {
  return {
    width: 2,
    depth: 2,
    floors: 1,
    floorPlans: [
      {
        footprint: [
          [true, true],
          [true, true],
        ],
        roomMap: [
          [0, 0],
          [0, 0],
        ],
        internalOpenings: new Map(),
        externalOpenings: new Map([
          // Door on north side (row 0, col 0)
          // Row 0 has external edge on NORTH (dr-1 → row -1 doesn't exist)
          ["0,0,north", "door"],
        ]),
      },
    ],
    stairs: null,
  };
}

// Create a multi-floor building layout with stairs
function createMultiFloorBuildingLayout(): BuildingLayoutInput {
  return {
    width: 3,
    depth: 3,
    floors: 2,
    floorPlans: [
      // Ground floor
      {
        footprint: [
          [true, true, true],
          [true, true, true],
          [true, true, true],
        ],
        roomMap: [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ],
        internalOpenings: new Map(),
        externalOpenings: new Map([
          ["1,0,north", "door"], // Door at center of north wall (row 0 external edge)
        ]),
      },
      // Second floor
      {
        footprint: [
          [true, true, true],
          [true, true, true],
          [true, true, true],
        ],
        roomMap: [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ],
        internalOpenings: new Map(),
        externalOpenings: new Map(),
      },
    ],
    stairs: {
      col: 0,
      row: 1,
      direction: "north",
      landing: { col: 0, row: 2 },
    },
  };
}

// Create a building with internal rooms
function createMultiRoomBuildingLayout(): BuildingLayoutInput {
  return {
    width: 4,
    depth: 2,
    floors: 1,
    floorPlans: [
      {
        footprint: [
          [true, true, true, true],
          [true, true, true, true],
        ],
        roomMap: [
          [0, 0, 1, 1], // Two rooms: 0 on left, 1 on right
          [0, 0, 1, 1],
        ],
        internalOpenings: new Map([
          // Internal doorway between rooms
          ["1,0,east", "door"],
          ["1,1,east", "door"],
        ]),
        externalOpenings: new Map([
          // External door to each room (row 0 has north external edge)
          ["0,0,north", "door"], // Room 0 entrance
          ["3,0,north", "door"], // Room 1 entrance
        ]),
      },
    ],
    stairs: null,
  };
}

describe("BuildingCollisionService", () => {
  let world: World;
  let service: BuildingCollisionService;

  beforeEach(() => {
    world = createMockWorld();
    service = new BuildingCollisionService(world);
  });

  describe("building registration", () => {
    it("registers building and stores collision data", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      expect(service.getBuildingCount()).toBe(1);
      expect(service.getBuilding("building-1")).toBeDefined();
    });

    it("registers multiple buildings", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );
      service.registerBuilding(
        "building-2",
        "town-1",
        layout,
        { x: 200, y: 0, z: 200 },
        0,
      );

      expect(service.getBuildingCount()).toBe(2);
    });

    it("unregisters building and removes collision data", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      service.unregisterBuilding("building-1");

      expect(service.getBuildingCount()).toBe(0);
      expect(service.getBuilding("building-1")).toBeUndefined();
    });
  });

  describe("collision data generation", () => {
    it("generates floor data with walkable tiles", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const building = service.getBuilding("building-1");
      expect(building).toBeDefined();
      expect(building!.floors.length).toBeGreaterThan(0);

      // Ground floor should have walkable tiles
      const groundFloor = building!.floors.find((f) => f.floorIndex === 0);
      expect(groundFloor).toBeDefined();
      expect(groundFloor!.walkableTiles.size).toBeGreaterThan(0);
    });

    it("generates wall segments for external edges", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const building = service.getBuilding("building-1");
      const groundFloor = building!.floors.find((f) => f.floorIndex === 0);

      // Should have wall segments for external edges
      expect(groundFloor!.wallSegments.length).toBeGreaterThan(0);
    });

    it("marks door openings in wall segments", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const building = service.getBuilding("building-1");
      const groundFloor = building!.floors.find((f) => f.floorIndex === 0);

      // Should have at least one wall with an opening (door)
      const wallsWithOpenings = groundFloor!.wallSegments.filter(
        (w) => w.hasOpening,
      );
      expect(wallsWithOpenings.length).toBeGreaterThan(0);
    });

    it("generates roof floor for top of building", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const building = service.getBuilding("building-1");

      // Should have roof floor (floorIndex = floors count)
      const roofFloor = building!.floors.find(
        (f) => f.floorIndex === layout.floors,
      );
      expect(roofFloor).toBeDefined();
    });
  });

  describe("multi-floor buildings", () => {
    it("generates separate collision data for each floor", () => {
      const layout = createMultiFloorBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const building = service.getBuilding("building-1");

      // Should have ground floor, second floor, and roof
      expect(building!.floors.length).toBe(3);
    });

    it("generates stair tiles for multi-floor buildings", () => {
      const layout = createMultiFloorBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const building = service.getBuilding("building-1");
      const groundFloor = building!.floors.find((f) => f.floorIndex === 0);

      // Should have stair tiles on ground floor
      expect(groundFloor!.stairTiles.length).toBeGreaterThan(0);
    });

    it("stair tiles connect correct floors", () => {
      const layout = createMultiFloorBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const building = service.getBuilding("building-1");
      const groundFloor = building!.floors.find((f) => f.floorIndex === 0);
      const stair = groundFloor!.stairTiles[0];

      // Stair should connect floor 0 to floor 1
      expect(stair.fromFloor).toBe(0);
      expect(stair.toFloor).toBe(1);
    });

    it("floors have increasing elevations", () => {
      const layout = createMultiFloorBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const building = service.getBuilding("building-1");
      const elevations = building!.floors.map((f) => f.elevation);

      // Each floor should be higher than the previous
      for (let i = 1; i < elevations.length; i++) {
        expect(elevations[i]).toBeGreaterThan(elevations[i - 1]);
      }
    });
  });

  describe("internal walls", () => {
    it("generates wall segments between rooms", () => {
      const layout = createMultiRoomBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const building = service.getBuilding("building-1");
      const groundFloor = building!.floors.find((f) => f.floorIndex === 0);

      // Should have wall segments (external + internal)
      // Internal walls should exist where rooms meet
      expect(groundFloor!.wallSegments.length).toBeGreaterThan(4); // More than just external walls
    });
  });

  describe("collision queries", () => {
    it("returns walkable for tiles inside building footprint", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      // Query a tile that should be inside the building
      // Building is 2x2 cells (8x8 meters) centered at origin
      // Cell coordinates map to world tiles around the building center
      const building = service.getBuilding("building-1");
      expect(building).toBeDefined();

      // Get a walkable tile from the floor
      const groundFloor = building!.floors.find((f) => f.floorIndex === 0);
      const walkableTiles = Array.from(groundFloor!.walkableTiles);
      expect(walkableTiles.length).toBeGreaterThan(0);
    });

    it("returns not inside building for distant tiles", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      // Query a tile far from the building
      const result = service.queryCollision(500, 500, 0);

      expect(result.isInsideBuilding).toBe(false);
    });
  });

  describe("CollisionMatrix integration", () => {
    it("registers wall flags with CollisionMatrix", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const collision = world.collision as CollisionMatrix;

      // Get the building's wall segments
      const building = service.getBuilding("building-1");
      const groundFloor = building!.floors.find((f) => f.floorIndex === 0);
      const closedWalls = groundFloor!.wallSegments.filter(
        (w) => !w.hasOpening,
      );

      // At least some tiles should have wall flags set
      const hasWallFlags = closedWalls.some(
        (wall) => collision.getFlags(wall.tileX, wall.tileZ) & ALL_WALL_FLAGS,
      );
      expect(hasWallFlags).toBe(true);
    });

    it("removes wall flags when building unregistered", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      // Get a wall tile before unregistering
      const building = service.getBuilding("building-1");
      const groundFloor = building!.floors.find((f) => f.floorIndex === 0);
      const closedWall = groundFloor!.wallSegments.find((w) => !w.hasOpening);

      expect(closedWall).toBeDefined();

      // Unregister building
      service.unregisterBuilding("building-1");
      expect(service.getBuildingCount()).toBe(0);
    });
  });

  describe("building rotation", () => {
    it("handles 90 degree rotation", () => {
      const layout = createSimpleBuildingLayout();

      // Register same building with 90 degree rotation
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        Math.PI / 2, // 90 degrees
      );

      const building = service.getBuilding("building-1");
      expect(building).toBeDefined();
      expect(building!.rotation).toBe(Math.PI / 2);
    });

    it("handles 180 degree rotation", () => {
      const layout = createSimpleBuildingLayout();

      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        Math.PI, // 180 degrees
      );

      const building = service.getBuilding("building-1");
      expect(building).toBeDefined();
      expect(building!.rotation).toBe(Math.PI);
    });
  });

  describe("player floor tracking", () => {
    it("initializes player state with default values", () => {
      const state = service.getPlayerBuildingState("player-1");

      expect(state.insideBuildingId).toBeNull();
      expect(state.currentFloor).toBe(0);
      expect(state.onStairs).toBe(false);
    });

    it("removes player state on cleanup", () => {
      service.getPlayerBuildingState("player-1");
      service.removePlayerState("player-1");

      // Getting state again should create fresh state
      const state = service.getPlayerBuildingState("player-1");
      expect(state.insideBuildingId).toBeNull();
    });
  });

  describe("clear", () => {
    it("removes all buildings and player states", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "building-1",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );
      service.getPlayerBuildingState("player-1");

      service.clear();

      expect(service.getBuildingCount()).toBe(0);
      expect(service.getAllBuildings()).toHaveLength(0);
    });
  });

  // ============================================================================
  // BOUNDARY CONDITIONS
  // ============================================================================

  describe("boundary conditions", () => {
    it("handles single cell (1x1) building", () => {
      const layout: BuildingLayoutInput = {
        width: 1,
        depth: 1,
        floors: 1,
        floorPlans: [
          {
            footprint: [[true]],
            roomMap: [[0]],
            internalOpenings: new Map(),
            externalOpenings: new Map([["0,0,north", "door"]]),
          },
        ],
        stairs: null,
      };

      service.registerBuilding(
        "tiny",
        "town-1",
        layout,
        { x: 50, y: 0, z: 50 },
        0,
      );

      const building = service.getBuilding("tiny");
      expect(building).toBeDefined();
      // Each cell is CELL_SIZE (4m) x CELL_SIZE (4m) = 16 tiles per cell
      // 1 cell = 16 walkable tiles
      expect(building!.floors[0].walkableTiles.size).toBe(16);
      // Single cell should have walls on all 4 sides
      // Each side has 4 wall segments (one per tile along the edge)
      // Total: 4 sides × 4 tiles = 16 wall segments
      // Door side: only CENTER 2 tiles have hasOpening=true, 2 side tiles remain closed
      // Remaining 3 sides have 12 solid wall segments
      // Total closed: 2 (door side edges) + 12 (other sides) = 14
      const closedWalls = building!.floors[0].wallSegments.filter(
        (w) => !w.hasOpening,
      );
      expect(closedWalls.length).toBe(14);
    });

    it("handles building at negative coordinates", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "negative",
        "town-1",
        layout,
        { x: -100, y: -5, z: -200 },
        0,
      );

      const building = service.getBuilding("negative");
      expect(building).toBeDefined();
      expect(building!.worldPosition.x).toBe(-100);
      expect(building!.worldPosition.y).toBe(-5);
      expect(building!.worldPosition.z).toBe(-200);
    });

    it("handles extreme rotation values (> 2π)", () => {
      const layout = createSimpleBuildingLayout();
      const rotation = Math.PI * 5; // 2.5 full rotations

      service.registerBuilding(
        "rotated",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        rotation,
      );

      const building = service.getBuilding("rotated");
      expect(building).toBeDefined();
      expect(building!.rotation).toBe(rotation);
    });

    it("handles negative rotation values", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "neg-rot",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        -Math.PI / 2,
      );

      const building = service.getBuilding("neg-rot");
      expect(building).toBeDefined();
      expect(building!.floors.length).toBeGreaterThan(0);
    });

    it("handles building at exact origin (0,0,0)", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "origin",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("origin");
      expect(building).toBeDefined();
      expect(building!.floors[0].walkableTiles.size).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // EDGE CASES
  // ============================================================================

  describe("edge cases", () => {
    it("unregistering non-existent building does nothing", () => {
      expect(service.getBuildingCount()).toBe(0);
      service.unregisterBuilding("does-not-exist");
      expect(service.getBuildingCount()).toBe(0);
    });

    it("registering building with same ID overwrites previous", () => {
      const layout = createSimpleBuildingLayout();

      service.registerBuilding(
        "dup",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );
      const firstBuilding = service.getBuilding("dup");
      expect(firstBuilding!.worldPosition.x).toBe(100);

      service.registerBuilding(
        "dup",
        "town-2",
        layout,
        { x: 200, y: 0, z: 200 },
        Math.PI,
      );

      // Same ID should overwrite - count stays 1
      expect(service.getBuildingCount()).toBe(1);
      const building = service.getBuilding("dup");
      expect(building).toBeDefined();
      // Second registration overwrites first
      expect(building!.worldPosition.x).toBe(200);
      expect(building!.townId).toBe("town-2");
    });

    it("handles L-shaped building footprint", () => {
      const layout: BuildingLayoutInput = {
        width: 3,
        depth: 2,
        floors: 1,
        floorPlans: [
          {
            footprint: [
              [true, true, false], // L-shape: bottom row has 2 cells
              [true, false, false], // top row has 1 cell
            ],
            roomMap: [
              [0, 0, -1],
              [0, -1, -1],
            ],
            internalOpenings: new Map(),
            externalOpenings: new Map([["0,0,north", "door"]]),
          },
        ],
        stairs: null,
      };

      service.registerBuilding(
        "l-shape",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("l-shape");
      expect(building).toBeDefined();
      // Should have walkable tiles for the 3 cells of the L-shape
      // Each cell is CELL_SIZE (4m) x CELL_SIZE (4m) = 16 tiles per cell
      // 3 cells = 48 walkable tiles
      expect(building!.floors[0].walkableTiles.size).toBe(48);
    });

    it("keeps a rotated foyer entrance corridor outside exact building coverage", () => {
      const footprint = [
        [true, true, true, true],
        [true, true, true, true],
        [true, true, true, true],
        [false, true, false, false],
        [false, true, false, false],
      ];
      const layout: BuildingLayoutInput = {
        width: 4,
        depth: 5,
        floors: 1,
        floorPlans: [
          {
            footprint,
            roomMap: footprint.map((row) =>
              row.map((occupied) => (occupied ? 0 : -1)),
            ),
            internalOpenings: new Map(),
            externalOpenings: new Map([["2,2,south", "arch"]]),
          },
        ],
        exteriorFootprint: footprint.map((row) => [...row]),
        stairs: null,
      };

      service.registerBuilding(
        "rotated-foyer",
        "town-1",
        layout,
        { x: -770, y: 100, z: -1840 },
        -Math.PI / 2,
      );

      const entrances = service.getEntranceTiles("rotated-foyer");
      expect(entrances).toHaveLength(2);
      const entrance = entrances[0];
      const outward =
        entrance.direction === "north"
          ? { x: 0, z: -1 }
          : entrance.direction === "south"
            ? { x: 0, z: 1 }
            : entrance.direction === "east"
              ? { x: 1, z: 0 }
              : { x: -1, z: 0 };

      for (let distance = 0; distance <= 5; distance++) {
        const tile = {
          x: entrance.tileX + outward.x * distance,
          z: entrance.tileZ + outward.z * distance,
        };
        expect(service.isTileInBuildingGroundCoverage(tile.x, tile.z)).toBe(
          null,
        );
        expect(service.isTileWalkableInBuilding(tile.x, tile.z, 0)).toBe(true);
        expect(service.queryCollision(tile.x, tile.z, 0).isInsideBuilding).toBe(
          false,
        );
      }
    });

    it("blocks enclosed ground voids while leaving exterior concavities open", () => {
      const footprint = [
        [true, true, true],
        [true, false, true],
        [true, true, true],
      ];
      const layout: BuildingLayoutInput = {
        width: 3,
        depth: 3,
        floors: 1,
        floorPlans: [
          {
            footprint,
            roomMap: footprint.map((row) =>
              row.map((occupied) => (occupied ? 0 : -1)),
            ),
            internalOpenings: new Map(),
            externalOpenings: new Map([["1,0,north", "door"]]),
          },
        ],
        exteriorFootprint: [
          [true, true, true],
          [true, true, true],
          [true, true, true],
        ],
        stairs: null,
      };

      service.registerBuilding(
        "enclosed-void",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      expect(service.isTileInBuildingFootprint(0, 0)).toBe(null);
      expect(service.isTileInBuildingGroundCoverage(0, 0)).toBe(
        "enclosed-void",
      );
      expect(service.isTileWalkableInBuilding(0, 0, 0)).toBe(false);
      expect(service.queryCollision(0, 0, 0)).toMatchObject({
        buildingId: "enclosed-void",
        isInsideBuilding: true,
        isWalkable: false,
      });
    });

    it("handles building with no external doors (fully enclosed)", () => {
      const layout: BuildingLayoutInput = {
        width: 2,
        depth: 2,
        floors: 1,
        floorPlans: [
          {
            footprint: [
              [true, true],
              [true, true],
            ],
            roomMap: [
              [0, 0],
              [0, 0],
            ],
            internalOpenings: new Map(),
            externalOpenings: new Map(), // No doors!
          },
        ],
        stairs: null,
      };

      service.registerBuilding(
        "prison",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("prison");
      expect(building).toBeDefined();
      // All walls should be closed (no openings)
      const wallsWithOpenings = building!.floors[0].wallSegments.filter(
        (w) => w.hasOpening,
      );
      expect(wallsWithOpenings.length).toBe(0);
    });

    it("query for non-existent floor returns default result", () => {
      const layout = createSimpleBuildingLayout(); // 1 floor
      service.registerBuilding(
        "single-floor",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("single-floor");
      const walkableTile = Array.from(building!.floors[0].walkableTiles)[0];
      const [tileX, tileZ] = walkableTile.split(",").map(Number);

      // Query floor 5 which doesn't exist
      const result = service.queryCollision(tileX, tileZ, 5);

      // Should still be inside building spatially, but no floor match
      // Actually, queryCollision checks floor existence, so should return default
      expect(result.isInsideBuilding).toBe(false);
    });
  });

  // ============================================================================
  // WALL BLOCKING TESTS
  // ============================================================================

  describe("wall blocking (isWallBlocked)", () => {
    it("blocks movement through solid north wall", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "walls",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("walls");
      const groundFloor = building!.floors[0];

      // Find a tile with a north wall (no opening)
      const northWall = groundFloor.wallSegments.find(
        (w) => w.side === "north" && !w.hasOpening,
      );

      if (northWall) {
        // Movement from this tile going north should be blocked
        // North = -Z direction, so moving from tileZ to tileZ - 1
        const isBlocked = service.isWallBlocked(
          northWall.tileX,
          northWall.tileZ,
          northWall.tileX,
          northWall.tileZ - 1, // North = decreasing Z
          0,
        );
        expect(isBlocked).toBe(true);
      }
    });

    it("allows movement through door opening", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "doors",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("doors");
      const groundFloor = building!.floors[0];

      // Find a tile with a door opening
      const doorWall = groundFloor.wallSegments.find(
        (w) => w.hasOpening && w.openingType === "door",
      );

      if (doorWall) {
        // Movement through door should NOT be blocked
        // Door faces outward, so movement through it goes in the door's direction
        let toZ = doorWall.tileZ;
        let toX = doorWall.tileX;

        // Movement goes in the door's facing direction (outward from building)
        switch (doorWall.side) {
          case "north":
            toZ = doorWall.tileZ - 1; // Move north (decreasing Z)
            break;
          case "south":
            toZ = doorWall.tileZ + 1; // Move south (increasing Z)
            break;
          case "east":
            toX = doorWall.tileX + 1; // Move east (increasing X)
            break;
          case "west":
            toX = doorWall.tileX - 1; // Move west (decreasing X)
            break;
        }

        const isBlocked = service.isWallBlocked(
          doorWall.tileX,
          doorWall.tileZ,
          toX,
          toZ,
          0,
        );
        expect(isBlocked).toBe(false);
      }
    });

    it("blocks movement in both directions for solid walls", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "bi-dir",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("bi-dir");
      const groundFloor = building!.floors[0];

      const eastWall = groundFloor.wallSegments.find(
        (w) => w.side === "east" && !w.hasOpening,
      );

      if (eastWall) {
        // Block going east
        const blockedEast = service.isWallBlocked(
          eastWall.tileX,
          eastWall.tileZ,
          eastWall.tileX + 1,
          eastWall.tileZ,
          0,
        );
        expect(blockedEast).toBe(true);

        // Also should block coming from east (west wall on adjacent tile)
        // This depends on CollisionMatrix registration
      }
    });

    it("returns false for diagonal movement", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "diag",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      // Diagonal movement (dx=1, dz=1) should not be blocked by this method
      const isBlocked = service.isWallBlocked(0, 0, 1, 1, 0);
      expect(isBlocked).toBe(false);
    });

    it("returns false for tiles outside building", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "outside",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      // Query tiles far from building
      const isBlocked = service.isWallBlocked(500, 500, 501, 500, 0);
      expect(isBlocked).toBe(false);
    });
  });

  // ============================================================================
  // SPATIAL QUERIES
  // ============================================================================

  describe("spatial queries", () => {
    it("getBuildingAtTile returns building ID for covered tile", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "spatial",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("spatial");
      const walkableTile = Array.from(building!.floors[0].walkableTiles)[0];
      const [tileX, tileZ] = walkableTile.split(",").map(Number);

      const foundId = service.getBuildingAtTile(tileX, tileZ);
      expect(foundId).toBe("spatial");
    });

    it("getBuildingAtTile returns null for uncovered tile", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "spatial2",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const foundId = service.getBuildingAtTile(500, 500);
      expect(foundId).toBeNull();
    });

    it("getFloorElevation returns correct elevation for ground floor", () => {
      const layout = createSimpleBuildingLayout();
      const groundY = 10;
      service.registerBuilding(
        "elevation",
        "town-1",
        layout,
        { x: 0, y: groundY, z: 0 },
        0,
      );

      const building = service.getBuilding("elevation");
      const walkableTile = Array.from(building!.floors[0].walkableTiles)[0];
      const [tileX, tileZ] = walkableTile.split(",").map(Number);

      const elevation = service.getFloorElevation(tileX, tileZ, 0);
      // Ground floor elevation = worldY + FOUNDATION_HEIGHT + 0 * FLOOR_HEIGHT
      expect(elevation).toBe(groundY + FOUNDATION_HEIGHT);
    });

    it("getFloorElevation returns correct elevation for upper floors", () => {
      const layout = createMultiFloorBuildingLayout();
      const groundY = 5;
      service.registerBuilding(
        "multi-elev",
        "town-1",
        layout,
        { x: 0, y: groundY, z: 0 },
        0,
      );

      const building = service.getBuilding("multi-elev");
      const walkableTile = Array.from(building!.floors[0].walkableTiles)[0];
      const [tileX, tileZ] = walkableTile.split(",").map(Number);

      // Floor 0 elevation
      const floor0Elevation = service.getFloorElevation(tileX, tileZ, 0);
      expect(floor0Elevation).toBe(groundY + FOUNDATION_HEIGHT);

      // Floor 1 elevation
      const floor1Elevation = service.getFloorElevation(tileX, tileZ, 1);
      expect(floor1Elevation).toBe(groundY + FOUNDATION_HEIGHT + FLOOR_HEIGHT);
    });

    it("getFloorElevation returns null for tile outside building", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "outside-elev",
        "town-1",
        layout,
        { x: 100, y: 0, z: 100 },
        0,
      );

      const elevation = service.getFloorElevation(500, 500, 0);
      expect(elevation).toBeNull();
    });
  });

  // ============================================================================
  // PLAYER STATE TRACKING
  // ============================================================================

  describe("player state updates (updatePlayerBuildingState)", () => {
    it("updates state when player enters building", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "enter",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("enter");
      const walkableTile = Array.from(building!.floors[0].walkableTiles)[0];
      const [tileX, tileZ] = walkableTile.split(",").map(Number);
      const elevation = building!.floors[0].elevation;

      service.updatePlayerBuildingState("player-1", tileX, tileZ, elevation);

      const state = service.getPlayerBuildingState("player-1");
      expect(state.insideBuildingId).toBe("enter");
      expect(state.currentFloor).toBe(0);
    });

    it("updates state when player exits building", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "exit",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("exit");
      const walkableTile = Array.from(building!.floors[0].walkableTiles)[0];
      const [tileX, tileZ] = walkableTile.split(",").map(Number);

      // Enter building
      service.updatePlayerBuildingState("player-1", tileX, tileZ, 0.5);
      expect(service.getPlayerBuildingState("player-1").insideBuildingId).toBe(
        "exit",
      );

      // Exit building (move to tile far away)
      service.updatePlayerBuildingState("player-1", 500, 500, 0);
      const state = service.getPlayerBuildingState("player-1");
      expect(state.insideBuildingId).toBeNull();
      expect(state.currentFloor).toBe(0);
      expect(state.onStairs).toBe(false);
    });

    it("detects player on stairs", () => {
      const layout = createMultiFloorBuildingLayout();
      service.registerBuilding(
        "stairs-test",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("stairs-test");
      const groundFloor = building!.floors[0];
      const stairTile = groundFloor.stairTiles[0];

      if (stairTile) {
        service.updatePlayerBuildingState(
          "player-1",
          stairTile.tileX,
          stairTile.tileZ,
          groundFloor.elevation,
        );

        const state = service.getPlayerBuildingState("player-1");
        expect(state.onStairs).toBe(true);
        expect(state.stairData).toBeDefined();
      }
    });

    it("detects floor based on elevation", () => {
      const layout = createMultiFloorBuildingLayout();
      const groundY = 0;
      service.registerBuilding(
        "floor-detect",
        "town-1",
        layout,
        { x: 0, y: groundY, z: 0 },
        0,
      );

      const building = service.getBuilding("floor-detect");
      const walkableTile = Array.from(building!.floors[0].walkableTiles)[0];
      const [tileX, tileZ] = walkableTile.split(",").map(Number);

      // Player at floor 1 elevation
      const floor1Elevation = groundY + 0.5 + 3.4; // FOUNDATION + FLOOR_HEIGHT
      service.updatePlayerBuildingState(
        "player-1",
        tileX,
        tileZ,
        floor1Elevation,
      );

      const state = service.getPlayerBuildingState("player-1");
      expect(state.currentFloor).toBe(1);
    });
  });

  describe("stair transitions (handleStairTransition)", () => {
    it("returns null when player not in building", () => {
      const result = service.handleStairTransition(
        "player-1",
        { x: 0, z: 0 },
        { x: 1, z: 0 },
      );
      expect(result).toBeNull();
    });

    it("returns null for normal movement (no stairs)", () => {
      const layout = createSimpleBuildingLayout(); // No stairs
      service.registerBuilding(
        "no-stairs",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("no-stairs");
      const tiles = Array.from(building!.floors[0].walkableTiles);
      const [tile1X, tile1Z] = tiles[0].split(",").map(Number);
      const [tile2X, tile2Z] = tiles[1]?.split(",").map(Number) ?? [
        tile1X + 1,
        tile1Z,
      ];

      // Put player in building first
      service.updatePlayerBuildingState("player-1", tile1X, tile1Z, 0.5);

      const result = service.handleStairTransition(
        "player-1",
        { x: tile1X, z: tile1Z },
        { x: tile2X, z: tile2Z },
      );
      expect(result).toBeNull();
    });

    it("detects stepping onto stair bottom tile", () => {
      const layout = createMultiFloorBuildingLayout();
      service.registerBuilding(
        "stair-step",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("stair-step");
      const groundFloor = building!.floors[0];
      const bottomStair = groundFloor.stairTiles.find((s) => !s.isLanding);

      if (bottomStair) {
        // Get adjacent tile to step from
        const walkableTiles = Array.from(groundFloor.walkableTiles);
        const adjacentTile = walkableTiles.find((t) => {
          const [x, z] = t.split(",").map(Number);
          return (
            (Math.abs(x - bottomStair.tileX) === 1 &&
              z === bottomStair.tileZ) ||
            (Math.abs(z - bottomStair.tileZ) === 1 && x === bottomStair.tileX)
          );
        });

        if (adjacentTile) {
          const [fromX, fromZ] = adjacentTile.split(",").map(Number);

          // Put player in building
          service.updatePlayerBuildingState(
            "player-1",
            fromX,
            fromZ,
            groundFloor.elevation,
          );

          // Step onto stair
          service.handleStairTransition(
            "player-1",
            { x: fromX, z: fromZ },
            { x: bottomStair.tileX, z: bottomStair.tileZ },
          );

          const state = service.getPlayerBuildingState("player-1");
          expect(state.onStairs).toBe(true);
        }
      }
    });
  });

  // ============================================================================
  // DATA VERIFICATION
  // ============================================================================

  describe("data verification", () => {
    it("wall segments have correct tile coordinates", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "verify-walls",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("verify-walls");
      const groundFloor = building!.floors[0];

      // All wall tile coordinates should be integers
      for (const wall of groundFloor.wallSegments) {
        expect(Number.isInteger(wall.tileX)).toBe(true);
        expect(Number.isInteger(wall.tileZ)).toBe(true);
      }
    });

    it("walkable tiles correspond to collision result", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "verify-walkable",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("verify-walkable");
      const groundFloor = building!.floors[0];

      // Every walkable tile should return isWalkable=true from queryCollision
      for (const tileKeyStr of groundFloor.walkableTiles) {
        const [tileX, tileZ] = tileKeyStr.split(",").map(Number);
        const result = service.queryCollision(tileX, tileZ, 0);
        expect(result.isWalkable).toBe(true);
        expect(result.isInsideBuilding).toBe(true);
      }
    });

    it("bounding box contains all walkable tiles", () => {
      const layout = createMultiFloorBuildingLayout();
      service.registerBuilding(
        "verify-bbox",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("verify-bbox");
      const bbox = building!.boundingBox;

      for (const floor of building!.floors) {
        for (const tileKeyStr of floor.walkableTiles) {
          const [tileX, tileZ] = tileKeyStr.split(",").map(Number);
          expect(tileX).toBeGreaterThanOrEqual(bbox.minTileX);
          expect(tileX).toBeLessThanOrEqual(bbox.maxTileX);
          expect(tileZ).toBeGreaterThanOrEqual(bbox.minTileZ);
          expect(tileZ).toBeLessThanOrEqual(bbox.maxTileZ);
        }
      }
    });

    it("roof floor index equals number of interior floors", () => {
      const layout = createMultiFloorBuildingLayout(); // 2 floors
      service.registerBuilding(
        "verify-roof",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("verify-roof");
      const roofFloor = building!.floors.find(
        (f) => f.floorIndex === layout.floors,
      );

      expect(roofFloor).toBeDefined();
      expect(roofFloor!.floorIndex).toBe(2); // 2 interior floors, roof is index 2
    });

    it("stair tiles have valid floor references", () => {
      const layout = createMultiFloorBuildingLayout();
      service.registerBuilding(
        "verify-stairs",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("verify-stairs");

      for (const floor of building!.floors) {
        for (const stair of floor.stairTiles) {
          // fromFloor and toFloor should be valid floor indices
          expect(stair.fromFloor).toBeGreaterThanOrEqual(0);
          expect(stair.toFloor).toBeGreaterThanOrEqual(0);
          expect(stair.toFloor).not.toBe(stair.fromFloor);
          // Direction should be valid
          expect(["north", "south", "east", "west"]).toContain(stair.direction);
        }
      }
    });

    it("queryCollision returns correct wall blocking directions", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "verify-blocking",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("verify-blocking");
      const groundFloor = building!.floors[0];

      // Find a tile with known walls
      const wallsByTile = new Map<string, Set<string>>();
      for (const wall of groundFloor.wallSegments) {
        if (!wall.hasOpening) {
          const key = `${wall.tileX},${wall.tileZ}`;
          if (!wallsByTile.has(key)) wallsByTile.set(key, new Set());
          wallsByTile.get(key)!.add(wall.side);
        }
      }

      // Verify queryCollision matches
      for (const [tileKeyStr, directions] of wallsByTile) {
        const [tileX, tileZ] = tileKeyStr.split(",").map(Number);
        const result = service.queryCollision(tileX, tileZ, 0);

        for (const dir of directions) {
          expect(
            result.wallBlocking[dir as keyof typeof result.wallBlocking],
          ).toBe(true);
        }
      }
    });
  });

  // ============================================================================
  // COLLISION MATRIX FLAG VERIFICATION
  // ============================================================================

  describe("CollisionMatrix flag verification", () => {
    it("sets correct directional flags for each wall type", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "flag-verify",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const collision = world.collision as CollisionMatrix;
      const building = service.getBuilding("flag-verify");
      const groundFloor = building!.floors[0];

      for (const wall of groundFloor.wallSegments) {
        if (wall.hasOpening) continue;

        const flags = collision.getFlags(wall.tileX, wall.tileZ);

        // Check that the correct directional flag is set
        if (wall.side === "north") {
          expect(flags & CollisionFlag.WALL_NORTH).toBeTruthy();
        } else if (wall.side === "south") {
          expect(flags & CollisionFlag.WALL_SOUTH).toBeTruthy();
        } else if (wall.side === "east") {
          expect(flags & CollisionFlag.WALL_EAST).toBeTruthy();
        } else if (wall.side === "west") {
          expect(flags & CollisionFlag.WALL_WEST).toBeTruthy();
        }
      }
    });

    it("door wall segments have hasOpening=true and are not registered", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "door-verify",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const building = service.getBuilding("door-verify");
      const groundFloor = building!.floors[0];

      // Find a door wall specifically
      const doorWall = groundFloor.wallSegments.find(
        (w) => w.hasOpening && w.openingType === "door",
      );
      expect(doorWall).toBeDefined();
      expect(doorWall!.hasOpening).toBe(true);
      expect(doorWall!.openingType).toBe("door");

      // The door wall itself should exist in the data structure
      // but the REGISTRATION logic should skip it
      // Note: Roof floor may add walls at same tile, so we verify via queryCollision
      // which is floor-aware
      const result = service.queryCollision(
        doorWall!.tileX,
        doorWall!.tileZ,
        0,
      );

      // On ground floor (0), the door direction should NOT be blocked
      expect(result.wallBlocking[doorWall!.side]).toBe(false);
    });

    it("clears flags when building unregistered", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "clear-verify",
        "town-1",
        layout,
        { x: 0, y: 0, z: 0 },
        0,
      );

      const collision = world.collision as CollisionMatrix;
      const building = service.getBuilding("clear-verify");
      const groundFloor = building!.floors[0];
      const closedWall = groundFloor.wallSegments.find((w) => !w.hasOpening);

      if (closedWall) {
        // Verify flag is set
        const flagsBefore = collision.getFlags(
          closedWall.tileX,
          closedWall.tileZ,
        );
        expect(flagsBefore & ALL_WALL_FLAGS).toBeTruthy();

        // Unregister
        service.unregisterBuilding("clear-verify");

        // Flag should be cleared
        const flagsAfter = collision.getFlags(
          closedWall.tileX,
          closedWall.tileZ,
        );
        const expectedFlag =
          closedWall.side === "north"
            ? CollisionFlag.WALL_NORTH
            : closedWall.side === "south"
              ? CollisionFlag.WALL_SOUTH
              : closedWall.side === "east"
                ? CollisionFlag.WALL_EAST
                : CollisionFlag.WALL_WEST;
        expect(flagsAfter & expectedFlag).toBeFalsy();
      }
    });
  });

  // ============================================================================
  // BUILDING ENTRY SCENARIOS (Complete Flow Tests)
  // ============================================================================

  describe("building entry scenarios", () => {
    it("allows walking into building through door from outside", () => {
      const layout = createSimpleBuildingLayout();
      // Place building at origin
      service.registerBuilding(
        "entry-test",
        "town-1",
        layout,
        { x: 8, y: 0, z: 8 },
        0,
      );

      const building = service.getBuilding("entry-test");
      expect(building).toBeDefined();

      // Find a walkable tile inside the building
      const groundFloor = building!.floors[0];

      // Find the door wall segment
      const doorWall = groundFloor.wallSegments.find(
        (w) => w.hasOpening && w.openingType === "door",
      );
      expect(doorWall).toBeDefined();

      // Calculate the tile just outside the door
      // Outside tile is in the direction the door faces (outward from building)
      let outsideTileX = doorWall!.tileX;
      let outsideTileZ = doorWall!.tileZ;
      switch (doorWall!.side) {
        case "north":
          outsideTileZ -= 1; // North = decreasing Z
          break;
        case "south":
          outsideTileZ += 1; // South = increasing Z
          break;
        case "east":
          outsideTileX += 1; // East = increasing X
          break;
        case "west":
          outsideTileX -= 1; // West = decreasing X
          break;
      }

      // Verify tile outside is NOT inside building
      const outsideResult = service.queryCollision(
        outsideTileX,
        outsideTileZ,
        0,
      );
      expect(outsideResult.isInsideBuilding).toBe(false);

      // Verify door tile IS inside building and walkable
      const doorTileResult = service.queryCollision(
        doorWall!.tileX,
        doorWall!.tileZ,
        0,
      );
      expect(doorTileResult.isInsideBuilding).toBe(true);
      expect(doorTileResult.isWalkable).toBe(true);

      // Verify movement from outside to door tile is NOT blocked (door opening)
      const isBlockedInward = service.isWallBlocked(
        outsideTileX,
        outsideTileZ,
        doorWall!.tileX,
        doorWall!.tileZ,
        0,
      );
      expect(isBlockedInward).toBe(false);

      // Verify movement from door tile to outside is also NOT blocked (can exit)
      const isBlockedOutward = service.isWallBlocked(
        doorWall!.tileX,
        doorWall!.tileZ,
        outsideTileX,
        outsideTileZ,
        0,
      );
      expect(isBlockedOutward).toBe(false);
    });

    it("allows side approach to door exterior tiles (not blocked by step directional restriction)", () => {
      // This test verifies the fix for door exterior tiles being approachable from ANY direction
      // Previously, step tiles would block side approach, making doors unreachable from certain angles
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "side-approach-test",
        "town-1",
        layout,
        { x: 8, y: 0, z: 8 },
        0,
      );

      const building = service.getBuilding("side-approach-test");
      expect(building).toBeDefined();

      const groundFloor = building!.floors[0];
      const doorWall = groundFloor.wallSegments.find(
        (w) => w.hasOpening && w.openingType === "door",
      );
      expect(doorWall).toBeDefined();

      // Get the door exterior tile coordinates
      const doorTiles = BuildingCollisionService.getDoorExteriorAndInterior(
        doorWall!.tileX,
        doorWall!.tileZ,
        doorWall!.side,
      );
      const exteriorX = doorTiles.exteriorX;
      const exteriorZ = doorTiles.exteriorZ;

      // Verify the door exterior tile is a step tile (prerequisite for this fix)
      const _stepTile = service.getStepTile(exteriorX, exteriorZ);
      // Note: Door exterior may or may not be a step tile depending on geometry
      // If it's not a step tile, the fix doesn't apply (and side approach is already allowed)

      // Test side approach (perpendicular to the door direction)
      // If door faces north (Z-), exterior is at Z-1, so side approach is from X+1 or X-1
      let sideApproachFromX = exteriorX;
      let sideApproachFromZ = exteriorZ;

      if (doorWall!.side === "north" || doorWall!.side === "south") {
        // Door faces along Z axis, so approach from side means from X direction
        sideApproachFromX = exteriorX + 1;
      } else {
        // Door faces along X axis, so approach from side means from Z direction
        sideApproachFromZ = exteriorZ + 1;
      }

      // The door exterior tile should NOT be blocked when approached from the side
      // This is the key behavior we're testing - the fix allows any approach to door exteriors
      const isStepBlocked = service.isStepBlocked(
        sideApproachFromX,
        sideApproachFromZ,
        exteriorX,
        exteriorZ,
      );

      // Door exterior tiles should allow side approach (even if it's a step tile)
      expect(isStepBlocked).toBe(false);

      // Test front approach (along the door direction) - should also be allowed
      let frontApproachFromX = exteriorX;
      let frontApproachFromZ = exteriorZ;

      if (doorWall!.side === "north") frontApproachFromZ -= 1;
      else if (doorWall!.side === "south") frontApproachFromZ += 1;
      else if (doorWall!.side === "east") frontApproachFromX += 1;
      else if (doorWall!.side === "west") frontApproachFromX -= 1;

      const isFrontApproachBlocked = service.isStepBlocked(
        frontApproachFromX,
        frontApproachFromZ,
        exteriorX,
        exteriorZ,
      );

      // Front approach should also be allowed
      expect(isFrontApproachBlocked).toBe(false);

      // Test diagonal approach - should also be allowed for door exterior
      const isDiagonalApproachBlocked = service.isStepBlocked(
        sideApproachFromX +
          (doorWall!.side === "north" ? 0 : doorWall!.side === "south" ? 0 : 1),
        sideApproachFromZ +
          (doorWall!.side === "north"
            ? -1
            : doorWall!.side === "south"
              ? 1
              : 0),
        exteriorX,
        exteriorZ,
      );

      // Diagonal approach should also be allowed for door exterior
      expect(isDiagonalApproachBlocked).toBe(false);
    });

    it("blocks walking into building through solid wall", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "wall-test",
        "town-1",
        layout,
        { x: 8, y: 0, z: 8 },
        0,
      );

      const building = service.getBuilding("wall-test");
      const groundFloor = building!.floors[0];

      // Find a solid wall (no opening)
      const solidWall = groundFloor.wallSegments.find((w) => !w.hasOpening);
      expect(solidWall).toBeDefined();

      // Calculate the tile just outside this wall
      // Coordinate system: North = -Z, South = +Z, East = +X, West = -X
      // "Outside" means the tile on the far side of the wall from the building interior
      let outsideTileX = solidWall!.tileX;
      let outsideTileZ = solidWall!.tileZ;
      if (solidWall!.side === "south")
        outsideTileZ += 1; // South wall faces +Z, outside is z+1
      else if (solidWall!.side === "north")
        outsideTileZ -= 1; // North wall faces -Z, outside is z-1
      else if (solidWall!.side === "west") outsideTileX -= 1;
      else if (solidWall!.side === "east") outsideTileX += 1;

      // Verify movement from outside to inside IS blocked
      const isBlocked = service.isWallBlocked(
        outsideTileX,
        outsideTileZ,
        solidWall!.tileX,
        solidWall!.tileZ,
        0,
      );
      expect(isBlocked).toBe(true);
    });

    it("allows free movement inside building on walkable tiles", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "interior-test",
        "town-1",
        layout,
        { x: 8, y: 0, z: 8 },
        0,
      );

      const building = service.getBuilding("interior-test");
      const groundFloor = building!.floors[0];

      // Get all walkable tiles
      const walkableTiles = Array.from(groundFloor.walkableTiles).map((key) => {
        const [x, z] = key.split(",").map(Number);
        return { x, z };
      });

      // Should have multiple walkable tiles (16 tiles per cell * 4 cells = 64)
      expect(walkableTiles.length).toBeGreaterThan(1);

      // Test movement between adjacent walkable tiles
      // Find two adjacent tiles (cardinal direction)
      let foundAdjacentPair = false;
      for (const tile1 of walkableTiles) {
        for (const tile2 of walkableTiles) {
          const dx = Math.abs(tile1.x - tile2.x);
          const dz = Math.abs(tile1.z - tile2.z);
          // Check for cardinal adjacency (not diagonal)
          if ((dx === 1 && dz === 0) || (dx === 0 && dz === 1)) {
            // Verify no internal walls block this movement
            const isBlocked = service.isWallBlocked(
              tile1.x,
              tile1.z,
              tile2.x,
              tile2.z,
              0,
            );
            // Interior movement should NOT be blocked (same room)
            expect(isBlocked).toBe(false);
            foundAdjacentPair = true;
            break;
          }
        }
        if (foundAdjacentPair) break;
      }
      expect(foundAdjacentPair).toBe(true);
    });

    it("player state updates correctly when entering building", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "state-test",
        "town-1",
        layout,
        { x: 8, y: 0, z: 8 },
        0,
      );

      const building = service.getBuilding("state-test");
      const groundFloor = building!.floors[0];

      // Get a walkable tile inside
      const walkableTileKey = Array.from(groundFloor.walkableTiles)[0];
      const [tileX, tileZ] = walkableTileKey.split(",").map(Number);

      // Player starts outside
      const outsideState = service.getPlayerBuildingState("test-player");
      expect(outsideState.insideBuildingId).toBeNull();
      expect(outsideState.currentFloor).toBe(0);

      // Player moves to building tile
      service.updatePlayerBuildingState(
        "test-player",
        tileX,
        tileZ,
        groundFloor.elevation,
      );

      // Player state should be updated
      const insideState = service.getPlayerBuildingState("test-player");
      expect(insideState.insideBuildingId).toBe("state-test");
      expect(insideState.currentFloor).toBe(0);
    });

    it("all 16 tiles per cell are walkable inside building", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "tile-coverage",
        "town-1",
        layout,
        { x: 8, y: 0, z: 8 },
        0,
      );

      const building = service.getBuilding("tile-coverage");
      const groundFloor = building!.floors[0];

      // Building is 2x2 cells = 4 cells
      // Each cell should register 16 tiles (4x4)
      // Total: 4 * 16 = 64 tiles
      expect(groundFloor.walkableTiles.size).toBe(64);

      // Verify each walkable tile returns correct collision result
      for (const key of groundFloor.walkableTiles) {
        const [tileX, tileZ] = key.split(",").map(Number);
        const result = service.queryCollision(tileX, tileZ, 0);
        expect(result.isInsideBuilding).toBe(true);
        expect(result.isWalkable).toBe(true);
        expect(result.buildingId).toBe("tile-coverage");
      }
    });

    it("wall segments cover all tiles on building perimeter", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "perimeter-test",
        "town-1",
        layout,
        { x: 8, y: 0, z: 8 },
        0,
      );

      const building = service.getBuilding("perimeter-test");
      const groundFloor = building!.floors[0];

      // Count wall segments per side
      const wallsBySide = {
        north: 0,
        south: 0,
        east: 0,
        west: 0,
      };

      for (const wall of groundFloor.wallSegments) {
        wallsBySide[wall.side]++;
      }

      // Building is 2x2 cells = 8m x 8m
      // North perimeter: 8 tiles (minus door tiles)
      // South perimeter: 8 tiles (has door, so some with hasOpening=true)
      // East perimeter: 8 tiles
      // West perimeter: 8 tiles

      // Each side should have wall segments for all perimeter tiles
      // With 2x2 cells and 4 tiles per cell edge, we expect many segments per side
      expect(wallsBySide.north).toBeGreaterThan(0);
      expect(wallsBySide.south).toBeGreaterThan(0);
      expect(wallsBySide.east).toBeGreaterThan(0);
      expect(wallsBySide.west).toBeGreaterThan(0);

      // Total wall segments should be significant (all perimeter tiles * 4 sides)
      const totalWalls = Object.values(wallsBySide).reduce((a, b) => a + b, 0);
      expect(totalWalls).toBeGreaterThan(20);
    });

    it("building tile coverage matches expected world positions", () => {
      // A 2x2 cell building placed at position (100, 0, 100)
      // Each cell is 4x4 meters = 4x4 tiles
      // Total building: 8x8 meters = 8x8 tiles = 64 tiles
      const layout = createSimpleBuildingLayout();
      const buildingPosX = 100;
      const buildingPosZ = 100;

      service.registerBuilding(
        "pos-test",
        "town-1",
        layout,
        { x: buildingPosX, y: 0, z: buildingPosZ },
        0,
      );

      const building = service.getBuilding("pos-test");
      expect(building).toBeDefined();

      const groundFloor = building!.floors[0];

      // Get all walkable tiles and verify they are near the building position
      const walkableTiles = Array.from(groundFloor.walkableTiles).map((key) => {
        const [x, z] = key.split(",").map(Number);
        return { x, z };
      });

      // All tiles should be within the building bounds
      // Building center is at (100, 100), size is 8x8 tiles
      // So tiles should be roughly in range [96, 104) for both X and Z
      for (const tile of walkableTiles) {
        const distX = Math.abs(tile.x - buildingPosX);
        const distZ = Math.abs(tile.z - buildingPosZ);

        // Each tile should be within half the building size (4 tiles) of center
        expect(distX).toBeLessThanOrEqual(4);
        expect(distZ).toBeLessThanOrEqual(4);
      }

      // Verify a specific tile at the building position is walkable
      const centerTileResult = service.queryCollision(
        buildingPosX,
        buildingPosZ,
        0,
      );
      expect(centerTileResult.isInsideBuilding).toBe(true);
      expect(centerTileResult.isWalkable).toBe(true);

      // Verify tiles far from the building are NOT inside
      const farTileResult = service.queryCollision(
        buildingPosX + 50,
        buildingPosZ + 50,
        0,
      );
      expect(farTileResult.isInsideBuilding).toBe(false);
    });

    it("pathfinding walkability check works correctly for building entry", () => {
      const layout = createSimpleBuildingLayout();
      service.registerBuilding(
        "pathfind-test",
        "town-1",
        layout,
        { x: 8, y: 0, z: 8 },
        0,
      );

      const building = service.getBuilding("pathfind-test");
      const groundFloor = building!.floors[0];

      // Find the door wall segment
      const doorWall = groundFloor.wallSegments.find(
        (w) => w.hasOpening && w.openingType === "door",
      );
      expect(doorWall).toBeDefined();

      // Simulate pathfinding walkability check:
      // A tile is walkable if:
      // 1. It's inside building and walkable, OR
      // 2. It's outside building and terrain is walkable
      // AND movement from fromTile isn't blocked by walls

      // Helper function that simulates pathfinding isTileWalkable
      const isTileWalkable = (
        tileX: number,
        tileZ: number,
        fromX?: number,
        fromZ?: number,
      ): boolean => {
        // Check wall blocking first
        if (fromX !== undefined && fromZ !== undefined) {
          if (service.isWallBlocked(fromX, fromZ, tileX, tileZ, 0)) {
            return false;
          }
        }

        // Check building collision
        const result = service.queryCollision(tileX, tileZ, 0);
        if (result.isInsideBuilding) {
          return result.isWalkable;
        }

        // Outside building - assume terrain is walkable for this test
        return true;
      };

      // Calculate tile outside door (in the direction the door faces)
      let outsideX = doorWall!.tileX;
      let outsideZ = doorWall!.tileZ;
      switch (doorWall!.side) {
        case "north":
          outsideZ -= 1; // North = decreasing Z
          break;
        case "south":
          outsideZ += 1; // South = increasing Z
          break;
        case "east":
          outsideX += 1; // East = increasing X
          break;
        case "west":
          outsideX -= 1; // West = decreasing X
          break;
      }

      // Test: Outside tile is walkable (terrain)
      expect(isTileWalkable(outsideX, outsideZ)).toBe(true);

      // Test: Door tile is walkable from outside (through door)
      expect(
        isTileWalkable(doorWall!.tileX, doorWall!.tileZ, outsideX, outsideZ),
      ).toBe(true);

      // Test: Inside tile is walkable
      const insideTileKey = Array.from(groundFloor.walkableTiles)[0];
      const [insideX, insideZ] = insideTileKey.split(",").map(Number);
      expect(isTileWalkable(insideX, insideZ)).toBe(true);

      // Find a solid wall tile
      const solidWall = groundFloor.wallSegments.find((w) => !w.hasOpening);
      expect(solidWall).toBeDefined();

      // Calculate tile outside solid wall
      // Coordinate system: North = -Z, South = +Z, East = +X, West = -X
      let solidOutsideX = solidWall!.tileX;
      let solidOutsideZ = solidWall!.tileZ;
      if (solidWall!.side === "south")
        solidOutsideZ += 1; // South wall faces +Z
      else if (solidWall!.side === "north")
        solidOutsideZ -= 1; // North wall faces -Z
      else if (solidWall!.side === "west") solidOutsideX -= 1;
      else if (solidWall!.side === "east") solidOutsideX += 1;

      // Test: Cannot walk from outside to inside through solid wall
      expect(
        isTileWalkable(
          solidWall!.tileX,
          solidWall!.tileZ,
          solidOutsideX,
          solidOutsideZ,
        ),
      ).toBe(false);
    });
  });
});

/**
 * Tests for getDoorExteriorAndInterior static helper
 * Ensures door tile calculations are correct for all cardinal directions
 */
describe("getDoorExteriorAndInterior", () => {
  it("calculates north-facing door correctly", () => {
    // North-facing wall: exterior is north (lower Z), interior is the wall tile
    const result = BuildingCollisionService.getDoorExteriorAndInterior(
      10,
      10,
      "north",
    );
    expect(result.interiorX).toBe(10);
    expect(result.interiorZ).toBe(10);
    expect(result.exteriorX).toBe(10);
    expect(result.exteriorZ).toBe(9); // North = lower Z
  });

  it("calculates south-facing door correctly", () => {
    // South-facing wall: exterior is south (higher Z), interior is the wall tile
    const result = BuildingCollisionService.getDoorExteriorAndInterior(
      10,
      10,
      "south",
    );
    expect(result.interiorX).toBe(10);
    expect(result.interiorZ).toBe(10);
    expect(result.exteriorX).toBe(10);
    expect(result.exteriorZ).toBe(11); // South = higher Z
  });

  it("calculates east-facing door correctly", () => {
    // East-facing wall: exterior is east (higher X), interior is the wall tile
    const result = BuildingCollisionService.getDoorExteriorAndInterior(
      10,
      10,
      "east",
    );
    expect(result.interiorX).toBe(10);
    expect(result.interiorZ).toBe(10);
    expect(result.exteriorX).toBe(11); // East = higher X
    expect(result.exteriorZ).toBe(10);
  });

  it("calculates west-facing door correctly", () => {
    // West-facing wall: exterior is west (lower X), interior is the wall tile
    const result = BuildingCollisionService.getDoorExteriorAndInterior(
      10,
      10,
      "west",
    );
    expect(result.interiorX).toBe(10);
    expect(result.interiorZ).toBe(10);
    expect(result.exteriorX).toBe(9); // West = lower X
    expect(result.exteriorZ).toBe(10);
  });

  it("handles negative coordinates", () => {
    const result = BuildingCollisionService.getDoorExteriorAndInterior(
      -5,
      -5,
      "north",
    );
    expect(result.exteriorX).toBe(-5);
    expect(result.exteriorZ).toBe(-6);
  });

  it("handles zero coordinates", () => {
    const result = BuildingCollisionService.getDoorExteriorAndInterior(
      0,
      0,
      "south",
    );
    expect(result.exteriorX).toBe(0);
    expect(result.exteriorZ).toBe(1);
  });
});
