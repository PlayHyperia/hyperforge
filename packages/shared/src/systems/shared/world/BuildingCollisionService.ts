/**
 * BuildingCollisionService - Multi-level Building Collision System
 *
 * Provides tile-based collision detection for procedural buildings with
 * support for multiple floors, stairs, and directional wall blocking.
 *
 * **Features:**
 * - Multi-level collision (ground floor, upper floors, roofs)
 * - Directional wall blocking using CollisionMatrix flags
 * - Stair transitions between floors
 * - Floor-aware pathfinding queries
 * - Player floor tracking
 *
 * **Architecture:**
 * - Buildings register their collision data on spawn
 * - Each floor's walls are registered as directional WALL_* flags
 * - Walkable floor tiles are NOT blocked (allow pathfinding)
 * - External tiles remain their natural state (terrain collision)
 *
 * **Coordinate Flow:**
 * 1. BuildingGenerator outputs cells (col, row) per floor
 * 2. BuildingCollisionService transforms to world tiles (tileX, tileZ)
 * 3. Collision flags written to CollisionMatrix
 * 4. Pathfinder queries CollisionMatrix + floor-aware checks
 *
 * **Multi-Floor Collision Architecture:**
 *
 * CollisionMatrix is a 2D system that cannot store floor information. This service
 * provides floor-aware collision via a two-tier system:
 *
 * 1. **Ground floor (floorIndex 0)**: Walls registered in CollisionMatrix as WALL_* flags.
 *    These are picked up automatically by pathfinding via CollisionMatrix.isBlocked().
 *
 * 2. **Upper floors (floorIndex > 0)**: Walls stored in BuildingCollisionData.floors[n].wallSegments.
 *    Pathfinding must call isWallBlocked(fromX, fromZ, toX, toZ, floorIndex) to check these.
 *
 * **Integration with Pathfinding:**
 *
 * The pathfinder's isWalkable callback (in tile-movement.ts) checks:
 * 1. CollisionMatrix for ground-level walls and terrain obstacles
 * 2. BuildingCollisionService.isTileWalkableInBuilding() for building footprint
 * 3. BuildingCollisionService.isWallBlocked() for floor-specific wall blocking
 *
 * This ensures multi-floor buildings work correctly despite CollisionMatrix's 2D limitation.
 *
 * **Runs on:** Server (authoritative), Client (prediction)
 */

import type { World } from "../../../core/World";
import type { CollisionMatrix } from "../movement/CollisionMatrix";
import { CollisionFlag } from "../movement/CollisionFlags";
import type { TileCoord } from "../movement/TileSystem";
import type { EntityID } from "../../../types/core/identifiers";
import {
  type BuildingCollisionData,
  type FloorCollisionData,
  type WallSegment,
  type StairTile,
  type StepTile,
  type WallDirection,
  type PlayerBuildingState,
  type BuildingCollisionResult,
  type BuildingLayoutInput,
  type CellCoord,
  cellToWorldTile,
  rotateWallDirection,
  getOppositeDirection,
  toWallDirection,
  tileKey,
} from "../../../types/world/building-collision-types";

// Import building constants from procgen to ensure consistency
import {
  CELL_SIZE,
  FLOOR_HEIGHT,
  FOUNDATION_HEIGHT,
  TILES_PER_CELL,
  ENTRANCE_STEP_DEPTH,
  ENTRANCE_STEP_HEIGHT,
  ENTRANCE_STEP_COUNT,
  TERRAIN_STEP_COUNT,
  FOUNDATION_OVERHANG,
} from "@hyperforge/procgen/building";

/** Wall direction to CollisionFlag mapping */
const WALL_DIRECTION_TO_FLAG: Record<WallDirection, number> = {
  north: CollisionFlag.WALL_NORTH,
  south: CollisionFlag.WALL_SOUTH,
  east: CollisionFlag.WALL_EAST,
  west: CollisionFlag.WALL_WEST,
};

/** Cardinal directions with delta offsets (reused across methods)
 * IMPORTANT: These MUST match procgen's BuildingGenerator convention:
 * - Row 0 is the NORTH edge of the building (front)
 * - Row increases going SOUTH (toward the back)
 * - Col 0 is the WEST edge
 * - Col increases going EAST
 */
const CARDINAL_DIRECTIONS: ReadonlyArray<{
  dir: WallDirection;
  dc: number;
  dr: number;
}> = [
  { dir: "north", dc: 0, dr: -1 }, // North = row decreases
  { dir: "south", dc: 0, dr: 1 }, // South = row increases
  { dir: "east", dc: 1, dr: 0 },
  { dir: "west", dc: -1, dr: 0 },
];

/** Default collision result for tiles outside buildings (frozen to prevent mutation) */
const DEFAULT_COLLISION_RESULT: Readonly<BuildingCollisionResult> =
  Object.freeze({
    isInsideBuilding: false,
    buildingId: null,
    isWalkable: true,
    floorIndex: null,
    elevation: null,
    wallBlocking: Object.freeze({
      north: false,
      south: false,
      east: false,
      west: false,
    }),
    stairTile: null,
  });

/**
 * BuildingCollisionService
 *
 * Singleton service managing all building collision data.
 * Provides registration, queries, and player floor tracking.
 */
export class BuildingCollisionService {
  private world: World;

  /** All registered buildings by ID */
  private buildings: Map<string, BuildingCollisionData> = new Map();

  /** Spatial index: tile key -> building IDs that cover this tile */
  private tileToBuildings: Map<string, Set<string>> = new Map();

  /** Spatial index: tile key -> building ID for bounding box containment (O(1) lookup) */
  private tileToBuildingBbox: Map<string, string> = new Map();

  /** Exact ground silhouette: tile key -> building IDs covering that tile */
  private tileToBuildingGroundCoverage: Map<string, Set<string>> = new Map();

  /** Step tile spatial index: tile key -> StepTile data */
  private tileToStepTile: Map<string, StepTile> = new Map();

  /** Player floor states by entity ID */
  private playerFloorStates: Map<EntityID, PlayerBuildingState> = new Map();

  /** Debug logging flag - disable in production for performance */
  private _debugLogging = false;

  constructor(world: World) {
    this.world = world;
  }

  /** Enable/disable debug logging for building collision */
  setDebugLogging(enabled: boolean): void {
    this._debugLogging = enabled;
  }

  // ============================================================================
  // BUILDING REGISTRATION
  // ============================================================================

  /**
   * Register a building's collision data
   *
   * Converts building layout to collision data and registers with CollisionMatrix.
   *
   * @param buildingId - Unique building ID
   * @param townId - Town this building belongs to
   * @param layout - Building layout from BuildingGenerator
   * @param worldPosition - Building center position in world coords
   * @param rotation - Y-axis rotation in radians
   */
  registerBuilding(
    buildingId: string,
    townId: string,
    layout: BuildingLayoutInput,
    worldPosition: { x: number; y: number; z: number },
    rotation: number,
  ): void {
    // === INPUT VALIDATION ===
    if (!buildingId || typeof buildingId !== "string") {
      throw new Error(`[BuildingCollision] Invalid buildingId: ${buildingId}`);
    }
    if (!townId || typeof townId !== "string") {
      throw new Error(
        `[BuildingCollision] Invalid townId for building ${buildingId}: ${townId}`,
      );
    }
    if (!layout || !layout.floorPlans || layout.floorPlans.length === 0) {
      throw new Error(
        `[BuildingCollision] Building ${buildingId} has invalid layout: no floor plans`,
      );
    }
    if (
      layout.roofWalkable !== undefined &&
      typeof layout.roofWalkable !== "boolean"
    ) {
      throw new Error(
        `[BuildingCollision] Building ${buildingId} has invalid roofWalkable: expected boolean`,
      );
    }
    if (
      !worldPosition ||
      typeof worldPosition.x !== "number" ||
      typeof worldPosition.z !== "number"
    ) {
      throw new Error(
        `[BuildingCollision] Building ${buildingId} has invalid worldPosition: ${JSON.stringify(worldPosition)}`,
      );
    }
    if (
      !Number.isFinite(worldPosition.x) ||
      !Number.isFinite(worldPosition.z)
    ) {
      throw new Error(
        `[BuildingCollision] Building ${buildingId} has non-finite worldPosition: (${worldPosition.x}, ${worldPosition.z})`,
      );
    }
    if (typeof rotation !== "number" || !Number.isFinite(rotation)) {
      throw new Error(
        `[BuildingCollision] Building ${buildingId} has invalid rotation: ${rotation}`,
      );
    }

    // Generate collision data from layout
    const collisionData = this.generateCollisionData(
      buildingId,
      townId,
      layout,
      worldPosition,
      rotation,
    );

    // Store building data
    this.buildings.set(buildingId, collisionData);

    // Update spatial index
    this.updateSpatialIndex(collisionData);

    // Register walls with CollisionMatrix
    this.registerWallsWithCollisionMatrix(collisionData);

    // Get floor 0 data for logging
    const floor0 = collisionData.floors[0];
    const doorCount =
      floor0?.wallSegments.filter(
        (w) => w.hasOpening && w.openingType === "door",
      ).length ?? 0;
    const tileCount = floor0?.walkableTiles.size ?? 0;

    // ALWAYS log first building registration to confirm system is working
    if (this.buildings.size === 1) {
      // Show sample of walkable tiles to verify coordinate system
      const sampleTiles = Array.from(floor0?.walkableTiles ?? [])
        .slice(0, 10)
        .join(", ");
      console.log(
        `[BuildingCollision] ✓ FIRST BUILDING REGISTERED: ${buildingId}\n` +
          `  Position: (${worldPosition.x.toFixed(0)}, ${worldPosition.y.toFixed(1)}, ${worldPosition.z.toFixed(0)})\n` +
          `  Walkable tiles: ${tileCount}\n` +
          `  Sample tiles: ${sampleTiles}\n` +
          `  Doors: ${doorCount}\n` +
          `  Bbox: (${collisionData.boundingBox.minTileX},${collisionData.boundingBox.minTileZ}) → (${collisionData.boundingBox.maxTileX},${collisionData.boundingBox.maxTileZ})`,
      );
    }

    // === POST-GENERATION VALIDATION ===
    // Throw errors for critical issues that would break navigation
    if (tileCount === 0) {
      throw new Error(
        `[BuildingCollision] CRITICAL: Building ${buildingId} has NO WALKABLE TILES! ` +
          `Position: (${worldPosition.x}, ${worldPosition.z}), Layout: ${layout.width}x${layout.depth} cells`,
      );
    }

    // Validate bounding box is sensible
    const bbox = collisionData.boundingBox;
    if (bbox.minTileX > bbox.maxTileX || bbox.minTileZ > bbox.maxTileZ) {
      throw new Error(
        `[BuildingCollision] CRITICAL: Building ${buildingId} has invalid bounding box: ` +
          `(${bbox.minTileX},${bbox.minTileZ}) → (${bbox.maxTileX},${bbox.maxTileZ})`,
      );
    }

    // Count arches for entrance check
    const archCount =
      floor0?.wallSegments.filter(
        (w) => w.hasOpening && w.openingType === "arch",
      ).length ?? 0;

    // Warn (but don't throw) if no entrances - some test buildings may intentionally have none
    // Both doors AND arches count as valid entrances
    if (doorCount === 0 && archCount === 0) {
      console.warn(
        `[BuildingCollision] WARNING: Building ${buildingId} has NO ENTRANCES (doors or arches)! Players cannot enter.`,
      );
    }

    // Detailed debug logging (when enabled)
    if (this._debugLogging) {
      const stairCount = floor0?.stairTiles.length ?? 0;
      console.log(
        `[BuildingCollision] Registered ${buildingId} at (${worldPosition.x.toFixed(0)}, ${worldPosition.z.toFixed(0)}) ` +
          `rotation=${((rotation * 180) / Math.PI).toFixed(0)}° | ` +
          `tiles=${tileCount}, doors=${doorCount}, arches=${archCount}, stairs=${stairCount} | ` +
          `bbox=(${collisionData.boundingBox.minTileX},${collisionData.boundingBox.minTileZ})→(${collisionData.boundingBox.maxTileX},${collisionData.boundingBox.maxTileZ})`,
      );

      // Log external openings from layout
      const floorPlan0 = layout.floorPlans[0];
      if (floorPlan0?.externalOpenings) {
        const openingsList = Array.from(floorPlan0.externalOpenings.entries())
          .filter(([, v]) => v === "door" || v === "arch")
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        console.log(
          `[BuildingCollision] ${buildingId} external openings (floor 0): ${openingsList || "NONE"}`,
        );
      }

      // Log door wall segment world tiles for debugging
      const doorSegments =
        floor0?.wallSegments.filter(
          (w) => w.hasOpening && w.openingType === "door",
        ) ?? [];
      if (doorSegments.length > 0) {
        const doorTiles = doorSegments
          .slice(0, 4)
          .map((d) => `(${d.tileX},${d.tileZ}):${d.side}`)
          .join(", ");
        console.log(
          `[BuildingCollision] ${buildingId} door wall segment tiles (first 4): ${doorTiles}`,
        );
      }
    }
  }

  /**
   * Unregister a building (e.g., when destroyed)
   */
  unregisterBuilding(buildingId: string): void {
    const building = this.buildings.get(buildingId);
    if (!building) return;

    // Remove from spatial index
    this.removeSpatialIndex(building);

    // Remove wall flags from CollisionMatrix
    this.unregisterWallsFromCollisionMatrix(building);

    // Remove building data
    this.buildings.delete(buildingId);
  }

  // ============================================================================
  // COLLISION DATA GENERATION
  // ============================================================================

  /**
   * Generate collision data from building layout
   */
  private generateCollisionData(
    buildingId: string,
    townId: string,
    layout: BuildingLayoutInput,
    worldPosition: { x: number; y: number; z: number },
    rotation: number,
  ): BuildingCollisionData {
    const floors: FloorCollisionData[] = [];

    // Track bounding box
    let minTileX = Infinity;
    let maxTileX = -Infinity;
    let minTileZ = Infinity;
    let maxTileZ = -Infinity;

    // Process each floor
    for (let floorIndex = 0; floorIndex < layout.floors; floorIndex++) {
      const floorPlan = layout.floorPlans[floorIndex];
      if (!floorPlan) continue;

      const floorData = this.generateFloorCollisionData(
        floorIndex,
        floorPlan,
        layout,
        worldPosition,
        rotation,
      );

      floors.push(floorData);

      // Update bounding box from walkable tiles
      for (const key of floorData.walkableTiles) {
        const [x, z] = key.split(",").map(Number);
        minTileX = Math.min(minTileX, x);
        maxTileX = Math.max(maxTileX, x);
        minTileZ = Math.min(minTileZ, z);
        maxTileZ = Math.max(maxTileZ, z);
      }
    }

    // Redistribute stair landing tiles to their correct floors.
    // generateStairTiles() creates both bottom tiles and landing tiles, but
    // generateFloorCollisionData() puts them all on the generating floor (floor 0).
    // Landing tiles (isLanding=true) logically belong on their fromFloor (floor 1).
    for (const floor of floors) {
      const landingTiles = floor.stairTiles.filter((s) => s.isLanding);
      if (landingTiles.length > 0) {
        // Remove landings from the generating floor
        floor.stairTiles = floor.stairTiles.filter((s) => !s.isLanding);
        // Place each landing on its correct floor
        for (const tile of landingTiles) {
          const destFloor = floors.find((f) => f.floorIndex === tile.fromFloor);
          if (destFloor) {
            destFloor.stairTiles.push(tile);
          }
        }
      }
    }

    // Generate roof floor (top of building)
    const roofFloor = this.generateRoofCollisionData(
      layout,
      worldPosition,
      rotation,
    );
    if (roofFloor) {
      floors.push(roofFloor);
    }

    // Generate entrance step tiles (outside building, directional walkability)
    const stepTiles = this.generateStepTiles(
      buildingId,
      layout,
      worldPosition,
      rotation,
    );
    const groundCoverageTiles = this.generateGroundCoverageTiles(
      layout,
      worldPosition,
      rotation,
    );

    return {
      buildingId,
      townId,
      worldPosition,
      rotation,
      cellWidth: layout.width,
      cellDepth: layout.depth,
      floors,
      ...(layout.roofWalkable === false
        ? { nonWalkableRoofFloor: layout.floors }
        : {}),
      stepTiles,
      groundCoverageTiles,
      boundingBox: {
        minTileX,
        maxTileX,
        minTileZ,
        maxTileZ,
      },
    };
  }

