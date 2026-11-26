/**
 * Building-Terrain Interaction Tests
 *
 * These tests verify the critical interaction between:
 * 1. Building floor tiles (elevated above terrain)
 * 2. Terrain tiles underneath buildings
 * 3. Bounding box fallback vs. exact footprint detection
 * 4. Y-elevation calculation (building floor vs terrain)
 *
 * Key scenarios tested:
 * - Standard rectangular building: all bbox tiles are floor tiles
 * - L-shaped building: bbox has "hole" tiles that are exterior
 * - Small buildings (1-2 cells): shrunk bbox may be empty
 * - Door approach tiles: 1-tile margin around building
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { World } from "@hyperforge/shared";
import { BuildingCollisionService } from "@hyperforge/shared";
import type { BuildingLayoutInput } from "@hyperforge/shared";

const TEST_TIMEOUT = 60000;

// ============================================================================
// BUILDING LAYOUTS
// ============================================================================

/**
 * Standard 2x2 rectangular building (all cells walkable)
 */
function createRectangularBuilding(): BuildingLayoutInput {
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
        externalOpenings: new Map([["0,0,north", "door"]]),
      },
    ],
    stairs: null,
  };
}

/**
 * L-shaped building (one corner cell is NOT walkable)
 * Visual:
 *   [X][_]   <- Cell (0,0) walkable, Cell (1,0) is HOLE
 *   [X][X]   <- Cell (0,1) walkable, Cell (1,1) walkable
 */
function createLShapedBuilding(): BuildingLayoutInput {
  return {
    width: 2,
    depth: 2,
    floors: 1,
    floorPlans: [
      {
        footprint: [
          [true, false], // Row 0: cell 0 walkable, cell 1 is hole
          [true, true], // Row 1: both walkable
        ],
        roomMap: [
          [0, -1],
          [0, 0],
        ],
        internalOpenings: new Map(),
        externalOpenings: new Map([["0,0,north", "door"]]),
      },
    ],
    stairs: null,
  };
}

/**
 * Tiny 1x1 single-cell building
 */
function createTinyBuilding(): BuildingLayoutInput {
  return {
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
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function tileKey(x: number, z: number): string {
  return `${x},${z}`;
}

// ============================================================================
// TEST SUITE: TERRAIN BLOCKING BEHAVIOR
// ============================================================================

describe("Building-Terrain Interaction", () => {
  describe("Rectangular Building (Standard Case)", () => {
    let world: World;
    let collisionService: BuildingCollisionService;
    const BUILDING_ID = "rect_test";
    const BUILDING_POS = { x: 100, y: 10, z: 100 };

    beforeAll(() => {
      world = new World({ isServer: true, isClient: false });
      collisionService = new BuildingCollisionService(world);

      const layout = createRectangularBuilding();
      collisionService.registerBuilding(
        BUILDING_ID,
        "test",
        layout,
        BUILDING_POS,
        0,
      );
    }, TEST_TIMEOUT);

    afterAll(() => {
      world.destroy();
    });

    it("should have ALL bbox tiles registered as walkable floor tiles", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;
      const floor0 = building.floors[0];

      let nonWalkableTilesInBbox = 0;
      let totalBboxTiles = 0;

      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          totalBboxTiles++;
          const key = tileKey(x, z);
          if (!floor0.walkableTiles.has(key)) {
            nonWalkableTilesInBbox++;
            console.log(`[Rect] Non-walkable tile in bbox: (${x},${z})`);
          }
        }
      }

      console.log(
        `[Rect] Bbox: ${totalBboxTiles} tiles, ${nonWalkableTilesInBbox} non-walkable`,
      );

      // For rectangular buildings, ALL bbox tiles should be walkable
      expect(nonWalkableTilesInBbox).toBe(0);
    });

    it("should return correct Y-elevation for all bbox tiles", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;
      const expectedElevation = building.floors[0].elevation;

      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          const elevation = collisionService.getFloorElevation(x, z, 0);

          // All tiles should have building floor elevation
          expect(elevation).not.toBeNull();
          expect(elevation).toBeCloseTo(expectedElevation, 0.01);
        }
      }
    });

    it("should allow walking on all bbox tiles (isTileWalkableInBuilding)", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;

      let blockedCount = 0;

      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          const walkable = collisionService.isTileWalkableInBuilding(x, z, 0);
          if (!walkable) {
            blockedCount++;
            console.log(`[Rect] BLOCKED tile in bbox: (${x},${z})`);
          }
        }
      }

      // All interior tiles should be walkable
      expect(blockedCount).toBe(0);
    });
  });

  describe("L-Shaped Building (Non-Rectangular)", () => {
    let world: World;
    let collisionService: BuildingCollisionService;
    const BUILDING_ID = "lshape_test";
    const BUILDING_POS = { x: 200, y: 10, z: 200 };

    beforeAll(() => {
      world = new World({ isServer: true, isClient: false });
      collisionService = new BuildingCollisionService(world);

      const layout = createLShapedBuilding();
      collisionService.registerBuilding(
        BUILDING_ID,
        "test",
        layout,
        BUILDING_POS,
        0,
      );
    }, TEST_TIMEOUT);

    afterAll(() => {
      world.destroy();
    });

    it("should have some bbox tiles that are NOT walkable (the hole)", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;
      const floor0 = building.floors[0];

      let nonWalkableTilesInBbox = 0;
      const holeTiles: string[] = [];

      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          const key = tileKey(x, z);
          if (!floor0.walkableTiles.has(key)) {
            nonWalkableTilesInBbox++;
            holeTiles.push(`(${x},${z})`);
          }
        }
      }

      console.log(`[L-Shape] Bbox hole tiles: ${holeTiles.length}`);
      console.log(
        `[L-Shape] Hole tiles: ${holeTiles.slice(0, 10).join(", ")}...`,
      );

      // L-shaped building should have hole tiles (16 tiles per missing cell)
      expect(nonWalkableTilesInBbox).toBeGreaterThan(0);
    });

    it("should analyze hole tile blocking behavior", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;
      const floor0 = building.floors[0];

      const results = {
        blockedByShrunBbox: 0,
        allowedInApproachMargin: 0,
        walkableFloorTiles: 0,
      };

      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          const key = tileKey(x, z);
          const isFloorTile = floor0.walkableTiles.has(key);

          if (isFloorTile) {
            results.walkableFloorTiles++;
          } else {
            // This is a "hole" tile - check how it's handled
            const inShrunkBbox =
              collisionService.isTileInBuildingShrunkBoundingBox(x, z);
            const isWalkable = collisionService.isTileWalkableInBuilding(
              x,
              z,
              0,
            );

            if (inShrunkBbox) {
              results.blockedByShrunBbox++;
            } else if (isWalkable) {
              results.allowedInApproachMargin++;
            }
          }
        }
      }

      console.log(`[L-Shape] Analysis:`);
      console.log(`  - Walkable floor tiles: ${results.walkableFloorTiles}`);
      console.log(
        `  - Hole tiles blocked by shrunk bbox: ${results.blockedByShrunBbox}`,
      );
      console.log(
        `  - Hole tiles allowed (approach margin): ${results.allowedInApproachMargin}`,
      );

      // Document the current behavior
      // Note: Hole tiles in approach margin would use TERRAIN elevation, not building floor
    });

    it("should treat hole tiles as ground (walkable and outside building)", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;
      const floor0 = building.floors[0];

      let holeTile: { x: number; z: number } | null = null;
      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          const key = tileKey(x, z);
          if (!floor0.walkableTiles.has(key)) {
            holeTile = { x, z };
            break;
          }
        }
        if (holeTile) break;
      }

      expect(holeTile).not.toBeNull();
      if (!holeTile) return;

      const isWalkable = collisionService.isTileWalkableInBuilding(
        holeTile.x,
        holeTile.z,
        0,
      );
      expect(isWalkable).toBe(true);

      // Hole tile should NOT be in the walkable footprint
      const footprintResult = collisionService.isTileInBuildingAnyFloor(
        holeTile.x,
        holeTile.z,
      );
      expect(footprintResult).toBeNull();

      // Player standing on a hole tile should NOT be classified as inside the building
      const entityId =
        "lshape-hole-tile" as import("@hyperforge/shared").EntityID;
      collisionService.updatePlayerBuildingState(
        entityId,
        holeTile.x,
        holeTile.z,
        floor0.elevation,
      );
      const state = collisionService.getPlayerBuildingState(entityId);
      expect(state.insideBuildingId).toBeNull();
    });

    it("should analyze Y-elevation for hole tiles", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;
      const floor0 = building.floors[0];

      const holeTilesWithNoElevation: string[] = [];

      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          const key = tileKey(x, z);
          const isFloorTile = floor0.walkableTiles.has(key);

          if (!isFloorTile) {
            const elevation = collisionService.getFloorElevation(x, z, 0);

            if (elevation === null) {
              holeTilesWithNoElevation.push(`(${x},${z})`);
            }
          }
        }
      }

      console.log(
        `[L-Shape] Hole tiles with NO building elevation: ${holeTilesWithNoElevation.length}`,
      );
      console.log(`[L-Shape] These tiles would use TERRAIN elevation instead`);

      // This documents a potential issue: hole tiles use terrain elevation
      // If terrain is below the building visual, players could appear underground
    });
  });

  describe("Tiny Building (Single Cell)", () => {
    let world: World;
    let collisionService: BuildingCollisionService;
    const BUILDING_ID = "tiny_test";
    const BUILDING_POS = { x: 300, y: 10, z: 300 };

    beforeAll(() => {
      world = new World({ isServer: true, isClient: false });
      collisionService = new BuildingCollisionService(world);

      const layout = createTinyBuilding();
      collisionService.registerBuilding(
        BUILDING_ID,
        "test",
        layout,
        BUILDING_POS,
        0,
      );
    }, TEST_TIMEOUT);

    afterAll(() => {
      world.destroy();
    });

    it("should handle shrunk bbox correctly (may be empty)", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;

      console.log(
        `[Tiny] Bbox: (${bbox.minTileX},${bbox.minTileZ}) → (${bbox.maxTileX},${bbox.maxTileZ})`,
      );
      console.log(
        `[Tiny] Bbox size: ${bbox.maxTileX - bbox.minTileX + 1} x ${bbox.maxTileZ - bbox.minTileZ + 1}`,
      );

      // For a 1x1 cell building (4x4 tiles), shrunk bbox (margin 1) would be 2x2
      // Check that this doesn't cause issues
      let blockedByShrunBbox = 0;

      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          const inShrunk = collisionService.isTileInBuildingShrunkBoundingBox(
            x,
            z,
          );
          if (inShrunk) {
            blockedByShrunBbox++;
          }
        }
      }

      console.log(`[Tiny] Tiles in shrunk bbox: ${blockedByShrunBbox}`);

      // Shrunk bbox should be smaller than full bbox
      const bboxArea =
        (bbox.maxTileX - bbox.minTileX + 1) *
        (bbox.maxTileZ - bbox.minTileZ + 1);
      expect(blockedByShrunBbox).toBeLessThan(bboxArea);
    });

    it("should still allow walking on all floor tiles", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const floor0 = building.floors[0];

      for (const key of floor0.walkableTiles) {
        const [x, z] = key.split(",").map(Number);
        const walkable = collisionService.isTileWalkableInBuilding(x, z, 0);
        expect(walkable).toBe(true);
      }
    });
  });

  describe("Door Approach Tiles (1-Tile Margin)", () => {
    let world: World;
    let collisionService: BuildingCollisionService;
    const BUILDING_ID = "approach_test";
    const BUILDING_POS = { x: 400, y: 10, z: 400 };

    beforeAll(() => {
      world = new World({ isServer: true, isClient: false });
      collisionService = new BuildingCollisionService(world);

      const layout = createRectangularBuilding();
      collisionService.registerBuilding(
        BUILDING_ID,
        "test",
        layout,
        BUILDING_POS,
        0,
      );
    }, TEST_TIMEOUT);

    afterAll(() => {
      world.destroy();
    });

    it("should allow walking on approach tiles (just outside building)", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;

      // Test tiles just outside the bbox
      const approachTiles = [
        {
          x: bbox.minTileX - 1,
          z: Math.floor((bbox.minTileZ + bbox.maxTileZ) / 2),
          name: "West approach",
        },
        {
          x: bbox.maxTileX + 1,
          z: Math.floor((bbox.minTileZ + bbox.maxTileZ) / 2),
          name: "East approach",
        },
        {
          x: Math.floor((bbox.minTileX + bbox.maxTileX) / 2),
          z: bbox.minTileZ - 1,
          name: "North approach",
        },
        {
          x: Math.floor((bbox.minTileX + bbox.maxTileX) / 2),
          z: bbox.maxTileZ + 1,
          name: "South approach",
        },
      ];

      for (const tile of approachTiles) {
        const walkable = collisionService.isTileWalkableInBuilding(
          tile.x,
          tile.z,
          0,
        );
        const elevation = collisionService.getFloorElevation(tile.x, tile.z, 0);

        console.log(
          `[Approach] ${tile.name} (${tile.x},${tile.z}): walkable=${walkable}, elevation=${elevation}`,
        );

        // Approach tiles should be walkable (outside building, terrain rules apply)
        expect(walkable).toBe(true);
        // Approach tiles should NOT have building elevation
        expect(elevation).toBeNull();
      }
    });

    it("should correctly transition Y-elevation from approach to floor", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;
      const buildingElevation = building.floors[0].elevation;

      console.log(
        `[Approach] Building bbox: (${bbox.minTileX},${bbox.minTileZ}) → (${bbox.maxTileX},${bbox.maxTileZ})`,
      );

      // Test tiles at different distances from building
      // The door wall segments are on floor tiles at the building edge
      // True approach tiles are OUTSIDE the bbox

      const outsideApproach = { x: bbox.minTileX - 1, z: bbox.minTileZ - 1 };
      const edgeFloor = { x: bbox.minTileX, z: bbox.minTileZ };

      const outsideElevation = collisionService.getFloorElevation(
        outsideApproach.x,
        outsideApproach.z,
        0,
      );
      const edgeElevation = collisionService.getFloorElevation(
        edgeFloor.x,
        edgeFloor.z,
        0,
      );

      console.log(
        `[Approach] Outside tile (${outsideApproach.x},${outsideApproach.z}): elevation=${outsideElevation}`,
      );
      console.log(
        `[Approach] Edge floor tile (${edgeFloor.x},${edgeFloor.z}): elevation=${edgeElevation}`,
      );

      // Outside tile: terrain elevation (null from building)
      expect(outsideElevation).toBeNull();
      // Edge floor tile: building floor elevation
      expect(edgeElevation).toBeCloseTo(buildingElevation, 0.01);

      // This demonstrates the Y-transition: when player steps from (outside) to (edge floor),
      // their Y position changes from terrain height to building floor height
    });
  });

  describe("Critical: Terrain Under Building Floor", () => {
    let world: World;
    let collisionService: BuildingCollisionService;
    const BUILDING_ID = "terrain_test";
    // Building floor at Y=10 (world position Y + foundation)
    const BUILDING_POS = { x: 500, y: 5, z: 500 };

    beforeAll(() => {
      world = new World({ isServer: true, isClient: false });
      collisionService = new BuildingCollisionService(world);

      const layout = createRectangularBuilding();
      collisionService.registerBuilding(
        BUILDING_ID,
        "test",
        layout,
        BUILDING_POS,
        0,
      );
    }, TEST_TIMEOUT);

    afterAll(() => {
      world.destroy();
    });

    it("should return building elevation for ALL floor tiles (not terrain)", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const floor0 = building.floors[0];
      const expectedElevation = floor0.elevation;

      console.log(`[Terrain] Building floor elevation: ${expectedElevation}`);
      console.log(
        `[Terrain] Terrain would be lower (around Y=${BUILDING_POS.y})`,
      );

      let correctElevationCount = 0;
      let wrongElevationCount = 0;

      for (const key of floor0.walkableTiles) {
        const [x, z] = key.split(",").map(Number);
        const elevation = collisionService.getFloorElevation(x, z, 0);

        if (
          elevation !== null &&
          Math.abs(elevation - expectedElevation) < 0.01
        ) {
          correctElevationCount++;
        } else {
          wrongElevationCount++;
          console.log(
            `[Terrain] WRONG elevation at (${x},${z}): ${elevation} (expected ${expectedElevation})`,
          );
        }
      }

      console.log(
        `[Terrain] Correct elevation: ${correctElevationCount}/${floor0.walkableTiles.size}`,
      );

      // ALL floor tiles should have building floor elevation
      expect(wrongElevationCount).toBe(0);
    });

    it("should correctly identify floor tiles vs terrain tiles", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;

      // Test a grid of tiles around and inside the building
      const gridSize = 5;
      const centerX = Math.floor((bbox.minTileX + bbox.maxTileX) / 2);
      const centerZ = Math.floor((bbox.minTileZ + bbox.maxTileZ) / 2);

      console.log(
        `[Terrain] Grid analysis around building center (${centerX},${centerZ}):`,
      );

      for (let dz = -gridSize; dz <= gridSize; dz++) {
        let row = "";
        for (let dx = -gridSize; dx <= gridSize; dx++) {
          const x = centerX + dx;
          const z = centerZ + dz;

          const inFootprint = collisionService.isTileInBuildingFootprint(x, z);
          const inBbox = collisionService.isTileInBuildingBoundingBox(x, z);

          if (inFootprint) {
            row += "F"; // Floor tile (has elevation)
          } else if (inBbox) {
            row += "B"; // In bbox but not floor (should not happen for rectangular)
          } else {
            row += "."; // Terrain
          }
        }
        console.log(`[Terrain] ${row}`);
      }
    });
  });

  describe("Exact Footprint Elevation", () => {
    let world: World;
    let collisionService: BuildingCollisionService;
    const BUILDING_ID = "lshape_elevation";
    const BUILDING_POS = { x: 600, y: 10, z: 600 };

    beforeAll(() => {
      world = new World({ isServer: true, isClient: false });
      collisionService = new BuildingCollisionService(world);

      // Use L-shaped building to test hole tile elevation
      const layout = createLShapedBuilding();
      collisionService.registerBuilding(
        BUILDING_ID,
        "test",
        layout,
        BUILDING_POS,
        0,
      );
    }, TEST_TIMEOUT);

    afterAll(() => {
      world.destroy();
    });

    it("returns building elevation only for exact covered tiles via queryCollision", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;
      const expectedElevation = building.floors[0].elevation;

      let tilesWithElevation = 0;
      let tilesWithoutElevation = 0;
      let exteriorTiles = 0;

      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          // Use queryCollision which handles both walkable and non-walkable tiles
          const result = collisionService.queryCollision(x, z, 0);

          if (result.isInsideBuilding && result.elevation !== null) {
            tilesWithElevation++;
            // Verify the elevation is the building floor elevation
            expect(result.elevation).toBeCloseTo(expectedElevation, 0.01);
          } else if (result.isInsideBuilding) {
            tilesWithoutElevation++;
            console.log(
              `[LShape-Elev] Tile (${x},${z}) in building but NO elevation!`,
            );
          } else {
            exteriorTiles++;
          }
        }
      }

      console.log(
        `[LShape-Elev] Bbox tiles with elevation: ${tilesWithElevation}`,
      );
      console.log(
        `[LShape-Elev] Bbox tiles without elevation: ${tilesWithoutElevation}`,
      );

      // Exact covered tiles have floor elevation; the missing L-shaped corner
      // remains exterior terrain instead of inheriting invisible floor height.
      expect(tilesWithoutElevation).toBe(0);
      expect(tilesWithElevation).toBeGreaterThan(0);
      expect(exteriorTiles).toBeGreaterThan(0);
    });

    it("keeps an L-shaped exterior concavity outside the building elevation", () => {
      const building = collisionService.getBuilding(BUILDING_ID)!;
      const bbox = building.boundingBox;
      const floor0 = building.floors[0];

      const exteriorConcavityTiles: Array<{
        x: number;
        z: number;
        elevation: number | null;
      }> = [];

      for (let x = bbox.minTileX; x <= bbox.maxTileX; x++) {
        for (let z = bbox.minTileZ; z <= bbox.maxTileZ; z++) {
          const key = tileKey(x, z);
          const isWalkable = floor0.walkableTiles.has(key);

          if (!isWalkable) {
            const result = collisionService.queryCollision(x, z, 0);
            expect(result.isInsideBuilding).toBe(false);
            expect(result.elevation).toBeNull();
            exteriorConcavityTiles.push({ x, z, elevation: result.elevation });
          }
        }
      }

      expect(exteriorConcavityTiles.length).toBeGreaterThan(0);
    });
  });
});