  /**
   * Convert the exact ground-level silhouette to world tiles.
   *
   * Procgen supplies exteriorFootprint for production layouts. The fallback
   * derives the same shape for direct callers and older test fixtures: empty
   * cells reachable from the grid edge are exterior, while enclosed voids are
   * part of the building coverage.
   */
  private generateGroundCoverageTiles(
    layout: BuildingLayoutInput,
    worldPosition: { x: number; y: number; z: number },
    rotation: number,
  ): Set<string> {
    const groundFootprint = layout.floorPlans[0]?.footprint ?? [];
    const coverageFootprint =
      layout.exteriorFootprint ??
      this.deriveExteriorFootprint(groundFootprint, layout.width, layout.depth);
    const coverageTiles = new Set<string>();
    const halfTiles = Math.floor(TILES_PER_CELL / 2);

    for (let row = 0; row < coverageFootprint.length; row++) {
      for (let col = 0; col < coverageFootprint[row].length; col++) {
        if (!coverageFootprint[row][col]) continue;

        const centerTile = cellToWorldTile(
          { col, row },
          worldPosition.x,
          worldPosition.z,
          layout.width,
          layout.depth,
          rotation,
          CELL_SIZE,
        );

        for (let dtx = -halfTiles; dtx < TILES_PER_CELL - halfTiles; dtx++) {
          for (let dtz = -halfTiles; dtz < TILES_PER_CELL - halfTiles; dtz++) {
            coverageTiles.add(tileKey(centerTile.x + dtx, centerTile.z + dtz));
          }
        }
      }
    }

    return coverageTiles;
  }

  private deriveExteriorFootprint(
    footprint: boolean[][],
    width: number,
    depth: number,
  ): boolean[][] {
    const coverage = Array.from({ length: depth }, (_, row) =>
      Array.from({ length: width }, (_, col) => footprint[row]?.[col] === true),
    );
    const exterior = Array.from({ length: depth }, () =>
      Array.from({ length: width }, () => false),
    );
    const queue: CellCoord[] = [];

    for (let row = 0; row < depth; row++) {
      for (let col = 0; col < width; col++) {
        if (
          (row === 0 || row === depth - 1 || col === 0 || col === width - 1) &&
          !coverage[row][col]
        ) {
          exterior[row][col] = true;
          queue.push({ col, row });
        }
      }
    }

    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      for (const { dc, dr } of CARDINAL_DIRECTIONS) {
        const col = current.col + dc;
        const row = current.row + dr;
        if (
          col >= 0 &&
          col < width &&
          row >= 0 &&
          row < depth &&
          !coverage[row][col] &&
          !exterior[row][col]
        ) {
          exterior[row][col] = true;
          queue.push({ col, row });
        }
      }
    }

    for (let row = 0; row < depth; row++) {
      for (let col = 0; col < width; col++) {
        if (!coverage[row][col] && !exterior[row][col]) {
          coverage[row][col] = true;
        }
      }
    }