// Test for building at origin (like the bank at 10,10)
describe("Building at Origin Position", () => {
  let world: World;
  let collisionService: BuildingCollisionService;
  const BUILDING_POS = { x: 10, y: 25, z: 10 };
  const BUILDING_ID = "origin_bank";

  beforeAll(async () => {
    world = new World({ isServer: true, isClient: false });
    collisionService = new BuildingCollisionService(world);

    // Create a 4x6 cell building (similar to bank recipe dimensions)
    const layout: BuildingLayoutInput = {
      width: 4,
      depth: 6,
      floors: 2,
      floorPlans: [
        {
          footprint: [
            [true, true, true, true],
            [true, true, true, true],
            [true, true, true, true],
            [true, true, true, true],
            [true, true, true, true],
            [true, true, true, true],
          ],
          roomMap: [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ],
          internalOpenings: new Map(),
          externalOpenings: new Map([["1,0,south", "door"]]),
        },
        {
          footprint: [
            [true, true, true, true],
            [true, true, true, true],
            [true, true, true, true],
            [true, true, true, true],
            [true, true, true, true],
            [true, true, true, true],
          ],
          roomMap: [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ],
          internalOpenings: new Map(),
          externalOpenings: new Map(),
        },
      ],
      stairs: null,
    };

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

  it("should have tile (10, 10) as walkable when building is at (10, Y, 10)", () => {
    const building = collisionService.getBuilding(BUILDING_ID)!;
    const bbox = building.boundingBox;
    const floor0 = building.floors[0];

    console.log(`[Origin] Building at (${BUILDING_POS.x}, ${BUILDING_POS.z})`);
    console.log(
      `[Origin] Bbox: (${bbox.minTileX},${bbox.minTileZ}) → (${bbox.maxTileX},${bbox.maxTileZ})`,
    );
    console.log(`[Origin] Total walkable tiles: ${floor0.walkableTiles.size}`);

    // Check if tile (10, 10) is walkable
    const targetTile = { x: 10, z: 10 };
    const key = tileKey(targetTile.x, targetTile.z);
    const isWalkable = floor0.walkableTiles.has(key);
    const inBbox = collisionService.isTileInBuildingBoundingBox(
      targetTile.x,
      targetTile.z,
    );
    const inBuilding = collisionService.isTileInBuildingAnyFloor(
      targetTile.x,
      targetTile.z,
    );

    console.log(
      `[Origin] Tile (10, 10): walkableTiles.has=${isWalkable}, inBbox=${inBbox}, inBuildingAnyFloor=${inBuilding?.buildingId || null}`,
    );

    // Print a grid around (10, 10) to visualize
    console.log(`[Origin] Grid around (10, 10) - W=walkable, .=not:`);
    for (let x = 6; x <= 14; x++) {
      let row = `[Origin]   x=${x.toString().padStart(2)}: `;
      for (let z = 6; z <= 14; z++) {
        const k = tileKey(x, z);
        const hasKey = floor0.walkableTiles.has(k);
        row += hasKey ? "W " : ". ";
      }
      console.log(row);
    }

    // The building center is at (10, 10)
    // Tile (10, 10) MUST be walkable for navigation to work
    expect(inBbox).toBe(BUILDING_ID);
    expect(isWalkable).toBe(true);
    expect(inBuilding).not.toBeNull();
    expect(inBuilding?.buildingId).toBe(BUILDING_ID);
  });

  it("should correctly identify when player clicks at (10, 10)", () => {
    // Simulate what happens when player clicks at world position (10.5, Y, 10.5)
    // Server converts to tile (10, 10)
    const clickTile = { x: 10, z: 10 };

    const result = collisionService.isTileInBuildingAnyFloor(
      clickTile.x,
      clickTile.z,
    );

    console.log(
      `[Origin] Click at (10, 10) detected as: ${result ? `building=${result.buildingId}, floor=${result.floorIndex}` : "NOT in building"}`,
    );

    // This MUST return the building ID for two-stage navigation to trigger
    expect(result).not.toBeNull();
    expect(result?.buildingId).toBe(BUILDING_ID);
  });
});

// Test for TERRAIN_CONSTANTS centralization
describe("TERRAIN_CONSTANTS Centralization", () => {
  it("should export TERRAIN_CONSTANTS from GameConstants", async () => {
    const { TERRAIN_CONSTANTS } = await import("@hyperforge/shared");

    expect(TERRAIN_CONSTANTS).toBeDefined();
    expect(TERRAIN_CONSTANTS.WATER_THRESHOLD).toBeDefined();
    expect(TERRAIN_CONSTANTS.MAX_WALKABLE_SLOPE).toBeDefined();
    expect(TERRAIN_CONSTANTS.SLOPE_CHECK_DISTANCE).toBeDefined();
  });

  it("should have consistent WATER_THRESHOLD value", async () => {
    const { TERRAIN_CONSTANTS } = await import("@hyperforge/shared");

    // WATER_THRESHOLD should be 16 (as per GameConstants)
    expect(TERRAIN_CONSTANTS.WATER_THRESHOLD).toBe(16);
  });

  it("should have consistent MAX_WALKABLE_SLOPE value", async () => {
    const { TERRAIN_CONSTANTS } = await import("@hyperforge/shared");

    // MAX_WALKABLE_SLOPE should be 2.5
    expect(TERRAIN_CONSTANTS.MAX_WALKABLE_SLOPE).toBe(2.5);
  });
});