    return coverage;
  }

  /**
   * Generate collision data for a single floor
   */
  private generateFloorCollisionData(
    floorIndex: number,
    floorPlan: BuildingLayoutInput["floorPlans"][0],
    layout: BuildingLayoutInput,
    worldPosition: { x: number; y: number; z: number },
    rotation: number,
  ): FloorCollisionData {
    const walkableTiles = new Set<string>();
    const wallSegments: WallSegment[] = [];
    const stairTiles: StairTile[] = [];

    // Calculate floor elevation
    const elevation =
      worldPosition.y + FOUNDATION_HEIGHT + floorIndex * FLOOR_HEIGHT;

    // Process each cell in the footprint
    // IMPORTANT: Each cell is CELL_SIZE x CELL_SIZE meters (4m), which covers TILES_PER_CELL x TILES_PER_CELL tiles (4x4 = 16)
    // We need to register ALL tiles within each cell as walkable, not just the center
    // Building positions must be grid-aligned (via snapToBuildingGrid) for this to work correctly
    const tilesPerCell = TILES_PER_CELL;

    for (let row = 0; row < floorPlan.footprint.length; row++) {
      for (let col = 0; col < floorPlan.footprint[row].length; col++) {
        if (!floorPlan.footprint[row][col]) continue;

        const cell: CellCoord = { col, row };

        // Get the center tile of this cell (for reference point)
        const centerTile = cellToWorldTile(
          cell,
          worldPosition.x,
          worldPosition.z,
          layout.width,
          layout.depth,
          rotation,
          CELL_SIZE,
        );

        // Register ALL tiles within this cell as walkable
        // Each cell is tilesPerCell x tilesPerCell tiles
        // Center the tile grid on the cell center
        const halfTiles = Math.floor(tilesPerCell / 2);
        for (let dtx = -halfTiles; dtx < tilesPerCell - halfTiles; dtx++) {
          for (let dtz = -halfTiles; dtz < tilesPerCell - halfTiles; dtz++) {
            const tileX = centerTile.x + dtx;
            const tileZ = centerTile.z + dtz;
            walkableTiles.add(tileKey(tileX, tileZ));
          }
        }

        // Generate walls for this cell (walls are at cell boundaries)
        const cellWalls = this.generateCellWalls(
          cell,
          floorPlan,
          worldPosition,
          rotation,
          layout.width,
          layout.depth,
        );
        wallSegments.push(...cellWalls);
      }
    }

    // Process stairs on this floor (only if there IS a floor above to connect to)
    if (layout.stairs && floorIndex < layout.floors - 1) {
      const stairData = this.generateStairTiles(
        layout.stairs,
        floorIndex,
        worldPosition,
        rotation,
        layout.width,
        layout.depth,
      );
      stairTiles.push(...stairData);
    }

    // PERF: Pre-index walls by tile key for O(1) lookup in queryCollision
    const wallsByTile = new Map<string, WallSegment[]>();
    for (const wall of wallSegments) {
      const wKey = tileKey(wall.tileX, wall.tileZ);
      let wallList = wallsByTile.get(wKey);
      if (!wallList) {
        wallList = [];
        wallsByTile.set(wKey, wallList);
      }
      wallList.push(wall);
    }

    return {
      floorIndex,
      elevation,
      walkableTiles,
      wallSegments,
      wallsByTile,
      stairTiles,
    };
  }

  /**
   * Generate wall segments for a single cell
   *
   * IMPORTANT: Each cell is CELL_SIZE x CELL_SIZE meters (4x4 tiles).
   * Wall flags should be set on ALL tiles within the cell that have that wall.
   * This ensures movement is blocked in the correct direction from any tile in the cell.
   */
  private generateCellWalls(
    cell: CellCoord,
    floorPlan: BuildingLayoutInput["floorPlans"][0],
    worldPosition: { x: number; y: number; z: number },
    rotation: number,
    buildingWidth: number,
    buildingDepth: number,
  ): WallSegment[] {
    const walls: WallSegment[] = [];
    const { col, row } = cell;
    const footprint = floorPlan.footprint;
    const roomMap = floorPlan.roomMap;
    const roomId = roomMap[row]?.[col] ?? -1;

    // Get center tile of this cell
    const centerTile = cellToWorldTile(
      cell,
      worldPosition.x,
      worldPosition.z,
      buildingWidth,
      buildingDepth,
      rotation,
      CELL_SIZE,
    );

    // Calculate tile coverage for this cell (TILES_PER_CELL tiles in each direction)
    const tilesPerCell = TILES_PER_CELL;
    const halfTiles = Math.floor(tilesPerCell / 2);

    // Check each cardinal direction for walls
    for (const { dir, dc, dr } of CARDINAL_DIRECTIONS) {
      const neighborCol = col + dc;
      const neighborRow = row + dr;
      const neighborExists = footprint[neighborRow]?.[neighborCol] === true;
      const neighborRoomId = roomMap[neighborRow]?.[neighborCol] ?? -1;

      // Determine if there should be a wall
      let shouldHaveWall = false;
      let hasOpening = false;
      let openingType: "door" | "arch" | "window" | undefined;

      if (!neighborExists) {
        // External edge - wall unless there's an external opening
        shouldHaveWall = true;
        const openingKey = `${col},${row},${dir}`;
        const externalOpening = floorPlan.externalOpenings.get(openingKey);
        if (externalOpening) {
          hasOpening = externalOpening !== "window"; // Windows don't allow passage
          openingType = externalOpening as "door" | "arch" | "window";
          if (
            this._debugLogging &&
            (openingType === "door" || openingType === "arch")
          ) {
            console.log(
              `[BuildingCollision] Found ${openingType} at cell(${col},${row}) facing ${dir} → key=${openingKey}`,
            );
          }
        }
      } else if (neighborRoomId !== roomId && neighborRoomId !== -1) {
        // Internal wall between rooms - wall unless there's an internal opening
        shouldHaveWall = true;
        const openingKey = `${col},${row},${dir}`;
        const internalOpening = floorPlan.internalOpenings.get(openingKey);
        if (internalOpening) {
          hasOpening = true;
          openingType = internalOpening as "door" | "arch";
        }
      }

      if (shouldHaveWall) {
        // Transform wall direction for rotation
        const worldDir = rotateWallDirection(dir, rotation);

        // Create wall segments ONLY for tiles on the EDGE of the cell facing this direction
        // This is critical - only edge tiles should block movement across the wall
        // Interior tiles within the cell should not have wall flags
        for (let dtx = -halfTiles; dtx < tilesPerCell - halfTiles; dtx++) {
          for (let dtz = -halfTiles; dtz < tilesPerCell - halfTiles; dtz++) {
            // Only add wall segment if this tile is on the edge facing the wall direction
            // World coordinates: North = -Z, South = +Z, East = +X, West = -X
            const isOnEdge =
              (worldDir === "north" && dtz === -halfTiles) || // North edge (min Z within cell)
              (worldDir === "south" && dtz === tilesPerCell - halfTiles - 1) || // South edge (max Z within cell)
              (worldDir === "east" && dtx === tilesPerCell - halfTiles - 1) || // East edge (max X within cell)
              (worldDir === "west" && dtx === -halfTiles); // West edge (min X within cell)

            if (isOnEdge) {
              // For doors, only the CENTER tiles of the edge should have openings
              // Doors are ~1.6m wide (DOOR_WIDTH), which is ~2 tiles
              // A cell edge has 4 tiles, so only tiles at dtx/dtz = -1 and 0 (center 2) are door tiles
              let tileHasOpening = hasOpening;
              let tileOpeningType = openingType;

              if (
                hasOpening &&
                (openingType === "door" || openingType === "arch")
              ) {
                // Determine if this tile is in the center of the edge (opening width)
                // Doors and arches are both ~2 tiles wide at the center of the 4-tile edge.
                // For north/south walls, check dtx position
                // For east/west walls, check dtz position
                const isNorthSouth =
                  worldDir === "north" || worldDir === "south";
                const edgeOffset = isNorthSouth ? dtx : dtz;
                // Center tiles are at offset -1 and 0 (indices 1 and 2 of 4)
                const isCenterTile = edgeOffset === -1 || edgeOffset === 0;

                if (!isCenterTile) {
                  // This is a side tile, not part of the opening
                  tileHasOpening = false;
                  tileOpeningType = undefined;
                }
              }

              walls.push({
                tileX: centerTile.x + dtx,
                tileZ: centerTile.z + dtz,
                side: worldDir,
                hasOpening: tileHasOpening,
                openingType: tileOpeningType,
              });
            }
          }
        }
      }
    }

    return walls;
  }

  /**
   * Generate stair tiles for floor transitions
   */
  private generateStairTiles(
    stairs: NonNullable<BuildingLayoutInput["stairs"]>,
    floorIndex: number,
    worldPosition: { x: number; y: number; z: number },
    rotation: number,
    buildingWidth: number,
    buildingDepth: number,
  ): StairTile[] {
    const stairTiles: StairTile[] = [];
    const direction = toWallDirection(stairs.direction);
    const tilesPerCell = TILES_PER_CELL;
    const halfTiles = Math.floor(tilesPerCell / 2);

    // Bottom stair cell (departure from this floor)
    const bottomCell: CellCoord = { col: stairs.col, row: stairs.row };
    const bottomCenterTile = cellToWorldTile(
      bottomCell,
      worldPosition.x,
      worldPosition.z,
      buildingWidth,
      buildingDepth,
      rotation,
      CELL_SIZE,
    );

    // Generate stair tiles for ALL tiles in the bottom stair cell (4x4 = 16 tiles)
    // This ensures stair elevation works regardless of which tile in the cell the player walks on
    for (let dtx = -halfTiles; dtx < tilesPerCell - halfTiles; dtx++) {
      for (let dtz = -halfTiles; dtz < tilesPerCell - halfTiles; dtz++) {
        stairTiles.push({
          tileX: bottomCenterTile.x + dtx,
          tileZ: bottomCenterTile.z + dtz,
          fromFloor: floorIndex,
          toFloor: floorIndex + 1,
          direction: rotateWallDirection(direction, rotation),
          isLanding: false,
        });
      }
    }

    // Top landing cell (arrival to next floor)
    const topCell: CellCoord = {
      col: stairs.landing.col,
      row: stairs.landing.row,
    };
    const topCenterTile = cellToWorldTile(
      topCell,
      worldPosition.x,
      worldPosition.z,
      buildingWidth,
      buildingDepth,
      rotation,
      CELL_SIZE,
    );

    // Generate stair tiles for ALL tiles in the top landing cell (4x4 = 16 tiles)
    for (let dtx = -halfTiles; dtx < tilesPerCell - halfTiles; dtx++) {
      for (let dtz = -halfTiles; dtz < tilesPerCell - halfTiles; dtz++) {
        stairTiles.push({
          tileX: topCenterTile.x + dtx,
          tileZ: topCenterTile.z + dtz,
          fromFloor: floorIndex + 1,
          toFloor: floorIndex,
          direction: rotateWallDirection(
            getOppositeDirection(direction),
            rotation,
          ),
          isLanding: true,
        });
      }
    }

    return stairTiles;
  }

  /**
   * Generate roof collision data (walkable roof surface)
   */
  private generateRoofCollisionData(
    layout: BuildingLayoutInput,
    worldPosition: { x: number; y: number; z: number },
    rotation: number,
  ): FloorCollisionData | null {
    // Pitched/non-accessible roofs must not publish an artificial flat floor,
    // perimeter walls, or walkable tiles. Existing layouts retain their roof.
    if (layout.roofWalkable === false) return null;

    // Get the top floor footprint
    const topFloorPlan = layout.floorPlans[layout.floors - 1];
    if (!topFloorPlan) return null;

    const walkableTiles = new Set<string>();
    const wallSegments: WallSegment[] = [];

    // Roof elevation is at top of the building
    const elevation =
      worldPosition.y + FOUNDATION_HEIGHT + layout.floors * FLOOR_HEIGHT;

    // Each cell is CELL_SIZE x CELL_SIZE meters (4x4 tiles)
    const tilesPerCell = TILES_PER_CELL;
    const halfTiles = Math.floor(tilesPerCell / 2);

    // Process each cell in the top floor footprint
    for (let row = 0; row < topFloorPlan.footprint.length; row++) {
      for (let col = 0; col < topFloorPlan.footprint[row].length; col++) {
        if (!topFloorPlan.footprint[row][col]) continue;

        const cell: CellCoord = { col, row };
        const centerTile = cellToWorldTile(
          cell,
          worldPosition.x,
          worldPosition.z,
          layout.width,
          layout.depth,
          rotation,
          CELL_SIZE,
        );

        // Register ALL tiles within this cell as walkable
        for (let dtx = -halfTiles; dtx < tilesPerCell - halfTiles; dtx++) {
          for (let dtz = -halfTiles; dtz < tilesPerCell - halfTiles; dtz++) {
            walkableTiles.add(tileKey(centerTile.x + dtx, centerTile.z + dtz));
          }
        }

        // Add edge walls (roof has walls on all external edges)
        for (const { dir, dc, dr } of CARDINAL_DIRECTIONS) {
          const neighborCol = col + dc;
          const neighborRow = row + dr;
          const neighborExists =
            topFloorPlan.footprint[neighborRow]?.[neighborCol] === true;

          if (!neighborExists) {
            const worldDir = rotateWallDirection(dir, rotation);

            // Create wall segments for ALL tiles in this cell with this wall direction
            for (let dtx = -halfTiles; dtx < tilesPerCell - halfTiles; dtx++) {
              for (
                let dtz = -halfTiles;
                dtz < tilesPerCell - halfTiles;
                dtz++
              ) {
                wallSegments.push({
                  tileX: centerTile.x + dtx,
                  tileZ: centerTile.z + dtz,
                  side: worldDir,
                  hasOpening: false,
                });
              }
            }
          }
        }
      }
    }

    return {
      floorIndex: layout.floors, // Roof is one floor above top floor
      elevation,
      walkableTiles,
      wallSegments,
      stairTiles: [], // Roof has no stairs (access via terrace or ladder)
    };
  }

  /**
   * Generate entrance step tiles for building doors
   *
   * Steps are outside the building and can only be walked onto from the front.
   * Side approach is blocked to enforce using the stairs properly.
   *
   * Step area: ~1.8m wide (door width + 0.2m) × ~2.4m deep (6 steps)
   * Only the center 2 tiles (aligned with door) are walkable.
   *
   * Step heights match the visual geometry from BuildingGenerator:
   * - Upper steps (ENTRANCE_STEP_COUNT): Go from FOUNDATION_HEIGHT down to 0
   * - Lower steps (TERRAIN_STEP_COUNT): Go from 0 down into terrain
   */
  private generateStepTiles(
    buildingId: string,
    layout: BuildingLayoutInput,
    worldPosition: { x: number; y: number; z: number },
    rotation: number,
  ): StepTile[] {
    const stepTiles: StepTile[] = [];
    const groundFloor = layout.floorPlans[0];
    if (!groundFloor) return stepTiles;

    const halfCell = CELL_SIZE / 2;
    const totalSteps = ENTRANCE_STEP_COUNT + TERRAIN_STEP_COUNT;
    const stepDepthTotal = totalSteps * ENTRANCE_STEP_DEPTH;

    // Distance where upper steps end and terrain steps begin
    const upperStepsEndDist =
      halfCell +
      FOUNDATION_OVERHANG +
      ENTRANCE_STEP_DEPTH * ENTRANCE_STEP_COUNT;

    // Building's base terrain height (before flat zone modifications)
    const terrainHeight = worldPosition.y;

    // Find all ground floor entrances (doors AND arches need step tiles)
    for (const [key, opening] of groundFloor.externalOpenings) {
      if (opening !== "door" && opening !== "arch") continue;

      const [colStr, rowStr, side] = key.split(",");
      const col = parseInt(colStr, 10);
      const row = parseInt(rowStr, 10);

      // Get cell center in world coordinates
      const cell: CellCoord = { col, row };
      const cellCenter = cellToWorldTile(
        cell,
        worldPosition.x,
        worldPosition.z,
        layout.width,
        layout.depth,
        rotation,
        CELL_SIZE,
      );

      // Use the tile boundary as the door center (not tile center)
      // This aligns step tiles with door tiles which are at the center of the cell edge
      // Door tiles are at dtx=-1,0 (or dtz=-1,0), so the center is at the tile boundary
      const cellWorldX = cellCenter.x;
      const cellWorldZ = cellCenter.z;

      // Determine step direction based on door side
      const rawDir = toWallDirection(side);
      const worldDir = rotateWallDirection(rawDir, rotation);

      // Step direction vectors
      let dirX = 0;
      let dirZ = 0;
      switch (worldDir) {
        case "north":
          dirZ = -1;
          break;
        case "south":
          dirZ = 1;
          break;
        case "east":
          dirX = 1;
          break;
        case "west":
          dirX = -1;
          break;
      }

      // Step area starts at building edge (halfCell from cell center)
      // and extends outward by stepDepthTotal
      const startDist = halfCell + FOUNDATION_OVERHANG;
      const endDist = startDist + stepDepthTotal;

      // Generate step tiles - only the center 2 tiles in the perpendicular direction
      // (matching the door width which is only 2 tiles)
      for (let depth = 0; depth < Math.ceil(endDist); depth++) {
        const dist = startDist + depth + 0.5; // Center of each tile
        if (dist > endDist + 0.5) break;

        // Calculate step height based on distance from building
        // This matches the visual geometry from BuildingGenerator
        let stepHeight: number;
        if (dist < upperStepsEndDist) {
          // Upper steps: go from FOUNDATION_HEIGHT down to 0
          // Linear interpolation from foundation to ground level
          const t = (dist - startDist) / (upperStepsEndDist - startDist);
          stepHeight = FOUNDATION_HEIGHT * (1 - t);
        } else {
          // Lower (terrain) steps: go from 0 down into terrain
          // Linear interpolation from 0 to negative
          const terrainDist = dist - upperStepsEndDist;
          const terrainDepth = TERRAIN_STEP_COUNT * ENTRANCE_STEP_DEPTH;
          const t = Math.min(1, terrainDist / terrainDepth);
          // At end of terrain steps, height is -(TERRAIN_STEP_COUNT - 1) * ENTRANCE_STEP_HEIGHT
          stepHeight = -t * (TERRAIN_STEP_COUNT - 1) * ENTRANCE_STEP_HEIGHT;
        }

        const stepWorldX = cellWorldX + dirX * dist;
        const stepWorldZ = cellWorldZ + dirZ * dist;

        // Only add center tiles (perpendicular offsets -1, 0, but not -2 or +1)
        // This creates a 2-tile wide walkable path on the steps
        const perpX = -dirZ; // Perpendicular direction
        const perpZ = dirX;

        // Center 2 tiles only (matching door width of 2 tiles)
        for (const offset of [-0.5, 0.5]) {
          const finalTileX = Math.floor(stepWorldX + perpX * offset);
          const finalTileZ = Math.floor(stepWorldZ + perpZ * offset);

          // Avoid duplicates (keep higher step if overlapping)
          const existing = stepTiles.find(
            (s) => s.tileX === finalTileX && s.tileZ === finalTileZ,
          );
          if (!existing) {
            stepTiles.push({
              tileX: finalTileX,
              tileZ: finalTileZ,
              approachDirection: worldDir,
              buildingId,
              stepHeight,
              terrainHeight,
            });
          } else if (stepHeight > existing.stepHeight) {
            // If overlapping steps from multiple doors, use the higher one
            existing.stepHeight = stepHeight;
          }
        }
      }
    }

    return stepTiles;
  }

  // ============================================================================
  // COLLISION MATRIX INTEGRATION
  // ============================================================================

  /**
   * Register building walls with the world's CollisionMatrix
   *
   * This adds directional WALL_* flags for walls that don't have openings.
   * Floors are NOT blocked - they remain walkable.
   *
   * **Important:** Only ground floor (floorIndex 0) walls are registered in
   * CollisionMatrix. This is because CollisionMatrix is 2D tile-based and
   * doesn't have floor awareness. Upper floor walls are handled by
   * queryCollision() which accepts a floor parameter.
   *
   * **Critical for navigation**: Walls must be registered on BOTH the interior
   * tile AND the exterior tile to properly block movement in both directions.
   * - Interior tile: has wall flag preventing exit in that direction
   * - Exterior tile: has opposite wall flag preventing entry from that direction
   */
  private registerWallsWithCollisionMatrix(
    building: BuildingCollisionData,
  ): void {
    const collision = this.world.collision as CollisionMatrix;
    if (!collision) return;

    // Only register ground floor walls - CollisionMatrix is 2D and doesn't
    // have floor awareness. Upper floor collision is handled by queryCollision()
    const groundFloor = building.floors.find((f) => f.floorIndex === 0);
    if (!groundFloor) return;

    let registeredCount = 0;
    let skippedCount = 0;
    let exteriorWallCount = 0;

    for (const wall of groundFloor.wallSegments) {
      // Only register walls that block movement (no openings)
      if (!wall.hasOpening) {
        const flag = WALL_DIRECTION_TO_FLAG[wall.side];
        if (flag) {
          // Register wall on the INTERIOR tile (inside building)
          collision.addFlags(wall.tileX, wall.tileZ, flag);
          registeredCount++;

          // CRITICAL FIX: Also register the OPPOSITE wall flag on the EXTERIOR tile
          // This ensures movement FROM outside TO inside is blocked
          // Without this, CollisionMatrix.isBlocked() can't detect the wall
          // when the source tile is outside the building
          const oppositeFlag =
            WALL_DIRECTION_TO_FLAG[getOppositeDirection(wall.side)];
          if (oppositeFlag) {
            // Calculate exterior tile position based on wall direction
            const exteriorTile = this.getExteriorTileForWall(wall);
            if (exteriorTile) {
              collision.addFlags(exteriorTile.x, exteriorTile.z, oppositeFlag);
              exteriorWallCount++;
            }
          }
        }
      } else {
        skippedCount++;
      }
    }

    // Always log wall registration for debugging navigation issues
    console.log(
      `[BuildingCollision] ${building.buildingId}: Registered ${registeredCount} interior + ${exteriorWallCount} exterior wall flags in CollisionMatrix ` +
        `(skipped ${skippedCount} with openings, total wallSegments: ${groundFloor.wallSegments.length})`,
    );
  }

  /**
   * Get the exterior tile position for a wall segment.
   * The exterior tile is the tile OUTSIDE the building, adjacent to the wall.
   */
  private getExteriorTileForWall(
    wall: WallSegment,
  ): { x: number; z: number } | null {
    // Calculate the exterior tile based on wall direction
    // Wall direction indicates which edge of the tile the wall is on
    // The exterior tile is one step in that direction
    switch (wall.side) {
      case "north":
        return { x: wall.tileX, z: wall.tileZ - 1 };
      case "south":
        return { x: wall.tileX, z: wall.tileZ + 1 };
      case "east":
        return { x: wall.tileX + 1, z: wall.tileZ };
      case "west":
        return { x: wall.tileX - 1, z: wall.tileZ };
      default:
        return null;
    }
  }

  /**
   * Remove building walls from CollisionMatrix
   */
  private unregisterWallsFromCollisionMatrix(
    building: BuildingCollisionData,
  ): void {
    const collision = this.world.collision as CollisionMatrix;
    if (!collision) return;

    // Only ground floor walls are registered in CollisionMatrix
    const groundFloor = building.floors.find((f) => f.floorIndex === 0);
    if (!groundFloor) return;

    for (const wall of groundFloor.wallSegments) {
      if (!wall.hasOpening) {
        const flag = WALL_DIRECTION_TO_FLAG[wall.side];
        if (flag) {
          // Remove interior wall flag
          collision.removeFlags(wall.tileX, wall.tileZ, flag);

          // Also remove the exterior wall flag
          const oppositeFlag =
            WALL_DIRECTION_TO_FLAG[getOppositeDirection(wall.side)];
          if (oppositeFlag) {
            const exteriorTile = this.getExteriorTileForWall(wall);
            if (exteriorTile) {
              collision.removeFlags(
                exteriorTile.x,
                exteriorTile.z,
                oppositeFlag,
              );
            }
          }
        }
      }
    }
  }

  // ============================================================================
  // SPATIAL INDEX
  // ============================================================================

  /**
   * Update spatial index with building tiles
   */
  private updateSpatialIndex(building: BuildingCollisionData): void {
    // Index walkable floor tiles
    for (const floor of building.floors) {
      for (const key of floor.walkableTiles) {
        let buildings = this.tileToBuildings.get(key);
        if (!buildings) {
          buildings = new Set();
          this.tileToBuildings.set(key, buildings);
        }
        buildings.add(building.buildingId);
      }
    }

    for (const key of building.groundCoverageTiles) {
      let buildings = this.tileToBuildingGroundCoverage.get(key);
      if (!buildings) {
        buildings = new Set();
        this.tileToBuildingGroundCoverage.set(key, buildings);
      }
      buildings.add(building.buildingId);
    }

    // PERF: Index bounding box tiles for O(1) containment checks
    const bbox = building.boundingBox;
    for (let tx = bbox.minTileX; tx <= bbox.maxTileX; tx++) {
      for (let tz = bbox.minTileZ; tz <= bbox.maxTileZ; tz++) {
        const key = tileKey(tx, tz);
        this.tileToBuildingBbox.set(key, building.buildingId);
      }
    }

    // Index step tiles
    for (const stepTile of building.stepTiles) {
      const key = tileKey(stepTile.tileX, stepTile.tileZ);
      this.tileToStepTile.set(key, stepTile);
    }
  }

  /**
   * Remove building from spatial index
   */
  private removeSpatialIndex(building: BuildingCollisionData): void {
    // Remove walkable floor tiles
    for (const floor of building.floors) {
      for (const key of floor.walkableTiles) {
        const buildings = this.tileToBuildings.get(key);
        if (buildings) {
          buildings.delete(building.buildingId);
          if (buildings.size === 0) {
            this.tileToBuildings.delete(key);
          }
        }
      }
    }

    for (const key of building.groundCoverageTiles) {
      const buildings = this.tileToBuildingGroundCoverage.get(key);
      if (!buildings) continue;
      buildings.delete(building.buildingId);
      if (buildings.size === 0) {
        this.tileToBuildingGroundCoverage.delete(key);
      }
    }

    // Remove bounding box tiles
    const bbox = building.boundingBox;
    for (let tx = bbox.minTileX; tx <= bbox.maxTileX; tx++) {
      for (let tz = bbox.minTileZ; tz <= bbox.maxTileZ; tz++) {
        const key = tileKey(tx, tz);
        if (this.tileToBuildingBbox.get(key) === building.buildingId) {
          this.tileToBuildingBbox.delete(key);
        }
      }
    }

    // Remove step tiles
    for (const stepTile of building.stepTiles) {
      const key = tileKey(stepTile.tileX, stepTile.tileZ);
      this.tileToStepTile.delete(key);
    }
  }

  // ============================================================================
  // COLLISION QUERIES
  // ============================================================================

  /**
   * Query collision state for a tile at a specific floor
   *
   * @param tileX - World tile X coordinate
   * @param tileZ - World tile Z coordinate
   * @param floorIndex - Floor to check (0 = ground floor)
   * @returns Collision result with walkability and wall data
   */
  queryCollision(
    tileX: number,
    tileZ: number,
    floorIndex: number,
  ): BuildingCollisionResult {
    const key = tileKey(tileX, tileZ);
    let nonWalkableRoofBuildingId: string | null = null;

    // FIRST: Check spatial index for buildings at this tile (walkable tiles)
    const buildingIds = this.tileToBuildings.get(key);
    if (buildingIds && buildingIds.size > 0) {
      // Tile is a walkable building tile
      for (const buildingId of buildingIds) {
        const building = this.buildings.get(buildingId);
        if (!building) continue;

        // Find the floor
        const floor = building.floors.find((f) => f.floorIndex === floorIndex);
        if (!floor) {
          if (building.nonWalkableRoofFloor === floorIndex) {
            nonWalkableRoofBuildingId ??= buildingId;
          }
          continue;
        }

        // Check if tile is walkable on this floor
        const isWalkable = floor.walkableTiles.has(key);

        // Get wall blocking for this tile
        // PERF: use pre-indexed wallsByTile for O(1) lookup instead of scanning all walls
        const wallBlocking = {
          north: false,
          south: false,
          east: false,
          west: false,
        };

        const tileWalls = floor.wallsByTile?.get(key);
        if (tileWalls) {
          for (const wall of tileWalls) {
            if (!wall.hasOpening) {
              wallBlocking[wall.side] = true;
            }
          }
        }

        // Check for stairs
        const stairTile =
          floor.stairTiles.find(
            (s) => s.tileX === tileX && s.tileZ === tileZ,
          ) || null;

        return {
          isInsideBuilding: true,
          buildingId,
          isWalkable,
          floorIndex,
          elevation: floor.elevation,
          wallBlocking,
          stairTile,
        };
      }
    }

    // SECOND: Check the exact ground silhouette. Rectangular bbox holes around
    // irregular footprints are real exterior terrain and must remain walkable.
    const coverageBuildingIds = this.tileToBuildingGroundCoverage.get(key);
    if (coverageBuildingIds) {
      for (const buildingId of coverageBuildingIds) {
        const building = this.buildings.get(buildingId);
        if (!building) continue;
        const floor = building.floors.find((f) => f.floorIndex === floorIndex);
        if (!floor) {
          if (building.nonWalkableRoofFloor === floorIndex) {
            nonWalkableRoofBuildingId ??= buildingId;
          }
          continue;
        }

        // Get wall blocking for this tile (even though tile isn't walkable)
        // PERF: use pre-indexed wallsByTile for O(1) lookup
        const wallBlocking = {
          north: false,
          south: false,
          east: false,
          west: false,
        };

        const tileWalls = floor.wallsByTile?.get(key);
        if (tileWalls) {
          for (const wall of tileWalls) {
            if (!wall.hasOpening) {
              wallBlocking[wall.side] = true;
            }
          }
        }

        // Tile is covered by the building silhouette but is not a floor tile.
        return {
          isInsideBuilding: true,
          buildingId,
          isWalkable: false, // Not a walkable floor tile
          floorIndex,
          elevation: floor.elevation,
          wallBlocking,
          stairTile: null,
        };
      }
    }

    // An explicitly non-walkable roof is not outdoor terrain. Keep its
    // navigation rejection separate from surface/wall data, and allow any
    // overlapping real floor above to take precedence. Other absent floors
    // retain their existing fallback behavior.
    if (nonWalkableRoofBuildingId !== null) {
      return {
        isInsideBuilding: true,
        buildingId: nonWalkableRoofBuildingId,
        isWalkable: false,
        floorIndex,
        elevation: null,
        wallBlocking: { north: false, south: false, east: false, west: false },
        stairTile: null,
      };
    }

    // No matching building found
    return DEFAULT_COLLISION_RESULT;
  }

  /**
   * Check if a tile is walkable at a specific floor
   *
   * This is the main query for pathfinding integration.
   *
   * @param tileX - World tile X coordinate
   * @param tileZ - World tile Z coordinate
   * @param floorIndex - Floor to check
   * @returns true if walkable at this floor
   */
  isWalkableAtFloor(tileX: number, tileZ: number, floorIndex: number): boolean {
    const result = this.queryCollision(tileX, tileZ, floorIndex);
    if (!result.isInsideBuilding) {
      return true; // Defer to terrain collision
    }
    return result.isWalkable;
  }

  /**
   * Get stair destination information for a tile.
   * Used for stair click targeting - when clicking on stairs,
   * resolve the Y position to the destination floor's elevation.
   *
   * @param tileX - World tile X coordinate
   * @param tileZ - World tile Z coordinate
   * @param currentFloor - Player's current floor index
   * @returns Stair destination info, or null if not a stair
   */
  getStairDestination(
    tileX: number,
    tileZ: number,
    currentFloor: number,
  ): { destinationFloor: number; elevation: number } | null {
    const result = this.queryCollision(tileX, tileZ, currentFloor);
    if (!result.isInsideBuilding || !result.stairTile) {
      return null;
    }

    const stair = result.stairTile;
    const destinationFloor = stair.toFloor;

    // Get the building to find the destination floor's elevation
    const building = this.buildings.get(result.buildingId!);
    if (!building) return null;

    const destFloorData = building.floors.find(
      (f) => f.floorIndex === destinationFloor,
    );
    if (!destFloorData) return null;

    return {
      destinationFloor,
      elevation: destFloorData.elevation,
    };
  }

  /**
   * Get the destination tile for stair navigation.
   * When clicking on stairs, this returns the tile at the OTHER end of the stairs
   * so the player walks across them (from bottom to top landing, or vice versa).
   *
   * @param tileX - World tile X coordinate of clicked stair tile
   * @param tileZ - World tile Z coordinate of clicked stair tile
   * @param currentFloor - Player's current floor index
   * @returns Destination tile info (tile coords + elevation), or null if not a stair
   */
  getStairLandingTile(
    tileX: number,
    tileZ: number,
    currentFloor: number,
  ): {
    tileX: number;
    tileZ: number;
    destinationFloor: number;
    elevation: number;
  } | null {
    const result = this.queryCollision(tileX, tileZ, currentFloor);
    if (!result.isInsideBuilding || !result.stairTile) {
      return null;
    }

    const clickedStair = result.stairTile;
    const building = this.buildings.get(result.buildingId!);
    if (!building) return null;

    // Determine which floor has the destination stair tiles
    // If clicked on bottom (isLanding=false), destination is the landing on toFloor
    // If clicked on landing (isLanding=true), destination is the bottom on toFloor
    const destinationFloor = clickedStair.toFloor;
    const destFloorData = building.floors.find(
      (f) => f.floorIndex === destinationFloor,
    );
    if (!destFloorData) return null;

    // Find the corresponding stair tiles on the destination floor
    // They will have the OPPOSITE isLanding value and connect the same two floors
    const destinationStairTiles = destFloorData.stairTiles.filter((stair) => {
      // Must have opposite landing status
      if (stair.isLanding === clickedStair.isLanding) return false;
      // Must connect the same two floors (from/to are swapped for landing vs bottom)
      const clickedFloors = [clickedStair.fromFloor, clickedStair.toFloor].sort(
        (a, b) => a - b,
      );
      const stairFloors = [stair.fromFloor, stair.toFloor].sort(
        (a, b) => a - b,
      );
      return (
        clickedFloors[0] === stairFloors[0] &&
        clickedFloors[1] === stairFloors[1]
      );
    });

    if (destinationStairTiles.length === 0) {
      return null;
    }

    // Calculate the center of the destination stair area
    // Stair tiles form a 4x4 grid; find the average position
    let sumX = 0;
    let sumZ = 0;
    for (const tile of destinationStairTiles) {
      sumX += tile.tileX;
      sumZ += tile.tileZ;
    }
    const centerTileX = Math.round(sumX / destinationStairTiles.length);
    const centerTileZ = Math.round(sumZ / destinationStairTiles.length);

    return {
      tileX: centerTileX,
      tileZ: centerTileZ,
      destinationFloor,
      elevation: destFloorData.elevation,
    };
  }

  /**
   * Get the interpolated stair elevation based on world position.
   * When on stairs, the Y position should gradually change from
   * the bottom floor elevation to the top floor elevation.
   *
   * @param worldX - World X coordinate
   * @param worldZ - World Z coordinate
   * @param currentFloor - Player's current floor index
   * @returns Interpolated elevation, or null if not on stairs
   */
  getStairElevation(
    worldX: number,
    worldZ: number,
    currentFloor: number,
  ): number | null {
    const tileX = Math.floor(worldX);
    const tileZ = Math.floor(worldZ);

    const result = this.queryCollision(tileX, tileZ, currentFloor);
    if (!result.isInsideBuilding || !result.stairTile) {
      return null;
    }

    const stair = result.stairTile;
    const building = this.buildings.get(result.buildingId!);
    if (!building) return null;

    // Get elevations for both floors
    const bottomFloor = Math.min(stair.fromFloor, stair.toFloor);
    const topFloor = Math.max(stair.fromFloor, stair.toFloor);

    const bottomFloorData = building.floors.find(
      (f) => f.floorIndex === bottomFloor,
    );
    const topFloorData = building.floors.find((f) => f.floorIndex === topFloor);

    if (!bottomFloorData || !topFloorData) return null;

    const bottomElevation = bottomFloorData.elevation;
    const topElevation = topFloorData.elevation;

    // Calculate progress along the stair based on direction
    // The stair direction tells us which axis to use for interpolation
    let progress = 0.5; // Default to middle

    // Get fractional position within tile
    const fracX = worldX - tileX;
    const fracZ = worldZ - tileZ;

    // Calculate progress based on stair direction
    switch (stair.direction) {
      case "north":
        // Going north = Z increases = progress increases
        progress = stair.isLanding ? 1 - fracZ : fracZ;
        break;
      case "south":
        // Going south = Z decreases = progress from 1 to 0
        progress = stair.isLanding ? fracZ : 1 - fracZ;
        break;
      case "east":
        // Going east = X increases
        progress = stair.isLanding ? 1 - fracX : fracX;
        break;
      case "west":
        // Going west = X decreases
        progress = stair.isLanding ? fracX : 1 - fracX;
        break;
    }

    // Clamp progress to [0, 1]
    progress = Math.max(0, Math.min(1, progress));

    // Interpolate between bottom and top elevation
    return bottomElevation + progress * (topElevation - bottomElevation);
  }

  /**
   * Check if movement is blocked by a wall
   *
   * @param fromX - Source tile X
   * @param fromZ - Source tile Z
   * @param toX - Destination tile X
   * @param toZ - Destination tile Z
   * @param floorIndex - Current floor
   * @returns true if movement is blocked by a wall
   */
  isWallBlocked(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    floorIndex: number,
  ): boolean {
    const dx = toX - fromX;
    const dz = toZ - fromZ;

    // Determine movement direction
    // exitDir = which edge of SOURCE tile we're crossing (wall we need to exit through)
    // entryDir = which edge of DEST tile we're entering (wall we need to enter through)
    //
    // Coordinate system: North = -Z, South = +Z, East = +X, West = -X
    // Moving from z to z+1 = moving SOUTH = exit through SOUTH edge, enter through NORTH edge
    let exitDir: WallDirection | null = null;
    let entryDir: WallDirection | null = null;

    if (dx === 0 && dz === 1) {
      // Moving south (increasing Z)
      exitDir = "south"; // Exit through south edge of source
      entryDir = "north"; // Enter through north edge of dest
    } else if (dx === 0 && dz === -1) {
      // Moving north (decreasing Z)
      exitDir = "north"; // Exit through north edge of source
      entryDir = "south"; // Enter through south edge of dest
    } else if (dx === 1 && dz === 0) {
      // Moving east (increasing X)
      exitDir = "east"; // Exit through east edge of source
      entryDir = "west"; // Enter through west edge of dest
    } else if (dx === -1 && dz === 0) {
      // Moving west (decreasing X)
      exitDir = "west"; // Exit through west edge of source
      entryDir = "east"; // Enter through east edge of dest
    }

    if (!exitDir || !entryDir) {
      // Diagonal movement - check if destination tile has walls blocking entry
      // For building entry especially, we need to block diagonal clipping through corners

      if (Math.abs(dx) === 1 && Math.abs(dz) === 1) {
        // Get collision info for destination tile
        const toResult = this.queryCollision(toX, toZ, floorIndex);

        // If destination is inside a building, check wall blocking more strictly
        if (toResult.isInsideBuilding) {
          // Determine the two cardinal entry edges for this diagonal movement
          // When moving diagonally into a tile, we enter through two edges
          // dx > 0 (moving east) = enter through WEST edge of dest tile
          // dz > 0 (moving south) = enter through NORTH edge of dest tile
          const horizontalEntry: WallDirection = dx > 0 ? "west" : "east";
          const verticalEntry: WallDirection = dz > 0 ? "north" : "south";

          // If destination has a wall blocking EITHER entry direction, block the diagonal
          // This prevents corner clipping where one wall exists but the other doesn't
          if (
            toResult.wallBlocking[horizontalEntry] ||
            toResult.wallBlocking[verticalEntry]
          ) {
            if (this._debugLogging) {
              console.log(
                `[isWallBlocked] BLOCKED diagonal into building: (${fromX},${fromZ}) → (${toX},${toZ}) | ` +
                  `walls: ${horizontalEntry}=${toResult.wallBlocking[horizontalEntry]}, ${verticalEntry}=${toResult.wallBlocking[verticalEntry]}`,
              );
            }
            return true;
          }

          // Also check if source is OUTSIDE building - diagonal entry should go through door
          const fromResult = this.queryCollision(fromX, fromZ, floorIndex);
          if (!fromResult.isInsideBuilding) {
            // Entering building diagonally from outside - check intermediate tiles
            const intermediateH = { x: fromX + dx, z: fromZ };
            const intermediateV = { x: fromX, z: fromZ + dz };

            // If EITHER intermediate tile is NOT walkable (blocked by building), block diagonal
            const intermediateHWalkable = this.isTileWalkableInBuilding(
              intermediateH.x,
              intermediateH.z,
              floorIndex,
            );
            const intermediateVWalkable = this.isTileWalkableInBuilding(
              intermediateV.x,
              intermediateV.z,
              floorIndex,
            );

            if (!intermediateHWalkable || !intermediateVWalkable) {
              if (this._debugLogging) {
                console.log(
                  `[isWallBlocked] BLOCKED diagonal entry from outside: (${fromX},${fromZ}) → (${toX},${toZ}) | ` +
                    `intermediate walkable: H=${intermediateHWalkable}, V=${intermediateVWalkable}`,
                );
              }
              return true;
            }
          }
        }

        // For non-building tiles or interior movement, check both cardinal paths
        const intermediateH = { x: fromX + dx, z: fromZ };
        const intermediateV = { x: fromX, z: fromZ + dz };

        const path1Blocked =
          this.isWallBlocked(
            fromX,
            fromZ,
            intermediateH.x,
            intermediateH.z,
            floorIndex,
          ) ||
          this.isWallBlocked(
            intermediateH.x,
            intermediateH.z,
            toX,
            toZ,
            floorIndex,
          );

        const path2Blocked =
          this.isWallBlocked(
            fromX,
            fromZ,
            intermediateV.x,
            intermediateV.z,
            floorIndex,
          ) ||
          this.isWallBlocked(
            intermediateV.x,
            intermediateV.z,
            toX,
            toZ,
            floorIndex,
          );

        // Standard classic MMORPG rule: blocked only if BOTH cardinal paths are blocked
        if (path1Blocked && path2Blocked) {
          if (this._debugLogging) {
            console.log(
              `[isWallBlocked] BLOCKED diagonal: (${fromX},${fromZ}) → (${toX},${toZ}) | both paths blocked`,
            );
          }
          return true;
        }
      }

      return false;
    }

    // Check source tile for exit wall
    const fromResult = this.queryCollision(fromX, fromZ, floorIndex);
    if (fromResult.wallBlocking[exitDir]) {
      if (this._debugLogging) {
        console.log(
          `[isWallBlocked] BLOCKED: exit from (${fromX},${fromZ}) dir=${exitDir} | building=${fromResult.buildingId}`,
        );
      }
      return true;
    }

    // Check destination tile for entry wall
    const toResult = this.queryCollision(toX, toZ, floorIndex);
    if (toResult.wallBlocking[entryDir]) {
      if (this._debugLogging) {
        console.log(
          `[isWallBlocked] BLOCKED: entry to (${toX},${toZ}) dir=${entryDir} | building=${toResult.buildingId}`,
        );
      }
      return true;
    }

    return false;
  }

  /**
   * Check if movement onto a step tile from the side is blocked
   *
   * Steps can only be walked onto from the approach direction (front of building)
   * or from deeper into the steps (toward/away from building).
   * Walking onto steps from the perpendicular side is blocked.
   *
   * @param fromX - Source tile X
   * @param fromZ - Source tile Z
   * @param toX - Destination tile X
   * @param toZ - Destination tile Z
   * @returns true if movement is blocked by step directional restriction
   */
  isStepBlocked(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
  ): boolean {
    const toKey = tileKey(toX, toZ);
    const stepTile = this.tileToStepTile.get(toKey);

    if (!stepTile) {
      // Destination is not a step tile - not blocked by steps
      return false;
    }

    // CRITICAL: Allow ANY approach direction to door exterior tiles.
    // Door exterior tiles are where players enter buildings, and they need
    // to be reachable from any direction for pathfinding to work correctly.
    // Without this, players approaching from the side of a building would be blocked.
    const building = this.buildings.get(stepTile.buildingId);
    if (building) {
      const groundFloor = building.floors.find((f) => f.floorIndex === 0);
      if (groundFloor) {
        const doorWalls =
          BuildingCollisionService.getDoorWallSegments(groundFloor);
        for (const wall of doorWalls) {
          const doorTiles = BuildingCollisionService.getDoorExteriorAndInterior(
            wall.tileX,
            wall.tileZ,
            wall.side,
          );
          if (doorTiles.exteriorX === toX && doorTiles.exteriorZ === toZ) {
            // This is a door exterior tile - allow any approach direction
            if (this._debugLogging) {
              console.log(
                `[isStepBlocked] ALLOWED: door exterior tile (${toX},${toZ}) for ${stepTile.buildingId}`,
              );
            }
            return false;
          }
        }
      }
    }

    // Calculate movement direction
    const dx = toX - fromX;
    const dz = toZ - fromZ;

    // Determine the approach direction vector based on step's approach direction
    // The step's approachDirection points AWAY from the building (outward)
    let approachDx = 0;
    let approachDz = 0;
    switch (stepTile.approachDirection) {
      case "north":
        approachDz = -1;
        break; // Steps go north from building
      case "south":
        approachDz = 1;
        break; // Steps go south from building
      case "east":
        approachDx = 1;
        break; // Steps go east from building
      case "west":
        approachDx = -1;
        break; // Steps go west from building
    }

    // Valid movement directions:
    // 1. Along the approach axis (toward or away from building)
    // 2. From adjacent step tiles (already on the steps)

    // If source tile is also a step tile, allow movement (already on steps)
    const fromKey = tileKey(fromX, fromZ);
    const fromStepTile = this.tileToStepTile.get(fromKey);
    if (fromStepTile) {
      return false; // Already on steps, allow any movement
    }

    // Movement must be along the approach axis (toward or away from building)
    // That means dx/dz should align with approachDx/approachDz
    const isAlongApproachAxis =
      (dx !== 0 && dx === approachDx * Math.abs(dx) && dz === 0) ||
      (dz !== 0 && dz === approachDz * Math.abs(dz) && dx === 0) ||
      (dx === -approachDx && dz === 0) || // Coming from deeper in steps
      (dz === -approachDz && dx === 0); // Coming from deeper in steps

    // Diagonal movement - check if it's mostly along approach axis
    const isDiagonalAlongApproach =
      Math.abs(dx) === 1 &&
      Math.abs(dz) === 1 &&
      (dx === approachDx || dx === -approachDx || approachDx === 0) &&
      (dz === approachDz || dz === -approachDz || approachDz === 0);

    if (!isAlongApproachAxis && !isDiagonalAlongApproach) {
      if (this._debugLogging) {
        console.log(
          `[isStepBlocked] BLOCKED side approach to step: (${fromX},${fromZ}) → (${toX},${toZ}) | ` +
            `step approach=${stepTile.approachDirection}, movement=(${dx},${dz})`,
        );
      }
      return true;
    }

    return false;
  }

  /**
   * Check if a tile is a step tile
   */
  isStepTile(tileX: number, tileZ: number): boolean {
    const key = tileKey(tileX, tileZ);
    return this.tileToStepTile.has(key);
  }

  /**
   * Get step tile data for a position
   */
  getStepTile(tileX: number, tileZ: number): StepTile | null {
    const key = tileKey(tileX, tileZ);
    return this.tileToStepTile.get(key) ?? null;
  }

  /**
   * Get the world Y position for a step tile
   *
   * Returns the correct elevation for a player standing on entrance steps.
   * This enables smooth walking up/down stairs.
   *
   * @param tileX - World tile X coordinate
   * @param tileZ - World tile Z coordinate
   * @returns World Y position for the step, or null if not a step tile
   */
  getStepHeight(tileX: number, tileZ: number): number | null {
    const stepTile = this.getStepTile(tileX, tileZ);
    if (!stepTile) return null;

    // World Y = terrain height + step height above terrain
    return stepTile.terrainHeight + stepTile.stepHeight;
  }

  /**
   * Get the step height at a world position (sub-tile precision)
   *
   * Interpolates between step tiles for smooth height transitions.
   * Used by client-side movement for smooth stepping animations.
   *
   * @param worldX - World X coordinate
   * @param worldZ - World Z coordinate
   * @returns World Y position for the step, or null if not on steps
   */
  getStepHeightAtWorld(worldX: number, worldZ: number): number | null {
    const tileX = Math.floor(worldX);
    const tileZ = Math.floor(worldZ);

    const stepTile = this.getStepTile(tileX, tileZ);
    if (!stepTile) return null;

    // For smooth movement, interpolate based on position within tile
    // and neighboring step tiles
    const fracX = worldX - tileX;
    const fracZ = worldZ - tileZ;

    // Get neighboring step tiles for interpolation
    let height = stepTile.terrainHeight + stepTile.stepHeight;

    // Determine approach axis based on step direction
    const isNorthSouth =
      stepTile.approachDirection === "north" ||
      stepTile.approachDirection === "south";

    if (isNorthSouth) {
      // North/South steps - interpolate along Z axis
      const nextZ =
        stepTile.approachDirection === "north" ? tileZ - 1 : tileZ + 1;
      const prevZ =
        stepTile.approachDirection === "north" ? tileZ + 1 : tileZ - 1;

      const nextStep = this.getStepTile(tileX, nextZ);
      const prevStep = this.getStepTile(tileX, prevZ);

      // Interpolate toward next/prev step based on Z fraction
      if (stepTile.approachDirection === "north") {
        // Moving north (decreasing Z) goes up the steps
        if (fracZ < 0.5 && nextStep) {
          const t = 0.5 - fracZ;
          const nextHeight = nextStep.terrainHeight + nextStep.stepHeight;
          height = height + (nextHeight - height) * t;
        } else if (fracZ > 0.5 && prevStep) {
          const t = fracZ - 0.5;
          const prevHeight = prevStep.terrainHeight + prevStep.stepHeight;
          height = height + (prevHeight - height) * t;
        }
      } else {
        // Moving south (increasing Z) goes up the steps
        if (fracZ > 0.5 && nextStep) {
          const t = fracZ - 0.5;
          const nextHeight = nextStep.terrainHeight + nextStep.stepHeight;
          height = height + (nextHeight - height) * t;
        } else if (fracZ < 0.5 && prevStep) {
          const t = 0.5 - fracZ;
          const prevHeight = prevStep.terrainHeight + prevStep.stepHeight;
          height = height + (prevHeight - height) * t;
        }
      }
    } else {
      // East/West steps - interpolate along X axis
      const nextX =
        stepTile.approachDirection === "east" ? tileX + 1 : tileX - 1;
      const prevX =
        stepTile.approachDirection === "east" ? tileX - 1 : tileX + 1;

      const nextStep = this.getStepTile(nextX, tileZ);
      const prevStep = this.getStepTile(prevX, tileZ);

      // Interpolate toward next/prev step based on X fraction
      if (stepTile.approachDirection === "east") {
        // Moving east (increasing X) goes up the steps
        if (fracX > 0.5 && nextStep) {
          const t = fracX - 0.5;
          const nextHeight = nextStep.terrainHeight + nextStep.stepHeight;
          height = height + (nextHeight - height) * t;
        } else if (fracX < 0.5 && prevStep) {
          const t = 0.5 - fracX;
          const prevHeight = prevStep.terrainHeight + prevStep.stepHeight;
          height = height + (prevHeight - height) * t;
        }
      } else {
        // Moving west (decreasing X) goes up the steps
        if (fracX < 0.5 && nextStep) {
          const t = 0.5 - fracX;
          const nextHeight = nextStep.terrainHeight + nextStep.stepHeight;
          height = height + (nextHeight - height) * t;
        } else if (fracX > 0.5 && prevStep) {
          const t = fracX - 0.5;
          const prevHeight = prevStep.terrainHeight + prevStep.stepHeight;
          height = height + (prevHeight - height) * t;
        }
      }
    }

    return height;
  }

  /**
   * Get the floor elevation at a tile position
   *
   * @param tileX - World tile X coordinate
   * @param tileZ - World tile Z coordinate
   * @param floorIndex - Floor to check
   * @returns Elevation in world Y units, or null if not in building
   */
  getFloorElevation(
    tileX: number,
    tileZ: number,
    floorIndex: number,
  ): number | null {
    const result = this.queryCollision(tileX, tileZ, floorIndex);
    return result.elevation;
  }

  /**
   * Find which building (if any) contains a tile (by walkable tiles)
   */
  getBuildingAtTile(tileX: number, tileZ: number): string | null {
    const key = tileKey(tileX, tileZ);
    const buildingIds = this.tileToBuildings.get(key);
    if (!buildingIds || buildingIds.size === 0) return null;
    return buildingIds.values().next().value ?? null;
  }

  /**
   * Check if a tile is within any building's actual walkable footprint.
   * Only returns true if the tile is a registered walkable tile in the building.
   *
   * This is used to determine if a tile is "inside" a building for collision purposes.
   * Tiles just outside the building (e.g., in front of doors) should NOT be considered
   * inside the building, even if they're within the bounding box.
   *
   * @returns The building ID if tile is a walkable building tile, null otherwise
   */
  isTileInBuildingFootprint(tileX: number, tileZ: number): string | null {
    // Use the spatial index - only walkable tiles are indexed
    const key = tileKey(tileX, tileZ);
    const buildingIds = this.tileToBuildings.get(key);
    if (buildingIds && buildingIds.size > 0) {
      return buildingIds.values().next().value ?? null;
    }
    return null;
  }

  /**
   * Get door/arch openings at a tile (for debug visualization).
   * Returns array of directions where there are openings (doors/arches).
   *
   * @param tileX - World tile X coordinate
   * @param tileZ - World tile Z coordinate
   * @param floorIndex - Floor to check
   * @returns Array of directions with openings (e.g., ["south", "east"])
   */
  getDoorOpeningsAtTile(
    tileX: number,
    tileZ: number,
    floorIndex: number,
  ): Array<"north" | "south" | "east" | "west"> {
    const buildingId = this.getBuildingAtTile(tileX, tileZ);
    if (!buildingId) return [];

    const building = this.buildings.get(buildingId);
    if (!building) return [];

    const floor = building.floors.find((f) => f.floorIndex === floorIndex);
    if (!floor) return [];

    const openings: Array<"north" | "south" | "east" | "west"> = [];
    for (const wall of floor.wallSegments) {
      if (wall.tileX === tileX && wall.tileZ === tileZ && wall.hasOpening) {
        openings.push(wall.side as "north" | "south" | "east" | "west");
      }
    }
    return openings;
  }

  /**
   * Check if a tile is within any building's SHRUNK bounding box.
   * The bbox is shrunk by 1 tile on all sides to allow approach areas near doors.
   *
   * Use this for blocking movement on terrain UNDER buildings.
   *
   * @returns The building ID if tile is in shrunk bounding box, null otherwise
   */
  isTileInBuildingShrunkBoundingBox(
    tileX: number,
    tileZ: number,
  ): string | null {
    // PERF: first check O(1) bbox index, then verify margin
    const key = tileKey(tileX, tileZ);
    const buildingId = this.tileToBuildingBbox.get(key);
    if (!buildingId) return null;

    const building = this.buildings.get(buildingId);
    if (!building) return null;

    const margin = 1; // Shrink by 1 tile on each side for approach areas
    const { minTileX, maxTileX, minTileZ, maxTileZ } = building.boundingBox;
    if (
      tileX > minTileX + margin &&
      tileX < maxTileX - margin &&
      tileZ > minTileZ + margin &&
      tileZ < maxTileZ - margin
    ) {
      return buildingId;
    }
    return null;
  }

  /**
   * Check if a tile is within any building's bounding box.
   * This includes ALL tiles in the rectangular area, not just walkable ones.
   *
   * Use this for Y-elevation calculations where we want to use building floor
   * height even for tiles near doors.
   *
   * @returns The building ID if tile is in bounding box, null otherwise
   */
  isTileInBuildingBoundingBox(tileX: number, tileZ: number): string | null {
    // PERF: O(1) lookup via spatial index instead of iterating all buildings
    const key = tileKey(tileX, tileZ);
    return this.tileToBuildingBbox.get(key) ?? null;
  }

  /** Return the building whose exact ground silhouette covers this tile. */
  isTileInBuildingGroundCoverage(tileX: number, tileZ: number): string | null {
    const buildingIds = this.tileToBuildingGroundCoverage.get(
      tileKey(tileX, tileZ),
    );
    return buildingIds?.values().next().value ?? null;
  }

  /**
   * Check if a world position is near any building (for Y-elevation purposes).
   * Uses the bounding box which includes door approach areas.
   *
   * This is used by client-side TileInterpolator to decide whether to use
   * server-confirmed Y (building floor) or terrain height.
   *
   * @param worldX - World X coordinate
   * @param worldZ - World Z coordinate
   * @returns true if near a building (should use server Y for elevation)
   */
  isNearBuildingForElevation(worldX: number, worldZ: number): boolean {
    const tileX = Math.floor(worldX);
    const tileZ = Math.floor(worldZ);
    // Use bounding box check - includes approach areas
    return this.isTileInBuildingBoundingBox(tileX, tileZ) !== null;
  }

  /**
   * Get the world elevation at a position, considering buildings and terrain.
   *
   * Priority:
   * 1. If position is in a building's bounding box -> return building floor elevation
   * 2. Otherwise -> return terrain height (via callback)
   *
   * This is the single source of truth for Y positioning on both client and server.
   *
   * @param worldX - World X coordinate (not tile)
   * @param worldZ - World Z coordinate (not tile)
   * @param floorIndex - Current floor level (0 for ground)
   * @param getTerrainHeight - Callback to get terrain height at position
   * @returns Elevation in world Y units
   */
  getWorldElevation(
    worldX: number,
    worldZ: number,
    floorIndex: number,
    getTerrainHeight: (x: number, z: number) => number | null,
  ): number {
    // Convert world coords to tile coords
    const tileX = Math.floor(worldX);
    const tileZ = Math.floor(worldZ);

    // Check if in or near a building (use bounding box for elevation)
    const buildingId = this.isTileInBuildingBoundingBox(tileX, tileZ);
    if (buildingId) {
      const floorElevation = this.getFloorElevation(tileX, tileZ, floorIndex);
      if (floorElevation !== null && Number.isFinite(floorElevation)) {
        return floorElevation;
      }
      // If no floor elevation available, get from the building's ground floor
      const building = this.buildings.get(buildingId);
      if (building && building.floors.length > 0) {
        return building.floors[0].elevation;
      }
    }

    // Fall back to terrain height
    const terrainHeight = getTerrainHeight(worldX, worldZ);
    return terrainHeight !== null && Number.isFinite(terrainHeight)
      ? terrainHeight
      : 0;
  }

  /**
   * Check if a world position is inside any building's walkable footprint.
   * This checks if the position is on an actual walkable floor tile.
   *
   * NOTE: For Y-elevation purposes (preserving server Y), use isNearBuildingForElevation()
   * which includes door approach areas via bounding box.
   *
   * @param worldX - World X coordinate
   * @param worldZ - World Z coordinate
   * @returns true if on a walkable building floor tile
   */
  isInBuildingFootprint(worldX: number, worldZ: number): boolean {
    const tileX = Math.floor(worldX);
    const tileZ = Math.floor(worldZ);
    return this.isTileInBuildingFootprint(tileX, tileZ) !== null;
  }

  /**
   * Check if a tile is inside any building on ANY floor.
   * Used for detecting clicks inside multi-story buildings regardless of which floor.
   *
   * @param tileX - World tile X coordinate
   * @param tileZ - World tile Z coordinate
   * @returns Object with buildingId and floorIndex if inside, null otherwise
   */
  isTileInBuildingAnyFloor(
    tileX: number,
    tileZ: number,
  ): { buildingId: string; floorIndex: number } | null {
    // Validate inputs
    if (!Number.isFinite(tileX) || !Number.isFinite(tileZ)) {
      throw new Error(
        `[BuildingCollision] isTileInBuildingAnyFloor called with invalid coords: (${tileX}, ${tileZ})`,
      );
    }

    const key = tileKey(tileX, tileZ);

    // Check spatial index - this includes tiles from ALL floors
    const buildingIds = this.tileToBuildings.get(key);
    if (!buildingIds || buildingIds.size === 0) {
      return null;
    }

    // Find which building and floor this tile belongs to
    for (const buildingId of buildingIds) {
      const building = this.buildings.get(buildingId);
      if (!building) continue;

      // Check each floor to find which one has this tile
      for (const floor of building.floors) {
        if (floor.walkableTiles.has(key)) {
          return { buildingId, floorIndex: floor.floorIndex };
        }
      }
    }

    return null;
  }

  /**
   * Check if a tile can be walked on considering building collision.
   *
   * Rules:
   * 1. If tile is a registered walkable floor tile on the current floor -> allow
   * 2. If tile is a registered building tile but NOT on current floor -> block
   * 3. If tile is in a building's bounding box but NOT walkable -> BLOCK (under walls)
   * 4. If tile is completely outside all buildings -> allow (terrain rules apply)
   *
   * This ensures players can ONLY enter buildings through doorways, not through walls.
   *
   * @param tileX - World tile X coordinate
   * @param tileZ - World tile Z coordinate
   * @param floorIndex - Current floor level
   * @returns true if walkable, false if blocked by building
   */
  isTileWalkableInBuilding(
    tileX: number,
    tileZ: number,
    floorIndex: number,
  ): boolean {
    // Validate inputs are finite integers
    if (!Number.isFinite(tileX) || !Number.isFinite(tileZ)) {
      throw new Error(
        `[BuildingCollision] isTileWalkableInBuilding called with invalid coords: (${tileX}, ${tileZ})`,
      );
    }
    if (!Number.isFinite(floorIndex) || floorIndex < 0) {
      throw new Error(
        `[BuildingCollision] isTileWalkableInBuilding called with invalid floorIndex: ${floorIndex}`,
      );
    }

    const key = tileKey(tileX, tileZ);

    // Check if this tile is registered as a walkable building tile
    const buildingIds = this.tileToBuildings.get(key);
    if (buildingIds && buildingIds.size > 0) {
      // Tile IS a registered walkable building tile - check floor access
      const buildingId = buildingIds.values().next().value as
        string | undefined;
      if (!buildingId) return true;

      const building = this.buildings.get(buildingId);
      if (!building) return true;

      const floor = building.floors.find((f) => f.floorIndex === floorIndex);
      if (!floor) {
        // Building exists but no floor at player's level - block
        if (this._debugLogging) {
          console.log(
            `[isTileWalkableInBuilding] BLOCKED: tile (${tileX},${tileZ}) in ${buildingId} but no floor ${floorIndex}`,
          );
        }
        return false;
      }

      // Check if this specific tile is walkable on this floor
      if (!floor.walkableTiles.has(key)) {
        // Tile exists on different floor but not this one
        if (this._debugLogging) {
          console.log(
            `[isTileWalkableInBuilding] BLOCKED: tile (${tileX},${tileZ}) in ${buildingId} floor ${floorIndex} not walkable`,
          );
        }
        return false;
      }

      // Tile is walkable on this floor
      // Check if blocked by furniture/props (upper-floor support)
      if (floor.blockedTiles && floor.blockedTiles.has(key)) {
        if (this._debugLogging) {
          console.log(
            `[isTileWalkableInBuilding] BLOCKED: tile (${tileX},${tileZ}) in ${buildingId} floor ${floorIndex} has furniture`,
          );
        }
        return false;
      }

      // Tile is walkable on this floor
      return true;
    }

    // Tile is NOT a registered floor tile. Block only the exact building
    // silhouette; exterior concavities inside the rectangular bbox are terrain.
    const coverageBuildingId = this.isTileInBuildingGroundCoverage(
      tileX,
      tileZ,
    );
    if (coverageBuildingId) {
      // Tile is covered by the building but is not a walkable floor tile.
      // HOWEVER: We must ALLOW entrance exterior approach tiles!
      // Use getEntranceWallSegments to include BOTH doors AND arches
      // This matches findClosestDoorTile which also uses entrance segments
      const groundFloor = this.getGroundFloor(coverageBuildingId);
      if (groundFloor) {
        // Check if this tile is adjacent to any entrance (doors OR arches)
        const entranceWalls =
          BuildingCollisionService.getEntranceWallSegments(groundFloor);
        for (const wall of entranceWalls) {
          const entranceTiles =
            BuildingCollisionService.getDoorExteriorAndInterior(
              wall.tileX,
              wall.tileZ,
              wall.side,
            );

          if (
            entranceTiles.exteriorX === tileX &&
            entranceTiles.exteriorZ === tileZ
          ) {
            // This IS an entrance exterior tile - ALLOW it!
            if (this._debugLogging) {
              console.log(
                `[isTileWalkableInBuilding] ALLOWED: tile (${tileX},${tileZ}) is entrance exterior for ${coverageBuildingId}`,
              );
            }
            return true;
          }
        }
      }

      // Not a door exterior - block it
      if (this._debugLogging) {
        console.log(
          `[isTileWalkableInBuilding] BLOCKED: tile (${tileX},${tileZ}) is covered by ${coverageBuildingId} but has no floor`,
        );
      }
      return false;
    }

    // Tile is outside buildings or in the approach margin - allow
    // Wall blocking will handle preventing entry through actual walls
    return true;
  }

  /**
   * Count how many adjacent tiles are walkable building tiles.
   * Used to determine if a non-walkable tile is under an interior wall (2+ adjacent)
   * or in an exterior/approach area (0-1 adjacent).
   *
   * - 0 adjacent: Far exterior, not near building
   * - 1 adjacent: Door approach or along exterior wall
   * - 2+ adjacent: Interior wall between rooms or corridors
   */
  private countAdjacentWalkableTiles(
    tileX: number,
    tileZ: number,
    floorIndex: number,
  ): number {
    const adjacentOffsets = [
      { dx: 0, dz: 1 }, // north
      { dx: 0, dz: -1 }, // south
      { dx: 1, dz: 0 }, // east
      { dx: -1, dz: 0 }, // west
    ];

    let count = 0;
    for (const { dx, dz } of adjacentOffsets) {
      const adjX = tileX + dx;
      const adjZ = tileZ + dz;
      const adjKey = tileKey(adjX, adjZ);
      const buildingIds = this.tileToBuildings.get(adjKey);
      if (buildingIds && buildingIds.size > 0) {
        // Check if adjacent tile is walkable on this floor
        const buildingId = buildingIds.values().next().value as
          string | undefined;
        if (buildingId) {
          const building = this.buildings.get(buildingId);
          if (building) {
            const floor = building.floors.find(
              (f) => f.floorIndex === floorIndex,
            );
            if (floor && floor.walkableTiles.has(adjKey)) {
              count++;
            }
          }
        }
      }
    }
    return count;
  }

  // ============================================================================
  // PLAYER FLOOR TRACKING
  // ============================================================================

  /**
   * Get or create player building state
   */
  getPlayerBuildingState(entityId: EntityID): PlayerBuildingState {
    let state = this.playerFloorStates.get(entityId);
    if (!state) {
      state = {
        insideBuildingId: null,
        currentFloor: 0,
        onStairs: false,
        stairData: null,
      };
      this.playerFloorStates.set(entityId, state);
    }
    return state;
  }

  /**
   * Update player's building state based on their current tile
   *
   * Call this when player moves to update their floor tracking.
   *
   * @param entityId - Player entity ID
   * @param tileX - Current tile X
   * @param tileZ - Current tile Z
   * @param worldY - Current world Y position (for floor detection)
   */
  updatePlayerBuildingState(
    entityId: EntityID,
    tileX: number,
    tileZ: number,
    worldY: number,
  ): void {
    const state = this.getPlayerBuildingState(entityId);
    const key = tileKey(tileX, tileZ);

    // Check if player is in a building
    const buildingIds = this.tileToBuildings.get(key);
    if (!buildingIds || buildingIds.size === 0) {
      // Player left building
      state.insideBuildingId = null;
      state.currentFloor = 0;
      state.onStairs = false;
      state.stairData = null;
      return;
    }

    const buildingId = buildingIds.values().next().value;
    if (!buildingId) return;

    const building = this.buildings.get(buildingId);
    if (!building) return;

    state.insideBuildingId = buildingId;

    // Find which floor the player is on based on elevation
    let bestFloor = 0;
    let bestElevationDiff = Infinity;

    for (const floor of building.floors) {
      if (!floor.walkableTiles.has(key)) continue;

      const diff = Math.abs(worldY - floor.elevation);
      if (diff < bestElevationDiff) {
        bestElevationDiff = diff;
        bestFloor = floor.floorIndex;
      }
    }

    state.currentFloor = bestFloor;

    // Check if on stairs
    const floor = building.floors.find((f) => f.floorIndex === bestFloor);
    if (floor) {
      const stair = floor.stairTiles.find(
        (s) => s.tileX === tileX && s.tileZ === tileZ,
      );
      state.onStairs = !!stair;
      state.stairData = stair || null;
    } else {
      state.onStairs = false;
      state.stairData = null;
    }
  }

  /**
   * Handle stair transition when player moves between stair tiles
   *
   * @param entityId - Player entity ID
   * @param fromTile - Previous tile
   * @param toTile - New tile
   * @returns New floor index if floor changed, null otherwise
   */
  handleStairTransition(
    entityId: EntityID,
    fromTile: TileCoord,
    toTile: TileCoord,
  ): number | null {
    const state = this.getPlayerBuildingState(entityId);
    if (!state.insideBuildingId) return null;

    const building = this.buildings.get(state.insideBuildingId);
    if (!building) return null;

    const floor = building.floors.find(
      (f) => f.floorIndex === state.currentFloor,
    );
    if (!floor) return null;

    // Check if moving onto a stair tile
    for (const stair of floor.stairTiles) {
      if (stair.tileX === toTile.x && stair.tileZ === toTile.z) {
        // Player stepped onto stair tile
        if (stair.isLanding && stair.fromFloor !== state.currentFloor) {
          // Arrived at landing from below/above
          state.currentFloor = stair.fromFloor;
          return stair.fromFloor;
        } else if (!stair.isLanding) {
          // Starting to climb stairs
          // Don't change floor yet - they need to reach the landing
          state.onStairs = true;
          state.stairData = stair;
        }
      }
    }

    // Check adjacent floor for arrival at landing
    const nextFloor = building.floors.find(
      (f) => f.floorIndex === state.currentFloor + 1,
    );
    if (nextFloor) {
      for (const stair of nextFloor.stairTiles) {
        if (
          stair.tileX === toTile.x &&
          stair.tileZ === toTile.z &&
          stair.isLanding
        ) {
          // Arrived at upper floor landing
          state.currentFloor = nextFloor.floorIndex;
          state.onStairs = false;
          state.stairData = null;
          return nextFloor.floorIndex;
        }
      }
    }

    // Check floor below for descending
    const prevFloor = building.floors.find(
      (f) => f.floorIndex === state.currentFloor - 1,
    );
    if (prevFloor) {
      for (const stair of prevFloor.stairTiles) {
        if (
          stair.tileX === toTile.x &&
          stair.tileZ === toTile.z &&
          !stair.isLanding
        ) {
          // Arrived at lower floor stair base
          state.currentFloor = prevFloor.floorIndex;
          state.onStairs = false;
          state.stairData = null;
          return prevFloor.floorIndex;
        }
      }
    }

    return null;
  }

  /**
   * Remove player state (on disconnect/despawn)
   */
  removePlayerState(entityId: EntityID): void {
    this.playerFloorStates.delete(entityId);
  }

  // =========================================================================
  // FLOOR FURNITURE BLOCKING
  // =========================================================================

  /**
   * Block a tile on a specific floor (for furniture/props on upper floors).
   *
   * Ground floor tiles should use CollisionMatrix.addFlags(BLOCKED) instead.
   * This method is for floor 1+ where CollisionMatrix has no coverage.
   *
   * @param buildingId - The building containing the floor
   * @param floorIndex - Floor index (typically 1+)
   * @param tileX - World tile X
   * @param tileZ - World tile Z
   * @returns true if tile was successfully blocked
   */
  blockFloorTile(
    buildingId: string,
    floorIndex: number,
    tileX: number,
    tileZ: number,
  ): boolean {
    const building = this.buildings.get(buildingId);
    if (!building) return false;

    const floor = building.floors.find((f) => f.floorIndex === floorIndex);
    if (!floor) return false;

    const key = tileKey(tileX, tileZ);
    if (!floor.walkableTiles.has(key)) return false; // Can't block a non-walkable tile

    if (!floor.blockedTiles) {
      floor.blockedTiles = new Set<string>();
    }
    floor.blockedTiles.add(key);
    return true;
  }

  /**
   * Unblock a tile on a specific floor (when furniture is removed).
   *
   * @param buildingId - The building containing the floor
   * @param floorIndex - Floor index
   * @param tileX - World tile X
   * @param tileZ - World tile Z
   * @returns true if tile was successfully unblocked
   */
  unblockFloorTile(
    buildingId: string,
    floorIndex: number,
    tileX: number,
    tileZ: number,
  ): boolean {
    const building = this.buildings.get(buildingId);
    if (!building) return false;

    const floor = building.floors.find((f) => f.floorIndex === floorIndex);
    if (!floor || !floor.blockedTiles) return false;

    const key = tileKey(tileX, tileZ);
    return floor.blockedTiles.delete(key);
  }

  // ============================================================================
  // DEBUG / UTILITY
  // ============================================================================

  /**
   * Get all registered buildings
   */
  getAllBuildings(): BuildingCollisionData[] {
    return Array.from(this.buildings.values());
  }

  /**
   * Get building by ID
   */
  getBuilding(buildingId: string): BuildingCollisionData | undefined {
    return this.buildings.get(buildingId);
  }

  /**
   * Check if a world position is close to any building's bounding box.
   * Used for roof hiding when camera approaches buildings.
   *
   * @param worldX - World X coordinate
   * @param worldZ - World Z coordinate
   * @param margin - Distance margin in tiles (default 2)
   * @returns Building ID if position is near a building, null otherwise
   */
  isPositionNearBuilding(
    worldX: number,
    worldZ: number,
    margin: number = 2,
  ): string | null {
    const tileX = Math.floor(worldX);
    const tileZ = Math.floor(worldZ);

    for (const [buildingId, building] of this.buildings) {
      const { minTileX, maxTileX, minTileZ, maxTileZ } = building.boundingBox;
      // Check if position is within bounding box + margin
      if (
        tileX >= minTileX - margin &&
        tileX <= maxTileX + margin &&
        tileZ >= minTileZ - margin &&
        tileZ <= maxTileZ + margin
      ) {
        return buildingId;
      }
    }
    return null;
  }

  /**
   * Get all buildings within a certain distance of a world position.
   * Used for determining which building roofs to hide.
   *
   * @param worldX - World X coordinate
   * @param worldZ - World Z coordinate
   * @param margin - Distance margin in tiles (default 3)
   * @returns Array of building IDs near the position
   */
  getBuildingsNearPosition(
    worldX: number,
    worldZ: number,
    margin: number = 3,
  ): string[] {
    const tileX = Math.floor(worldX);
    const tileZ = Math.floor(worldZ);
    const nearbyBuildings: string[] = [];

    for (const [buildingId, building] of this.buildings) {
      const { minTileX, maxTileX, minTileZ, maxTileZ } = building.boundingBox;
      // Check if position is within bounding box + margin
      if (
        tileX >= minTileX - margin &&
        tileX <= maxTileX + margin &&
        tileZ >= minTileZ - margin &&
        tileZ <= maxTileZ + margin
      ) {
        nearbyBuildings.push(buildingId);
      }
    }
    return nearbyBuildings;
  }

  // ============================================================================
  // HELPER METHODS (Consolidation to reduce code duplication)
  // ============================================================================

  /**
   * Get a specific floor from a building by floor index.
   * Returns undefined if building doesn't exist or floor not found.
   *
   * @param buildingId - Building ID
   * @param floorIndex - Floor index (0 = ground floor)
   */
  getFloor(
    buildingId: string,
    floorIndex: number,
  ): FloorCollisionData | undefined {
    const building = this.buildings.get(buildingId);
    if (!building) return undefined;
    return building.floors.find((f) => f.floorIndex === floorIndex);
  }

  /**
   * Get the ground floor (floor 0) from a building.
   * Convenience method for the most common floor lookup.
   *
   * @param buildingId - Building ID
   */
  getGroundFloor(buildingId: string): FloorCollisionData | undefined {
    return this.getFloor(buildingId, 0);
  }

  /**
   * Get all door wall segments from a floor.
   * Filters wallSegments to only return doors (not windows or arches).
   *
   * @param floor - Floor collision data
   */
  static getDoorWallSegments(floor: FloorCollisionData): WallSegment[] {
    return floor.wallSegments.filter(
      (wall) => wall.hasOpening && wall.openingType === "door",
    );
  }

  /**
   * Get all entrance wall segments from a floor (doors AND arches).
   * Both doors and arches allow passage into the building.
   *
   * @param floor - Floor collision data
   */
  static getEntranceWallSegments(floor: FloorCollisionData): WallSegment[] {
    return floor.wallSegments.filter(
      (wall) =>
        wall.hasOpening &&
        (wall.openingType === "door" || wall.openingType === "arch"),
    );
  }

  /**
   * Check if a wall segment is a door.
   *
   * @param wall - Wall segment to check
   */
  static isDoorWall(wall: WallSegment): boolean {
    return wall.hasOpening && wall.openingType === "door";
  }

  /**
   * Check if a wall segment is an entrance (door or arch).
   *
   * @param wall - Wall segment to check
   */
  static isEntranceWall(wall: WallSegment): boolean {
    return (
      wall.hasOpening &&
      (wall.openingType === "door" || wall.openingType === "arch")
    );
  }

  /**
   * Get a specific floor from building data by floor index.
   * Static version for use when you have the BuildingCollisionData directly.
   *
   * @param building - Building collision data
   * @param floorIndex - Floor index (0 = ground floor)
   */
  static getFloorFromData(
    building: BuildingCollisionData,
    floorIndex: number,
  ): FloorCollisionData | undefined {
    return building.floors.find((f) => f.floorIndex === floorIndex);
  }

  /**
   * Get the ground floor (floor 0) from building data.
   * Static convenience method for the most common floor lookup.
   *
   * @param building - Building collision data
   */
  static getGroundFloorFromData(
    building: BuildingCollisionData,
  ): FloorCollisionData | undefined {
    return BuildingCollisionService.getFloorFromData(building, 0);
  }

  /**
   * Calculate exterior (approach) and interior tiles for a door.
   * SINGLE SOURCE OF TRUTH for door tile calculations.
   *
   * @param wallTileX - The wall segment's tile X (inside building)
   * @param wallTileZ - The wall segment's tile Z (inside building)
   * @param wallSide - The direction the wall faces (north, south, east, west)
   * @returns Object with exterior (approach from outside) and interior (inside building) tiles
   */
  static getDoorExteriorAndInterior(
    wallTileX: number,
    wallTileZ: number,
    wallSide: WallDirection,
  ): {
    exteriorX: number;
    exteriorZ: number;
    interiorX: number;
    interiorZ: number;
  } {
    // Validate inputs
    if (!Number.isFinite(wallTileX) || !Number.isFinite(wallTileZ)) {
      throw new Error(
        `[BuildingCollision] getDoorExteriorAndInterior: invalid wall tile coords (${wallTileX}, ${wallTileZ})`,
      );
    }
    if (!wallSide || !["north", "south", "east", "west"].includes(wallSide)) {
      throw new Error(
        `[BuildingCollision] getDoorExteriorAndInterior: invalid wallSide "${wallSide}"`,
      );
    }

    // Interior tile is the wall segment itself (inside building)
    const interiorX = wallTileX;
    const interiorZ = wallTileZ;

    // Exterior tile is one step OUTSIDE the building in the direction the wall faces
    let exteriorX = wallTileX;
    let exteriorZ = wallTileZ;

    // Wall "side" is the EXTERIOR direction (where the wall faces)
    // North-facing wall → exterior is north (lower Z)
    // South-facing wall → exterior is south (higher Z)
    // East-facing wall → exterior is east (higher X)
    // West-facing wall → exterior is west (lower X)
    switch (wallSide) {
      case "north":
        exteriorZ -= 1;
        break;
      case "south":
        exteriorZ += 1;
        break;
      case "east":
        exteriorX += 1;
        break;
      case "west":
        exteriorX -= 1;
        break;
    }

    return { exteriorX, exteriorZ, interiorX, interiorZ };
  }

  /**
   * Get door tiles for a building on ground floor.
   * Used for door pathfinding - when clicking inside a building from outside,
   * path to the nearest door first.
   *
   * @param buildingId - Building ID to get doors for
   * @returns Array of door tile coordinates with entry direction
   */
  getDoorTiles(
    buildingId: string,
  ): Array<{ tileX: number; tileZ: number; direction: WallDirection }> {
    // Use helper method for ground floor lookup
    const groundFloor = this.getGroundFloor(buildingId);
    if (!groundFloor) return [];

    // Use helper method to get door wall segments
    const doorWalls = BuildingCollisionService.getDoorWallSegments(groundFloor);

    return doorWalls.map((wall) => {
      const doorCalc = BuildingCollisionService.getDoorExteriorAndInterior(
        wall.tileX,
        wall.tileZ,
        wall.side,
      );
      return {
        tileX: doorCalc.exteriorX,
        tileZ: doorCalc.exteriorZ,
        direction: wall.side,
      };
    });
  }

  /**
   * Get entrance tiles (doors AND arches) for a building on ground floor.
   * Both doors and arches allow passage into the building.
   * Used for pathfinding validation - when clicking inside a building from outside,
   * path to the nearest entrance first.
   *
   * @param buildingId - Building ID to get entrances for
   * @returns Array of entrance tile coordinates with entry direction
   */
  getEntranceTiles(
    buildingId: string,
  ): Array<{ tileX: number; tileZ: number; direction: WallDirection }> {
    // Use helper method for ground floor lookup
    const groundFloor = this.getGroundFloor(buildingId);
    if (!groundFloor) return [];

    // Use helper method to get entrance wall segments (doors AND arches)
    const entranceWalls =
      BuildingCollisionService.getEntranceWallSegments(groundFloor);

    return entranceWalls.map((wall) => {
      const entranceCalc = BuildingCollisionService.getDoorExteriorAndInterior(
        wall.tileX,
        wall.tileZ,
        wall.side,
      );
      return {
        tileX: entranceCalc.exteriorX,
        tileZ: entranceCalc.exteriorZ,
        direction: wall.side,
      };
    });
  }

  /**
   * Find the closest entrance tile (door OR arch) to a given position.
   * Used for entrance pathfinding when player clicks inside a building from outside.
   *
   * IMPORTANT: This method finds BOTH doors AND arches as valid entry points.
   * Buildings may have arches as their primary entrance (e.g., open-air structures,
   * covered markets), and pathfinding should prefer the closest entrance regardless
   * of whether it's a door or an arch.
   *
   * Returns BOTH the exterior approach tile AND the interior entrance tile.
   * This allows pathfinding to include stepping through the entrance in one stage.
   *
   * @param buildingId - Building ID to find entrance for
   * @param fromTileX - Player's current tile X
   * @param fromTileZ - Player's current tile Z
   * @returns Closest entrance with entry (exterior) and interior tiles, or null if no entrances found
   */
  findClosestDoorTile(
    buildingId: string,
    fromTileX: number,
    fromTileZ: number,
  ): {
    tileX: number;
    tileZ: number;
    direction: WallDirection;
    interiorTileX: number;
    interiorTileZ: number;
  } | null {
    const building = this.buildings.get(buildingId);
    if (!building) return null;

    // Use helper method for ground floor lookup
    const groundFloor = this.getGroundFloor(buildingId);
    if (!groundFloor) return null;

    // Use getEntranceWallSegments to get BOTH doors AND arches as valid entry points
    // This matches the behavior in asset-forge's NavigationVisualizer which correctly
    // treats arches as valid entrances for pathfinding purposes
    const entranceWalls =
      BuildingCollisionService.getEntranceWallSegments(groundFloor);
    if (entranceWalls.length === 0) return null;

    const entranceData = entranceWalls.map((wall) => {
      const entranceCalc = BuildingCollisionService.getDoorExteriorAndInterior(
        wall.tileX,
        wall.tileZ,
        wall.side,
      );
      return {
        entryX: entranceCalc.exteriorX,
        entryZ: entranceCalc.exteriorZ,
        interiorX: entranceCalc.interiorX,
        interiorZ: entranceCalc.interiorZ,
        direction: wall.side,
      };
    });

    // Find closest entry tile
    let closest = entranceData[0];
    let closestDistSq =
      (closest.entryX - fromTileX) ** 2 + (closest.entryZ - fromTileZ) ** 2;

    for (let i = 1; i < entranceData.length; i++) {
      const entrance = entranceData[i];
      const distSq =
        (entrance.entryX - fromTileX) ** 2 + (entrance.entryZ - fromTileZ) ** 2;
      if (distSq < closestDistSq) {
        closest = entrance;
        closestDistSq = distSq;
      }
    }

    // Validate returned entrance coordinates are finite
    if (
      !Number.isFinite(closest.entryX) ||
      !Number.isFinite(closest.entryZ) ||
      !Number.isFinite(closest.interiorX) ||
      !Number.isFinite(closest.interiorZ)
    ) {
      throw new Error(
        `[BuildingCollision] findClosestDoorTile: entrance coordinates are non-finite for ${buildingId}: ` +
          `entry=(${closest.entryX},${closest.entryZ}), interior=(${closest.interiorX},${closest.interiorZ})`,
      );
    }

    return {
      tileX: closest.entryX,
      tileZ: closest.entryZ,
      direction: closest.direction,
      interiorTileX: closest.interiorX,
      interiorTileZ: closest.interiorZ,
    };
  }

  /**
   * Get ALL entrance tiles (doors + arches) for a building, sorted by distance.
   * Used for fallback entrance selection when the closest is unreachable.
   *
   * @param buildingId - Building to get entrances for
   * @param fromTileX - Reference tile X for sorting
   * @param fromTileZ - Reference tile Z for sorting
   * @returns Array of entrance tiles sorted closest-first, empty if none found
   */
  findAllEntranceTilesSorted(
    buildingId: string,
    fromTileX: number,
    fromTileZ: number,
  ): Array<{
    tileX: number;
    tileZ: number;
    direction: WallDirection;
    interiorTileX: number;
    interiorTileZ: number;
  }> {
    const building = this.buildings.get(buildingId);
    if (!building) return [];

    const groundFloor = this.getGroundFloor(buildingId);
    if (!groundFloor) return [];

    const entranceWalls =
      BuildingCollisionService.getEntranceWallSegments(groundFloor);
    if (entranceWalls.length === 0) return [];

    const result = entranceWalls
      .map((wall) => {
        const calc = BuildingCollisionService.getDoorExteriorAndInterior(
          wall.tileX,
          wall.tileZ,
          wall.side,
        );
        if (
          !Number.isFinite(calc.exteriorX) ||
          !Number.isFinite(calc.exteriorZ) ||
          !Number.isFinite(calc.interiorX) ||
          !Number.isFinite(calc.interiorZ)
        ) {
          return null;
        }
        return {
          tileX: calc.exteriorX,
          tileZ: calc.exteriorZ,
          direction: wall.side,
          interiorTileX: calc.interiorX,
          interiorTileZ: calc.interiorZ,
          distSq:
            (calc.exteriorX - fromTileX) ** 2 +
            (calc.exteriorZ - fromTileZ) ** 2,
        };
      })
      .filter(
        (entry): entry is NonNullable<typeof entry> & { distSq: number } =>
          entry !== null,
      )
      .sort((a, b) => a.distSq - b.distSq)
      .map(({ distSq: _distSq, ...rest }) => rest);

    return result;
  }

  /**
   * Get count of registered buildings
   */
  getBuildingCount(): number {
    return this.buildings.size;
  }

  /**
   * Get debug info for all registered buildings.
   * Used by PathfindingDebugSystem for visualization.
   */
  getDebugBuildingInfo(): Array<{
    buildingId: string;
    townId: string;
    worldPosition: { x: number; y: number; z: number };
    floorCount: number;
    floors: Array<{
      floorIndex: number;
      elevation: number;
      walkableTileCount: number;
      wallSegmentCount: number;
      doorCount: number;
      stairCount: number;
    }>;
  }> {
    const result: Array<{
      buildingId: string;
      townId: string;
      worldPosition: { x: number; y: number; z: number };
      floorCount: number;
      floors: Array<{
        floorIndex: number;
        elevation: number;
        walkableTileCount: number;
        wallSegmentCount: number;
        doorCount: number;
        stairCount: number;
      }>;
    }> = [];

    for (const building of this.buildings.values()) {
      const floors = building.floors.map((floor) => ({
        floorIndex: floor.floorIndex,
        elevation: floor.elevation,
        walkableTileCount: floor.walkableTiles.size,
        wallSegmentCount: floor.wallSegments.length,
        doorCount: floor.wallSegments.filter((w) => w.hasOpening).length,
        stairCount: floor.stairTiles.length,
      }));

      result.push({
        buildingId: building.buildingId,
        townId: building.townId,
        worldPosition: building.worldPosition,
        floorCount: building.floors.length,
        floors,
      });
    }

    return result;
  }

  /**
   * Clear all registered buildings
   */
  clear(): void {
    // Unregister all walls from collision matrix
    for (const building of this.buildings.values()) {
      this.unregisterWallsFromCollisionMatrix(building);
    }

    this.buildings.clear();
    this.tileToBuildings.clear();
    this.tileToBuildingBbox.clear();
    this.tileToBuildingGroundCoverage.clear();
    this.tileToStepTile.clear();
    this.playerFloorStates.clear();
  }

  // ============================================================================
  // UNIFIED NAVIGATION HELPERS
  // ============================================================================

  /**
   * Comprehensive navigation check - can player move from one tile to another?
   *
   * This is the SINGLE SOURCE OF TRUTH for building navigation.
   * Use this method instead of combining multiple separate checks.
   *
   * Checks performed:
   * 1. Source and destination tile walkability
   * 2. Directional wall blocking
   * 3. Step tile directional restrictions
   * 4. Floor-appropriate collision
   *
   * @param fromTile - Source tile coordinates
   * @param toTile - Destination tile coordinates
   * @param floorIndex - Current floor level
   * @returns Object with walkable boolean and detailed reason if blocked
   */
  canMoveFromTo(
    fromTile: TileCoord,
    toTile: TileCoord,
    floorIndex: number,
  ): { allowed: boolean; reason?: string } {
    // Validate movement distance (only adjacent tiles allowed)
    const dx = Math.abs(toTile.x - fromTile.x);
    const dz = Math.abs(toTile.z - fromTile.z);
    if (dx > 1 || dz > 1) {
      return {
        allowed: false,
        reason: `Movement too far: (${fromTile.x},${fromTile.z}) to (${toTile.x},${toTile.z}) is ${Math.max(dx, dz)} tiles`,
      };
    }

    // Check if SOURCE tile is in a building context
    // If source is inside a building, it must be walkable on that floor
    const sourceInBuilding =
      this.isTileInBuildingFootprint(fromTile.x, fromTile.z) !== null;
    if (sourceInBuilding) {
      const sourceWalkable = this.isTileWalkableInBuilding(
        fromTile.x,
        fromTile.z,
        floorIndex,
      );
      if (!sourceWalkable) {
        return {
          allowed: false,
          reason: `Source tile (${fromTile.x},${fromTile.z}) not walkable on floor ${floorIndex}`,
        };
      }
    }

    // Check if destination is walkable in building context
    const destWalkable = this.isTileWalkableInBuilding(
      toTile.x,
      toTile.z,
      floorIndex,
    );
    if (!destWalkable) {
      return {
        allowed: false,
        reason: `Destination tile (${toTile.x},${toTile.z}) not walkable on floor ${floorIndex}`,
      };
    }

    // Check wall blocking
    const wallBlocked = this.isWallBlocked(
      fromTile.x,
      fromTile.z,
      toTile.x,
      toTile.z,
      floorIndex,
    );
    if (wallBlocked) {
      return {
        allowed: false,
        reason: `Wall blocks movement from (${fromTile.x},${fromTile.z}) to (${toTile.x},${toTile.z})`,
      };
    }

    // Check step tile directional restrictions
    const stepBlocked = this.isStepBlocked(
      fromTile.x,
      fromTile.z,
      toTile.x,
      toTile.z,
    );
    if (stepBlocked) {
      return {
        allowed: false,
        reason: `Step tile blocks side entry to (${toTile.x},${toTile.z})`,
      };
    }

    return { allowed: true };
  }

  // ============================================================================
  // PUBLIC HELPER METHODS (API)
  // ============================================================================

  /**
   * Get the current floor index for a player
   */
  getPlayerFloor(entityId: EntityID): number {
    return this.getPlayerBuildingState(entityId).currentFloor;
  }

  /**
   * Get the building ID at a specific tile coordinates
   */
  getBuildingAt(tileX: number, tileZ: number): string | null {
    return this.getBuildingAtTile(tileX, tileZ);
  }

  /**
   * Get floor height for a specific building and floor
   */
  getFloorHeight(buildingId: string, floorIndex: number): number | null {
    const floor = this.getFloor(buildingId, floorIndex);
    return floor ? floor.elevation : null;
  }

  /**
   * Get stair connection info for a tile
   */
  getStairConnection(
    tileX: number,
    tileZ: number,
    floorIndex: number,
  ): StairTile | null {
    const result = this.queryCollision(tileX, tileZ, floorIndex);
    return result.stairTile;
  }

  /**
   * Comprehensive building movement check for pathfinding integration.
   *
   * This is the PRIMARY method for tile-movement.ts to use for building-related
   * movement checks. Handles:
   * - Building footprint and bbox analysis
   * - Layer separation (ground vs building transitions)
   * - Wall and step blocking
   * - Door transition validation
   *
   * @param fromTile - Source tile (null for destination-only checks)
   * @param toTile - Target tile
   * @param playerFloor - Current player floor
   * @param playerBuildingId - Current building the player is in (null if on ground)
   * @returns Complete movement analysis including final buildingAllowsMovement verdict
   */
  checkBuildingMovement(
    fromTile: TileCoord | null,
    toTile: TileCoord,
    playerFloor: number,
    playerBuildingId: string | null,
  ): {
    // Target tile analysis
    targetBuildingId: string | null;
    targetInBuildingFootprint: boolean;
    targetInBuildingBbox: string | null;
    targetUnderBuilding: boolean;
    targetWalkableOnFloor: boolean;
    targetDoorOpenings: WallDirection[];

    // Source tile analysis (if fromTile provided)
    sourceBuildingId: string | null;
    sourceInBuildingFootprint: boolean;
    sourceDoorOpenings: WallDirection[];

    // Movement blocking
    wallBlocked: boolean;
    stepBlocked: boolean;

    // Final verdict for building layer (does NOT include terrain/CollisionMatrix)
    buildingAllowsMovement: boolean;
    blockReason: string | null;
  } {
    // Analyze target tile
    const targetBuildingId = this.isTileInBuildingFootprint(toTile.x, toTile.z);
    const targetInBuildingFootprint = targetBuildingId !== null;
    const targetInBuildingBbox = this.isTileInBuildingBoundingBox(
      toTile.x,
      toTile.z,
    );
    const targetCoverageBuildingId = this.isTileInBuildingGroundCoverage(
      toTile.x,
      toTile.z,
    );
    const targetUnderBuilding =
      targetCoverageBuildingId !== null && !targetInBuildingFootprint;
    const targetWalkableOnFloor = this.isTileWalkableInBuilding(
      toTile.x,
      toTile.z,
      playerFloor,
    );
    const targetDoorOpenings = this.getDoorOpeningsAtTile(
      toTile.x,
      toTile.z,
      playerFloor,
    );

    // Analyze source tile
    let sourceBuildingId: string | null = null;
    let sourceInBuildingFootprint = false;
    let sourceDoorOpenings: WallDirection[] = [];
    if (fromTile) {
      sourceBuildingId = this.isTileInBuildingFootprint(fromTile.x, fromTile.z);
      sourceInBuildingFootprint = sourceBuildingId !== null;
      sourceDoorOpenings = this.getDoorOpeningsAtTile(
        fromTile.x,
        fromTile.z,
        playerFloor,
      );
    }

    // Check blocking
    let wallBlocked = false;
    let stepBlocked = false;
    if (fromTile) {
      wallBlocked = this.isWallBlocked(
        fromTile.x,
        fromTile.z,
        toTile.x,
        toTile.z,
        playerFloor,
      );
      stepBlocked = this.isStepBlocked(
        fromTile.x,
        fromTile.z,
        toTile.x,
        toTile.z,
      );
    }

    // =========================================================================
    // LAYER SEPARATION: Determine if this movement is allowed
    // =========================================================================
    let buildingAllowsMovement = true;
    let blockReason: string | null = null;

    if (playerBuildingId === null) {
      // PLAYER IS ON GROUND LAYER

      // Block tiles UNDER buildings that aren't walkable (door exterior tiles)
      if (targetUnderBuilding && !targetWalkableOnFloor) {
        buildingAllowsMovement = false;
        blockReason = `Ground player: tile (${toTile.x},${toTile.z}) under building ${targetInBuildingBbox} but not walkable`;
      }

      // Building interior tiles are BLOCKED unless this is a door transition
      if (buildingAllowsMovement && targetInBuildingFootprint) {
        if (targetDoorOpenings.length === 0) {
          buildingAllowsMovement = false;
          blockReason = `Ground player: cannot enter building tile (${toTile.x},${toTile.z}) - not a door`;
        } else if (fromTile) {
          // Door tile - but we MUST enter from the correct direction!
          // Calculate entry direction (direction we're coming FROM)
          const dx = toTile.x - fromTile.x;
          const dz = toTile.z - fromTile.z;

          // For diagonal movement, block unless walls allow it (handled by isWallBlocked)
          // For cardinal movement, check if entry direction matches a door opening
          if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
            let entryDirection: WallDirection | null = null;

            // Cardinal movement: entry direction is opposite of movement
            if (dx === 1 && dz === 0)
              entryDirection = "west"; // Moving east, entering from west
            else if (dx === -1 && dz === 0)
              entryDirection = "east"; // Moving west, entering from east
            else if (dz === 1 && dx === 0)
              entryDirection = "north"; // Moving south, entering from north
            else if (dz === -1 && dx === 0)
              entryDirection = "south"; // Moving north, entering from south
            // Diagonal: need to check both edges
            else if (dx !== 0 && dz !== 0) {
              // Diagonal entry to door tile
              // Entry is valid ONLY if one of the two edges has a door
              const horizEntry: WallDirection = dx > 0 ? "west" : "east";
              const vertEntry: WallDirection = dz > 0 ? "north" : "south";

              const horizDoor = targetDoorOpenings.includes(horizEntry);
              const vertDoor = targetDoorOpenings.includes(vertEntry);

              if (!horizDoor && !vertDoor) {
                // Neither edge has a door - block diagonal entry
                buildingAllowsMovement = false;
                blockReason =
                  `Ground player: diagonal entry to door (${toTile.x},${toTile.z}) blocked - ` +
                  `doors=[${targetDoorOpenings.join(",")}] but entering from ${horizEntry}/${vertEntry}`;
              }
              // At least one edge is a door - allow (wall blocking will handle clipping)
              entryDirection = null; // Skip cardinal check
            }

            // Cardinal movement must match door direction
            if (
              entryDirection &&
              !targetDoorOpenings.includes(entryDirection)
            ) {
              buildingAllowsMovement = false;
              blockReason =
                `Ground player: cannot enter door (${toTile.x},${toTile.z}) from ${entryDirection} - ` +
                `doors face [${targetDoorOpenings.join(",")}]`;
            }
          }
        }
        // Door tile from correct direction - allow as transition point
      }
    } else {
      // PLAYER IS IN BUILDING LAYER

      // Block tiles under a DIFFERENT building
      if (
        targetUnderBuilding &&
        targetCoverageBuildingId !== playerBuildingId
      ) {
        buildingAllowsMovement = false;
        blockReason = `Building player (${playerBuildingId}): cannot path through different building ${targetCoverageBuildingId}`;
      }

      if (buildingAllowsMovement && targetInBuildingFootprint) {
        // Target is a building tile - only allow if SAME building
        if (targetBuildingId !== playerBuildingId) {
          buildingAllowsMovement = false;
          blockReason = `Building player (${playerBuildingId}): cannot enter different building (${targetBuildingId})`;
        }
        // Same building - check floor walkability below
      } else if (
        buildingAllowsMovement &&
        !targetInBuildingFootprint &&
        !targetUnderBuilding
      ) {
        // Target is a GROUND tile - only allow through door exit
        if (
          fromTile &&
          sourceInBuildingFootprint &&
          sourceBuildingId === playerBuildingId
        ) {
          // Moving from inside building to ground - check for door
          const dx = toTile.x - fromTile.x;
          const dz = toTile.z - fromTile.z;

          if (dx !== 0 && dz !== 0) {
            // Diagonal exit - check if EITHER edge has a door (mirrors entry logic)
            const horizExit: WallDirection = dx > 0 ? "east" : "west";
            const vertExit: WallDirection = dz > 0 ? "south" : "north";

            if (
              !sourceDoorOpenings.includes(horizExit) &&
              !sourceDoorOpenings.includes(vertExit)
            ) {
              buildingAllowsMovement = false;
              blockReason =
                `Building player: diagonal exit to (${toTile.x},${toTile.z}) blocked - ` +
                `no door on ${horizExit} or ${vertExit}. Source doors=[${sourceDoorOpenings.join(",")}]`;
            }
            // At least one edge is a door - allow (wall blocking handles clipping)
          } else {
            // Cardinal exit
            let exitDirection: WallDirection | null = null;
            if (dx === 1) exitDirection = "east";
            else if (dx === -1) exitDirection = "west";
            else if (dz === 1) exitDirection = "south";
            else if (dz === -1) exitDirection = "north";

            if (!exitDirection || !sourceDoorOpenings.includes(exitDirection)) {
              buildingAllowsMovement = false;
              blockReason = `Building player: cannot exit to ground (${toTile.x},${toTile.z}) without door. Source doors=[${sourceDoorOpenings.join(",")}]`;
            }
          }
          // Door exit - allow
        } else if (!fromTile) {
          // No fromTile - destination check only, ground tiles invalid from inside building
          buildingAllowsMovement = false;
          blockReason = `Building player: cannot target ground tile (${toTile.x},${toTile.z}) directly`;
        }
      }
    }

    // =========================================================================
    // BUILDING FLOOR WALKABILITY (for tiles in building footprint)
    // =========================================================================
    if (
      buildingAllowsMovement &&
      targetInBuildingFootprint &&
      !targetWalkableOnFloor
    ) {
      buildingAllowsMovement = false;
      blockReason = `Target (${toTile.x},${toTile.z}) not walkable in building ${targetBuildingId} on floor ${playerFloor}`;
    }

    // =========================================================================
    // WALL AND STEP BLOCKING
    // =========================================================================
    if (buildingAllowsMovement && wallBlocked) {
      buildingAllowsMovement = false;
      blockReason = `Wall blocks movement from (${fromTile?.x},${fromTile?.z}) to (${toTile.x},${toTile.z})`;
    }

    if (buildingAllowsMovement && stepBlocked) {
      buildingAllowsMovement = false;
      blockReason = `Step blocks side entry to (${toTile.x},${toTile.z})`;
    }

    return {
      targetBuildingId,
      targetInBuildingFootprint,
      targetInBuildingBbox,
      targetUnderBuilding,
      targetWalkableOnFloor,
      targetDoorOpenings,
      sourceBuildingId,
      sourceInBuildingFootprint,
      sourceDoorOpenings,
      wallBlocked,
      stepBlocked,
      buildingAllowsMovement,
      blockReason,
    };
  }

  /**
   * Validate entire building's navigation integrity.
   *
   * Performs comprehensive checks on a building:
   * 1. All walkable tiles are reachable from entrance (via BFS flood fill)
   * 2. All walls properly block movement (sample tests)
   * 3. All doors allow passage
   * 4. Floor tracking is correct
   *
   * @param buildingId - Building to validate
   * @returns Validation result with errors if any found
   */
  validateBuildingNavigation(buildingId: string): {
    valid: boolean;
    errors: string[];
    stats: {
      walkableTiles: number;
      wallSegments: number;
      doors: number;
      reachableTiles: number;
    };
  } {
    const errors: string[] = [];
    const building = this.buildings.get(buildingId);

    if (!building) {
      return {
        valid: false,
        errors: [`Building ${buildingId} not registered`],
        stats: {
          walkableTiles: 0,
          wallSegments: 0,
          doors: 0,
          reachableTiles: 0,
        },
      };
    }

    const groundFloor = building.floors.find((f) => f.floorIndex === 0);
    if (!groundFloor) {
      return {
        valid: false,
        errors: [`Building ${buildingId} has no ground floor`],
        stats: {
          walkableTiles: 0,
          wallSegments: 0,
          doors: 0,
          reachableTiles: 0,
        },
      };
    }

    const walkableTiles = groundFloor.walkableTiles.size;
    const wallSegments = groundFloor.wallSegments.length;
    const doors = groundFloor.wallSegments.filter(
      (w) =>
        w.hasOpening && (w.openingType === "door" || w.openingType === "arch"),
    ).length;

    // Check for doors
    if (doors === 0) {
      errors.push(`Building ${buildingId} has no entrances (doors or arches)`);
    }

    // Check for walkable tiles
    if (walkableTiles === 0) {
      errors.push(`Building ${buildingId} has no walkable tiles`);
    }

    // Check that all four cardinal directions have walls on edges
    const wallDirections = new Set(groundFloor.wallSegments.map((w) => w.side));
    const expectedDirections: WallDirection[] = [
      "north",
      "south",
      "east",
      "west",
    ];
    for (const dir of expectedDirections) {
      if (!wallDirections.has(dir)) {
        errors.push(`Building ${buildingId} missing walls on ${dir} edge`);
      }
    }

    // REAL REACHABILITY CHECK: BFS flood fill from door interior tile
    // This verifies all tiles are actually reachable, not just in spatial index
    let reachableTiles = 0;
    const doorSegments = groundFloor.wallSegments.filter(
      (w) =>
        w.hasOpening && (w.openingType === "door" || w.openingType === "arch"),
    );

    if (doorSegments.length > 0) {
      // Find a door interior tile to start BFS from
      const door = doorSegments[0];
      const interior = BuildingCollisionService.getDoorExteriorAndInterior(
        door.tileX,
        door.tileZ,
        door.side,
      );
      const startTile = { x: interior.interiorX, z: interior.interiorZ };

      // BFS flood fill to find all reachable tiles
      // Performance safeguard: limit iterations to prevent runaway on malformed buildings
      const MAX_ITERATIONS = walkableTiles * 2; // Should never need more than 2x walkable tiles
      let iterations = 0;
      const visited = new Set<string>();
      const queue: TileCoord[] = [startTile];
      let queueReadIndex = 0; // PERF: Use read index instead of shift() which is O(n)
      visited.add(tileKey(startTile.x, startTile.z));

      while (queueReadIndex < queue.length && iterations < MAX_ITERATIONS) {
        iterations++;
        const current = queue[queueReadIndex++]; // O(1) instead of O(n) shift()
        const currentKey = tileKey(current.x, current.z);

        // Only count tiles that are actually in the building's walkable set
        if (groundFloor.walkableTiles.has(currentKey)) {
          reachableTiles++;
        }

        // Check all 4 cardinal neighbors
        const neighbors = [
          { x: current.x, z: current.z - 1 }, // north
          { x: current.x, z: current.z + 1 }, // south
          { x: current.x + 1, z: current.z }, // east
          { x: current.x - 1, z: current.z }, // west
        ];

        for (const neighbor of neighbors) {
          const neighborKey = tileKey(neighbor.x, neighbor.z);

          // Skip if already visited
          if (visited.has(neighborKey)) continue;

          // Skip if not a walkable building tile
          if (!groundFloor.walkableTiles.has(neighborKey)) continue;

          // Skip if wall blocks movement
          const wallBlocked = this.isWallBlocked(
            current.x,
            current.z,
            neighbor.x,
            neighbor.z,
            0,
          );
          if (wallBlocked) continue;

          visited.add(neighborKey);
          queue.push(neighbor);
        }
      }
    }

    if (reachableTiles < walkableTiles) {
      errors.push(
        `Building ${buildingId}: Only ${reachableTiles}/${walkableTiles} tiles reachable from entrance (unreachable tiles may be blocked by walls)`,
      );
    }

    // WALL BLOCKING VERIFICATION: Sample test that walls actually block
    // Pick a non-door wall segment and verify it blocks movement
    const solidWalls = groundFloor.wallSegments.filter((w) => !w.hasOpening);
    if (solidWalls.length > 0) {
      const testWall = solidWalls[0];
      // Calculate the tile outside this wall
      const outsideOffset =
        testWall.side === "north"
          ? { dx: 0, dz: -1 }
          : testWall.side === "south"
            ? { dx: 0, dz: 1 }
            : testWall.side === "east"
              ? { dx: 1, dz: 0 }
              : { dx: -1, dz: 0 };

      const outsideTileX = testWall.tileX + outsideOffset.dx;
      const outsideTileZ = testWall.tileZ + outsideOffset.dz;

      const shouldBeBlocked = this.isWallBlocked(
        outsideTileX,
        outsideTileZ,
        testWall.tileX,
        testWall.tileZ,
        0,
      );

      if (!shouldBeBlocked) {
        errors.push(
          `Building ${buildingId}: Wall at (${testWall.tileX},${testWall.tileZ}) ${testWall.side} does NOT block movement - walls may be broken`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      stats: { walkableTiles, wallSegments, doors, reachableTiles },
    };
  }

  /**
   * Get detailed diagnostic info for a specific tile.
   *
   * Useful for debugging why a tile is or isn't walkable.
   *
   * @param tileX - Tile X coordinate
   * @param tileZ - Tile Z coordinate
   * @param floorIndex - Floor to check
   * @returns Detailed diagnostic information
   */
  getTileDiagnostics(
    tileX: number,
    tileZ: number,
    floorIndex: number,
  ): {
    isWalkable: boolean;
    isInBuilding: boolean;
    buildingId: string | null;
    isInBoundingBox: boolean;
    isInFootprint: boolean;
    hasWallFlags: {
      north: boolean;
      south: boolean;
      east: boolean;
      west: boolean;
    };
    collisionMatrixWallFlags: {
      north: boolean;
      south: boolean;
      east: boolean;
      west: boolean;
    };
    isStepTile: boolean;
    isDoorTile: boolean;
    blocksMovementNorth: boolean;
    blocksMovementSouth: boolean;
    blocksMovementEast: boolean;
    blocksMovementWest: boolean;
  } {
    const key = tileKey(tileX, tileZ);
    const buildingIds = this.tileToBuildings.get(key);
    const buildingId = buildingIds?.values().next().value ?? null;
    const collision = this.queryCollision(tileX, tileZ, floorIndex);

    // Check if in any building's bounding box
    let isInBoundingBox = false;
    let bboxBuildingId: string | null = null;
    for (const building of this.buildings.values()) {
      const bbox = building.boundingBox;
      if (
        tileX >= bbox.minTileX &&
        tileX <= bbox.maxTileX &&
        tileZ >= bbox.minTileZ &&
        tileZ <= bbox.maxTileZ
      ) {
        isInBoundingBox = true;
        bboxBuildingId = building.buildingId;
        break;
      }
    }

    // Check if step tile
    const stepTile = this.tileToStepTile.get(key);

    // Check if door tile
    let isDoorTile = false;
    if (buildingId) {
      const building = this.buildings.get(buildingId);
      const floor = building?.floors.find((f) => f.floorIndex === floorIndex);
      if (floor) {
        isDoorTile = floor.wallSegments.some(
          (w) =>
            w.tileX === tileX &&
            w.tileZ === tileZ &&
            w.hasOpening &&
            (w.openingType === "door" || w.openingType === "arch"),
        );
      }
    }

    // Get ACTUAL CollisionMatrix wall flags (ground floor only)
    const collisionMatrix = this.world.collision as CollisionMatrix;
    const matrixFlags = collisionMatrix?.getFlags(tileX, tileZ) ?? 0;
    const collisionMatrixWallFlags = {
      north: (matrixFlags & CollisionFlag.WALL_NORTH) !== 0,
      south: (matrixFlags & CollisionFlag.WALL_SOUTH) !== 0,
      east: (matrixFlags & CollisionFlag.WALL_EAST) !== 0,
      west: (matrixFlags & CollisionFlag.WALL_WEST) !== 0,
    };

    // ACTUAL movement blocking tests using isWallBlocked
    // This is the REAL test - does movement actually get blocked?
    const blocksMovementNorth = this.isWallBlocked(
      tileX,
      tileZ,
      tileX,
      tileZ - 1,
      floorIndex,
    );
    const blocksMovementSouth = this.isWallBlocked(
      tileX,
      tileZ,
      tileX,
      tileZ + 1,
      floorIndex,
    );
    const blocksMovementEast = this.isWallBlocked(
      tileX,
      tileZ,
      tileX + 1,
      tileZ,
      floorIndex,
    );
    const blocksMovementWest = this.isWallBlocked(
      tileX,
      tileZ,
      tileX - 1,
      tileZ,
      floorIndex,
    );

    return {
      isWalkable: this.isTileWalkableInBuilding(tileX, tileZ, floorIndex),
      isInBuilding: collision.isInsideBuilding,
      buildingId: buildingId ?? bboxBuildingId,
      isInBoundingBox,
      isInFootprint: buildingId !== null,
      hasWallFlags: collision.wallBlocking,
      collisionMatrixWallFlags,
      isStepTile: stepTile !== undefined,
      isDoorTile,
      blocksMovementNorth,
      blocksMovementSouth,
      blocksMovementEast,
      blocksMovementWest,
    };
  }

  /**
   * Get all buildings that a tile could be associated with.
   * Useful for diagnosing overlapping building issues.
   */
  getBuildingsAtTile(
    tileX: number,
    tileZ: number,
  ): Array<{
    buildingId: string;
    isInFootprint: boolean;
    isInBoundingBox: boolean;
    floorIndex: number | null;
  }> {
    const results: Array<{
      buildingId: string;
      isInFootprint: boolean;
      isInBoundingBox: boolean;
      floorIndex: number | null;
    }> = [];

    const key = tileKey(tileX, tileZ);
    const footprintBuildings = this.tileToBuildings.get(key);

    // Check footprint index
    if (footprintBuildings) {
      for (const buildingId of footprintBuildings) {
        const building = this.buildings.get(buildingId);
        if (building) {
          // Find which floor this tile is on
          let floorIndex: number | null = null;
          for (const floor of building.floors) {
            if (floor.walkableTiles.has(key)) {
              floorIndex = floor.floorIndex;
              break;
            }
          }
          results.push({
            buildingId,
            isInFootprint: true,
            isInBoundingBox: true,
            floorIndex,
          });
        }
      }
    }

    // Check bounding boxes for buildings not in footprint
    for (const building of this.buildings.values()) {
      // Skip if already found via footprint
      if (results.some((r) => r.buildingId === building.buildingId)) continue;

      const bbox = building.boundingBox;
      if (
        tileX >= bbox.minTileX &&
        tileX <= bbox.maxTileX &&
        tileZ >= bbox.minTileZ &&
        tileZ <= bbox.maxTileZ
      ) {
        results.push({
          buildingId: building.buildingId,
          isInFootprint: false,
          isInBoundingBox: true,
          floorIndex: null,
        });
      }
    }

    return results;
  }
}
