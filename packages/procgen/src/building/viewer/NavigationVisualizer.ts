/**
 * Navigation Visualizer for Building/Town Viewer
 *
 * Provides visual debugging for building navigation:
 * - Walkable tiles (per floor)
 * - Door openings (entry/exit points)
 * - Stair tiles (floor transitions)
 * - Wall blocking visualization
 * - A→B pathfinding with BFS
 * - Demo paths showing outside→inside navigation
 *
 * **UNIFIED WITH ENGINE:** Uses @hyperforge/shared systems (BFSPathfinder, types)
 * so testing here tests the same code the game uses.
 */

import * as THREE from "three";
import type {
  BuildingLayout,
  FloorPlan,
  StairPlacement,
} from "../generator/types.js";
import type { GeneratedTown } from "../town/types.js";
import {
  CELL_SIZE,
  TILES_PER_CELL,
  FLOOR_HEIGHT,
  FOUNDATION_HEIGHT,
  getSideVector,
} from "../generator/constants.js";

// ============================================================================
// IMPORTS FROM @hyperforge/shared (ENGINE SYSTEMS)
// ============================================================================

import {
  // Engine pathfinder - SAME CODE AS THE GAME
  BFSPathfinder,
  // Types
  type TileCoord,
  // Building collision types and utilities
  type WallDirection,
  type WallSegment,
  type StairTile,
  type FloorCollisionData,
  cellToWorldTile,
  rotateWallDirection,
  getOppositeDirection,
  toWallDirection,
  buildingTileKey as tileKey,
  // Tile utilities - use shared implementation instead of duplicating
  parseTileKey,
} from "@hyperforge/shared";

// ============================================================================
// LOCAL TYPES (visualization-specific, not in shared)
// ============================================================================

/** Extended floor collision data with exterior tiles for visualization */
interface FloorCollisionDataWithExterior extends FloorCollisionData {
  exteriorTiles: Set<string>; // Ground tiles outside the building
}

/** Building collision data for visualization */
interface BuildingCollisionData {
  buildingId: string;
  worldPosition: { x: number; y: number; z: number };
  rotation: number;
  cellWidth: number;
  cellDepth: number;
  floors: FloorCollisionDataWithExterior[];
  groundElevation: number; // Ground level (without foundation)
  boundingBox: {
    minTileX: number;
    maxTileX: number;
    minTileZ: number;
    maxTileZ: number;
  };
}

/** Visualization options */
export interface NavigationVisualizerOptions {
  showWalkableTiles: boolean;
  showDoors: boolean;
  showStairs: boolean;
  showWalls: boolean;
  showEntryPoints: boolean;
  showDemoPaths: boolean;
}

/** Click state for A→B pathfinding */
interface ClickState {
  pointA: TileCoord | null;
  pointB: TileCoord | null;
}

/** Tile coordinate with floor information */
interface MultiFloorTile extends TileCoord {
  floor: number;
}

/** A segment of a multi-floor path on a single floor */
interface MultiFloorPathSegment {
  floorIndex: number;
  elevation: number;
  tiles: TileCoord[];
  endsAtStair: boolean;
  stairDirection?: WallDirection;
}

/** Complete multi-floor path */
interface MultiFloorPath {
  segments: MultiFloorPathSegment[];
  totalTiles: number;
}

/** Result of creating a walkability checker - includes both the function and wall data for validation */
interface WalkabilityCheckerResult {
  isWalkable: (tile: TileCoord, fromTile?: TileCoord) => boolean;
  wallLookup: Map<string, Set<WallDirection>>;
}

// ============================================================================
// COLORS
// ============================================================================

const COLORS = {
  WALKABLE_FLOOR_0: 0x00ff00, // Green - ground floor interior
  WALKABLE_FLOOR_1: 0x00cc00, // Lighter green - upper floors
  EXTERIOR_TILE: 0x336633, // Gray-green - ground outside building
  NON_WALKABLE: 0xff0000, // Red - blocked
  DOOR: 0x00ffff, // Cyan - door openings
  STAIR: 0xff00ff, // Magenta - stairs
  WALL_NORTH: 0xff8800,
  WALL_SOUTH: 0xff6600,
  WALL_EAST: 0xff4400,
  WALL_WEST: 0xff2200,
  ENTRY_POINT: 0xffff00, // Yellow - entry markers
  PATH_LINE: 0x0088ff, // Blue - path line
  PATH_TILE: 0xffaa00, // Orange - path tiles
  POINT_A: 0x00ffff, // Cyan - start point
  POINT_B: 0xff00ff, // Magenta - end point
  OUTSIDE_TILE: 0x004400, // Dark green - outside building
};

// ============================================================================
// COORDINATE HELPERS
// ============================================================================

/**
 * Get opposite wall direction (wrapper for shared function)
 */
function getOppositeWallDirection(dir: WallDirection): WallDirection {
  return getOppositeDirection(dir);
}

// ============================================================================
// COLLISION DATA GENERATION
// ============================================================================

/**
 * Check if rotation is a valid 90-degree increment (0, π/2, π, 3π/2)
 * Wall positioning assumes axis-aligned cells - arbitrary rotations are NOT supported.
 */
function isValidRotation(rotation: number): boolean {
  const normalized = ((rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const tolerance = 0.01; // Allow small floating point errors
  const validAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  return validAngles.some((angle) => Math.abs(normalized - angle) < tolerance);
}

/**
 * Generate collision data from a building layout
 *
 * NOTE: Only 0/90/180/270 degree rotations are supported.
 * Arbitrary rotations will produce incorrect wall positions.
 */
function generateCollisionData(
  buildingId: string,
  layout: BuildingLayout,
  worldPosition: { x: number; y: number; z: number },
  rotation: number,
): BuildingCollisionData {
  // Validate rotation is a 90-degree increment
  if (!isValidRotation(rotation)) {
    console.warn(
      `[NavigationVisualizer] Building "${buildingId}" has non-90-degree rotation (${(rotation * 180) / Math.PI}°). ` +
        `Wall collision data may be incorrect. Only 0°, 90°, 180°, 270° rotations are supported.`,
    );
  }

  const floors: FloorCollisionDataWithExterior[] = [];
  let minTileX = Infinity;
  let maxTileX = -Infinity;
  let minTileZ = Infinity;
  let maxTileZ = -Infinity;

  for (let floorIndex = 0; floorIndex < layout.floors; floorIndex++) {
    const floorPlan = layout.floorPlans[floorIndex];
    if (!floorPlan) continue;

    const floorData = generateFloorCollisionData(
      floorIndex,
      floorPlan,
      layout,
      worldPosition,
      rotation,
    );

    floors.push(floorData);

    // Update bounding box
    for (const key of floorData.walkableTiles) {
      const { x, z } = parseTileKey(key);
      minTileX = Math.min(minTileX, x);
      maxTileX = Math.max(maxTileX, x);
      minTileZ = Math.min(minTileZ, z);
      maxTileZ = Math.max(maxTileZ, z);
    }
  }

  // Add exterior walkable tiles around the building (ground floor only)
  // This allows pathfinding from outside to inside
  const floor0 = floors[0];
  if (floor0) {
    const padding = 8; // tiles around building that are walkable
    for (let x = minTileX - padding; x <= maxTileX + padding; x++) {
      for (let z = minTileZ - padding; z <= maxTileZ + padding; z++) {
        const key = tileKey(x, z);
        // Only add if not already an interior tile
        if (!floor0.walkableTiles.has(key)) {
          floor0.exteriorTiles.add(key);
        }
      }
    }
  }

  return {
    buildingId,
    worldPosition,
    rotation,
    cellWidth: layout.width,
    cellDepth: layout.depth,
    floors,
    groundElevation: worldPosition.y, // Ground level without foundation
    boundingBox: { minTileX, maxTileX, minTileZ, maxTileZ },
  };
}

/**
 * Generate collision data for a single floor
 */
function generateFloorCollisionData(
  floorIndex: number,
  floorPlan: FloorPlan,
  layout: BuildingLayout,
  worldPosition: { x: number; y: number; z: number },
  rotation: number,
): FloorCollisionDataWithExterior {
  const walkableTiles = new Set<string>();
  const exteriorTiles = new Set<string>(); // Will be populated later for floor 0
  const wallSegments: WallSegment[] = [];
  const stairTiles: StairTile[] = [];

  const elevation =
    worldPosition.y + FOUNDATION_HEIGHT + floorIndex * FLOOR_HEIGHT;
  const tilesPerCell = TILES_PER_CELL;

  // Process each cell in the footprint
  for (let row = 0; row < floorPlan.footprint.length; row++) {
    for (let col = 0; col < floorPlan.footprint[row].length; col++) {
      if (!floorPlan.footprint[row][col]) continue;

      // Get center tile of this cell using shared utility
      const centerTile = cellToWorldTile(
        { col, row },
        worldPosition.x,
        worldPosition.z,
        layout.width,
        layout.depth,
        rotation,
        CELL_SIZE,
      );

      // Register all tiles within this cell as walkable
      const halfTiles = Math.floor(tilesPerCell / 2);
      for (let dtx = -halfTiles; dtx < tilesPerCell - halfTiles; dtx++) {
        for (let dtz = -halfTiles; dtz < tilesPerCell - halfTiles; dtz++) {
          walkableTiles.add(tileKey(centerTile.x + dtx, centerTile.z + dtz));
        }
      }

      // Generate walls for this cell
      const cellWalls = generateCellWalls(
        col,
        row,
        floorPlan,
        worldPosition,
        rotation,
        layout.width,
        layout.depth,
      );
      wallSegments.push(...cellWalls);
    }
  }

  // Process stairs on this floor
  if (layout.stairs && floorIndex < layout.floors - 1) {
    const stairData = generateStairTiles(
      layout.stairs,
      floorIndex,
      worldPosition,
      rotation,
      layout.width,
      layout.depth,
    );
    stairTiles.push(...stairData);
  }

  return {
    floorIndex,
    elevation,
    walkableTiles,
    exteriorTiles,
    wallSegments,
    stairTiles,
  };
}

/**
 * Generate wall segments for a cell
 *
 * IMPORTANT: Each cell is TILES_PER_CELL x TILES_PER_CELL tiles (typically 4x4).
 * Walls must be registered for ALL tiles along the cell edge, not just the center.
 * Otherwise paths can slip through tiles that don't have wall data.
 */
function generateCellWalls(
  col: number,
  row: number,
  floorPlan: FloorPlan,
  worldPosition: { x: number; y: number; z: number },
  rotation: number,
  buildingWidth: number,
  buildingDepth: number,
): WallSegment[] {
  const walls: WallSegment[] = [];
  const directions: Array<{ dir: WallDirection; dc: number; dr: number }> = [
    { dir: "north", dc: 0, dr: -1 },
    { dir: "south", dc: 0, dr: 1 },
    { dir: "east", dc: 1, dr: 0 },
    { dir: "west", dc: -1, dr: 0 },
  ];

  // Get center tile of this cell using shared utility
  const centerTile = cellToWorldTile(
    { col, row },
    worldPosition.x,
    worldPosition.z,
    buildingWidth,
    buildingDepth,
    rotation,
    CELL_SIZE,
  );

  // Calculate tile offsets for the cell (cell is TILES_PER_CELL x TILES_PER_CELL)
  const halfTiles = Math.floor(TILES_PER_CELL / 2);

  for (const { dir, dc, dr } of directions) {
    const neighborCol = col + dc;
    const neighborRow = row + dr;

    // Check if there's a cell on this side
    const hasNeighbor =
      neighborRow >= 0 &&
      neighborRow < floorPlan.footprint.length &&
      neighborCol >= 0 &&
      neighborCol < (floorPlan.footprint[neighborRow]?.length ?? 0) &&
      floorPlan.footprint[neighborRow]?.[neighborCol];

    // Determine wall properties
    let hasWall = false;
    let hasOpening = false;
    let openingType: "door" | "arch" | "window" | undefined;

    if (hasNeighbor) {
      // Internal wall - check for openings
      const openingKey = `${col},${row},${dir}`;
      const opening = floorPlan.internalOpenings.get(openingKey);

      if (!opening) {
        // Solid internal wall - check room boundaries
        const currentRoom = floorPlan.roomMap[row]?.[col] ?? -1;
        const neighborRoom =
          floorPlan.roomMap[neighborRow]?.[neighborCol] ?? -1;

        if (currentRoom !== neighborRoom) {
          hasWall = true;
        }
      } else {
        hasWall = true;
        hasOpening = true;
        openingType = opening === "door" ? "door" : "arch";
      }
    } else {
      // External wall - always has a wall
      hasWall = true;
      const openingKey = `${col},${row},${dir}`;
      const opening = floorPlan.externalOpenings.get(openingKey);
      if (opening && (opening === "door" || opening === "arch")) {
        hasOpening = true;
        openingType = opening === "door" ? "door" : "arch";
      } else if (opening === "window") {
        // Windows are walls (not openings for walking)
        openingType = "window";
      }
    }

    if (!hasWall) continue;

    // Get the rotated wall direction using shared utility
    const worldDir = rotateWallDirection(dir, rotation);

    // Register wall for ALL tiles along this edge of the cell
    // IMPORTANT: Doors/openings should only be on CENTER tiles, not all edge tiles!
    for (
      let offset = -halfTiles;
      offset < TILES_PER_CELL - halfTiles;
      offset++
    ) {
      let tileX = centerTile.x;
      let tileZ = centerTile.z;

      // Determine which tiles are on this edge based on direction
      if (worldDir === "north" || worldDir === "south") {
        tileX = centerTile.x + offset;
        if (worldDir === "north") {
          tileZ = centerTile.z - halfTiles;
        } else {
          tileZ = centerTile.z + (TILES_PER_CELL - halfTiles - 1);
        }
      } else {
        tileZ = centerTile.z + offset;
        if (worldDir === "west") {
          tileX = centerTile.x - halfTiles;
        } else {
          tileX = centerTile.x + (TILES_PER_CELL - halfTiles - 1);
        }
      }

      // Doors/arches should only be on the CENTER tiles
      const centerStart = -Math.floor(TILES_PER_CELL / 4);
      const centerEnd = Math.ceil(TILES_PER_CELL / 4) - 1;
      const isCenterTile = offset >= centerStart && offset <= centerEnd;
      const tileHasOpening = hasOpening && isCenterTile;

      walls.push({
        tileX,
        tileZ,
        side: worldDir,
        hasOpening: tileHasOpening,
        openingType: tileHasOpening ? openingType : undefined,
      });
    }
  }

  return walls;
}

/**
 * Generate stair tiles
 */
function generateStairTiles(
  stairs: StairPlacement,
  floorIndex: number,
  worldPosition: { x: number; y: number; z: number },
  rotation: number,
  buildingWidth: number,
  buildingDepth: number,
): StairTile[] {
  const tiles: StairTile[] = [];
  const direction = toWallDirection(stairs.direction);

  // Bottom of stairs (departure tile) using shared utility
  const bottomTile = cellToWorldTile(
    { col: stairs.col, row: stairs.row },
    worldPosition.x,
    worldPosition.z,
    buildingWidth,
    buildingDepth,
    rotation,
    CELL_SIZE,
  );

  tiles.push({
    tileX: bottomTile.x,
    tileZ: bottomTile.z,
    fromFloor: floorIndex,
    toFloor: floorIndex + 1,
    direction: rotateWallDirection(direction, rotation),
    isLanding: false,
  });

  // Top of stairs (landing tile) using shared utility
  const landingTile = cellToWorldTile(
    { col: stairs.landing.col, row: stairs.landing.row },
    worldPosition.x,
    worldPosition.z,
    buildingWidth,
    buildingDepth,
    rotation,
    CELL_SIZE,
  );

  tiles.push({
    tileX: landingTile.x,
    tileZ: landingTile.z,
    fromFloor: floorIndex,
    toFloor: floorIndex + 1,
    direction: rotateWallDirection(direction, rotation),
    isLanding: true,
  });

  return tiles;
}

// ============================================================================
// PATHFINDING USING ENGINE BFSPathfinder
// ============================================================================

/**
 * Singleton BFSPathfinder instance - SAME CODE AS THE GAME ENGINE
 */
const enginePathfinder = new BFSPathfinder();

/**
 * Validate a path doesn't go through any walls
 * @throws Error if any step in the path goes through a wall
 */
function validatePath(
  path: TileCoord[],
  start: TileCoord,
  isWalkable: (tile: TileCoord, fromTile?: TileCoord) => boolean,
  wallLookup: Map<string, Set<WallDirection>>,
): void {
  if (path.length === 0) return;

  const fullPath = [start, ...path];

  for (let i = 0; i < fullPath.length - 1; i++) {
    const from = fullPath[i];
    const to = fullPath[i + 1];

    if (!isWalkable(to, from)) {
      const toKey = tileKey(to.x, to.z);
      const fromKey = tileKey(from.x, from.z);
      const toWalls = wallLookup.get(toKey);
      const fromWalls = wallLookup.get(fromKey);

      const dx = to.x - from.x;
      const dz = to.z - from.z;

      let moveDesc = "";
      if (dx === 0 && dz === 1) moveDesc = "south (dz=+1)";
      else if (dx === 0 && dz === -1) moveDesc = "north (dz=-1)";
      else if (dx === 1 && dz === 0) moveDesc = "east (dx=+1)";
      else if (dx === -1 && dz === 0) moveDesc = "west (dx=-1)";
      else moveDesc = `diagonal (dx=${dx}, dz=${dz})`;

      throw new Error(
        `PATH VALIDATION ERROR: Path step ${i} goes through wall!\n` +
          `  From: (${from.x}, ${from.z}) walls: [${fromWalls ? [...fromWalls].join(", ") : "none"}]\n` +
          `  To: (${to.x}, ${to.z}) walls: [${toWalls ? [...toWalls].join(", ") : "none"}]\n` +
          `  Direction: ${moveDesc}\n` +
          `  This is a bug in the pathfinding or wall detection logic.`,
      );
    }

    // Validate diagonal corner clipping
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    if (Math.abs(dx) === 1 && Math.abs(dz) === 1) {
      const cardinalX: TileCoord = { x: from.x + dx, z: from.z };
      const cardinalZ: TileCoord = { x: from.x, z: from.z + dz };

      if (!isWalkable(cardinalX, from) || !isWalkable(cardinalZ, from)) {
        throw new Error(
          `PATH VALIDATION ERROR: Diagonal step ${i} clips through corner!\n` +
            `  From: (${from.x}, ${from.z})\n` +
            `  To: (${to.x}, ${to.z})\n` +
            `  Cardinal X (${cardinalX.x}, ${cardinalX.z}) walkable: ${isWalkable(cardinalX, from)}\n` +
            `  Cardinal Z (${cardinalZ.x}, ${cardinalZ.z}) walkable: ${isWalkable(cardinalZ, from)}`,
        );
      }
    }
  }
}

// ============================================================================
// MULTI-FLOOR PATHFINDING
// ============================================================================

/**
 * Find a path that can span multiple floors using stairs
 */
function findMultiFloorPath(
  start: MultiFloorTile,
  end: MultiFloorTile,
  floors: FloorCollisionDataWithExterior[],
  createChecker: (floorIndex: number) => WalkabilityCheckerResult,
): MultiFloorPath | null {
  const segments: MultiFloorPathSegment[] = [];
  let currentTile: TileCoord = { x: start.x, z: start.z };
  let currentFloor = start.floor;

  const maxFloorTransitions = floors.length * 2;
  let transitions = 0;

  while (transitions < maxFloorTransitions) {
    transitions++;

    const floor = floors[currentFloor];
    if (!floor) {
      console.error(`[MultiFloorPath] Floor ${currentFloor} not found`);
      return null;
    }

    const checker = createChecker(currentFloor);

    // Are we on the destination floor?
    if (currentFloor === end.floor) {
      // Use engine BFSPathfinder
      const path = enginePathfinder.findPath(
        currentTile,
        { x: end.x, z: end.z },
        checker.isWalkable,
      );

      if (
        path.length === 0 &&
        (currentTile.x !== end.x || currentTile.z !== end.z)
      ) {
        console.warn(
          `[MultiFloorPath] Can't reach destination on floor ${currentFloor}`,
        );
        return null;
      }

      segments.push({
        floorIndex: currentFloor,
        elevation: floor.elevation,
        tiles: [currentTile, ...path],
        endsAtStair: false,
      });

      const totalTiles = segments.reduce(
        (sum, seg) => sum + seg.tiles.length,
        0,
      );
      return { segments, totalTiles };
    }

    // Need to change floors - find stairs
    const targetFloorHigher = end.floor > currentFloor;
    const stairTiles = floor.stairTiles;

    let targetStair: StairTile | null = null;
    for (const stair of stairTiles) {
      if (targetFloorHigher) {
        if (
          !stair.isLanding &&
          stair.fromFloor === currentFloor &&
          stair.toFloor > currentFloor
        ) {
          targetStair = stair;
          break;
        }
      } else {
        if (
          stair.isLanding &&
          stair.toFloor === currentFloor &&
          stair.fromFloor < currentFloor
        ) {
          targetStair = stair;
          break;
        }
      }
    }

    if (!targetStair) {
      for (const stair of stairTiles) {
        if (targetFloorHigher) {
          if (!stair.isLanding && stair.fromFloor === currentFloor) {
            targetStair = stair;
            break;
          }
        } else {
          if (stair.isLanding && stair.toFloor === currentFloor) {
            targetStair = stair;
            break;
          }
        }
      }
    }

    if (!targetStair) {
      console.warn(
        `[MultiFloorPath] No stair found on floor ${currentFloor} to reach floor ${end.floor}`,
      );
      return null;
    }

    // Find path to stair using engine BFSPathfinder
    const stairTile: TileCoord = { x: targetStair.tileX, z: targetStair.tileZ };
    const pathToStair = enginePathfinder.findPath(
      currentTile,
      stairTile,
      checker.isWalkable,
    );

    if (
      pathToStair.length === 0 &&
      (currentTile.x !== stairTile.x || currentTile.z !== stairTile.z)
    ) {
      console.warn(
        `[MultiFloorPath] Can't reach stair at (${stairTile.x}, ${stairTile.z})`,
      );
      return null;
    }

    segments.push({
      floorIndex: currentFloor,
      elevation: floor.elevation,
      tiles: [currentTile, ...pathToStair],
      endsAtStair: true,
      stairDirection: targetStair.direction,
    });

    // Transition to next floor
    const nextFloorIndex = targetFloorHigher
      ? targetStair.toFloor
      : targetStair.fromFloor;
    const nextFloor = floors[nextFloorIndex];
    if (!nextFloor) {
      console.warn(`[MultiFloorPath] Next floor ${nextFloorIndex} not found`);
      return null;
    }

    const matchingStair = nextFloor.stairTiles.find((s) => {
      if (s.direction !== targetStair!.direction) return false;
      if (
        s.fromFloor !== targetStair!.fromFloor ||
        s.toFloor !== targetStair!.toFloor
      )
        return false;
      return targetFloorHigher ? s.isLanding : !s.isLanding;
    });

    if (matchingStair) {
      currentTile = { x: matchingStair.tileX, z: matchingStair.tileZ };
    } else {
      const dirVec = getSideVector(targetStair.direction);
      if (targetFloorHigher) {
        currentTile = {
          x: targetStair.tileX + dirVec.x * TILES_PER_CELL,
          z: targetStair.tileZ + dirVec.z * TILES_PER_CELL,
        };
      } else {
        currentTile = {
          x: targetStair.tileX - dirVec.x * TILES_PER_CELL,
          z: targetStair.tileZ - dirVec.z * TILES_PER_CELL,
        };
      }
    }
    currentFloor = nextFloorIndex;
  }

  console.error(
    "[MultiFloorPath] Too many floor transitions - possible infinite loop",
  );
  return null;
}

// ============================================================================
// NAVIGATION VISUALIZER CLASS
// ============================================================================

export class NavigationVisualizer {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private raycaster: THREE.Raycaster;
  private groundPlane: THREE.Plane;

  // Visualization groups
  private visualizationGroup: THREE.Group;
  private pathGroup: THREE.Group;
  private markerGroup: THREE.Group;

  // Shared geometries
  private tileGeometry: THREE.PlaneGeometry;
  private wallGeometry: THREE.BoxGeometry;
  private markerGeometry: THREE.SphereGeometry;

  // Materials cache
  private materials: Map<number, THREE.MeshBasicMaterial> = new Map();

  // State
  private collisionData: BuildingCollisionData | null = null;
  private options: NavigationVisualizerOptions;
  private clickState: ClickState = { pointA: null, pointB: null };
  private enabled = false;

  // Town mode
  private townData: GeneratedTown | null = null;
  private selectedBuildingIndex = -1;
  private buildingCollisionDataCache: Map<number, BuildingCollisionData> =
    new Map();

  // Callbacks for React integration
  private onPathUpdate?: (pathInfo: {
    start: TileCoord | null;
    end: TileCoord | null;
    length: number;
    partial: boolean;
  }) => void;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.visualizationGroup = new THREE.Group();
    this.visualizationGroup.name = "NavigationVisualization";

    this.pathGroup = new THREE.Group();
    this.pathGroup.name = "NavigationPaths";

    this.markerGroup = new THREE.Group();
    this.markerGroup.name = "NavigationMarkers";

    this.tileGeometry = new THREE.PlaneGeometry(0.9, 0.9);
    this.wallGeometry = new THREE.BoxGeometry(0.1, 0.5, 1.0);
    this.markerGeometry = new THREE.SphereGeometry(0.3, 16, 16);

    this.options = {
      showWalkableTiles: true,
      showDoors: true,
      showStairs: true,
      showWalls: true,
      showEntryPoints: true,
      showDemoPaths: true,
    };
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Set callback for path updates (for React state sync)
   */
  setPathUpdateCallback(
    callback: (pathInfo: {
      start: TileCoord | null;
      end: TileCoord | null;
      length: number;
      partial: boolean;
    }) => void,
  ): void {
    this.onPathUpdate = callback;
  }

  /**
   * Set building layout for visualization
   */
  setBuilding(
    layout: BuildingLayout,
    worldPosition: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
    rotation: number = 0,
  ): void {
    this.townData = null;
    this.selectedBuildingIndex = -1;
    this.buildingCollisionDataCache.clear();

    this.collisionData = generateCollisionData(
      "viewer-building",
      layout,
      worldPosition,
      rotation,
    );

    if (this.enabled) {
      this.updateVisualization();
    }
  }

  /**
   * Set town for visualization (with building selection)
   */
  setTown(
    town: GeneratedTown,
    buildingGenerator: {
      generate: (
        type: string,
        opts: { seed: string },
      ) => { layout: BuildingLayout } | null;
    },
  ): void {
    this.townData = town;
    this.collisionData = null;
    this.selectedBuildingIndex = -1;
    this.buildingCollisionDataCache.clear();

    // Pre-generate collision data for all buildings
    for (let i = 0; i < town.buildings.length; i++) {
      const building = town.buildings[i];
      const seed = `nav_${town.id}_${building.id}`;
      const result = buildingGenerator.generate(building.type, { seed });

      if (result) {
        const collisionData = generateCollisionData(
          building.id,
          result.layout,
          { x: building.position.x, y: 0, z: building.position.z },
          building.rotation,
        );
        this.buildingCollisionDataCache.set(i, collisionData);
      }
    }

    if (this.enabled) {
      this.updateVisualization();
    }
  }

  /**
   * Select a building in town mode
   */
  selectBuilding(index: number): void {
    if (!this.townData) return;

    this.selectedBuildingIndex = index;
    this.collisionData = this.buildingCollisionDataCache.get(index) ?? null;

    if (this.enabled) {
      this.updateVisualization();
    }
  }

  /**
   * Enable/disable visualization
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;

    if (enabled) {
      this.scene.add(this.visualizationGroup);
      this.scene.add(this.pathGroup);
      this.scene.add(this.markerGroup);
      this.updateVisualization();
    } else {
      this.scene.remove(this.visualizationGroup);
      this.scene.remove(this.pathGroup);
      this.scene.remove(this.markerGroup);
      this.clearVisualization();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Update visualization options
   */
  setOptions(options: Partial<NavigationVisualizerOptions>): void {
    this.options = { ...this.options, ...options };
    if (this.enabled) {
      this.updateVisualization();
    }
  }

  getOptions(): NavigationVisualizerOptions {
    return { ...this.options };
  }

  /**
   * Handle mouse click for A→B pathfinding
   */
  handleClick(
    event: MouseEvent,
    canvas: HTMLCanvasElement,
    button: number,
  ): void {
    if (!this.enabled || !this.collisionData) return;

    const rect = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );

    this.raycaster.setFromCamera(mouse, this.camera);
    const target = new THREE.Vector3();

    const elevation = this.collisionData.floors[0]?.elevation ?? 0;
    this.groundPlane.constant = -elevation;

    const ray = this.raycaster.ray;
    const hit = ray.intersectPlane(this.groundPlane, target);

    if (!hit) return;

    const tile: TileCoord = {
      x: Math.floor(target.x),
      z: Math.floor(target.z),
    };

    if (button === 0) {
      this.clickState.pointA = tile;
    } else if (button === 2) {
      this.clickState.pointB = tile;
    }

    this.updateMarkers();
    this.updateUserPath();
  }

  /**
   * Clear A→B path
   */
  clearUserPath(): void {
    this.clickState = { pointA: null, pointB: null };
    this.clearMarkers();
    this.clearPath("user-path");
    this.onPathUpdate?.({ start: null, end: null, length: 0, partial: false });
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    this.clearVisualization();
    this.tileGeometry.dispose();
    this.wallGeometry.dispose();
    this.markerGeometry.dispose();

    for (const material of this.materials.values()) {
      material.dispose();
    }
    this.materials.clear();

    this.scene.remove(this.visualizationGroup);
    this.scene.remove(this.pathGroup);
    this.scene.remove(this.markerGroup);
  }

  // ===========================================================================
  // VISUALIZATION
  // ===========================================================================

  private updateVisualization(): void {
    this.clearVisualization();

    if (!this.collisionData) {
      if (this.townData) {
        this.visualizeTownOverview();
      }
      return;
    }

    for (const floor of this.collisionData.floors) {
      if (this.options.showWalkableTiles) {
        this.visualizeWalkableTiles(floor, this.collisionData.groundElevation);
      }

      if (this.options.showWalls) {
        this.visualizeWalls(floor);
      }

      if (this.options.showDoors) {
        this.visualizeDoors(floor);
      }

      if (this.options.showStairs) {
        this.visualizeStairs(floor);
      }
    }

    if (this.options.showEntryPoints) {
      this.visualizeEntryPoints();
    }

    if (this.options.showDemoPaths) {
      this.visualizeDemoPaths();
    }
  }

  private clearVisualization(): void {
    while (this.visualizationGroup.children.length > 0) {
      const child = this.visualizationGroup.children[0];
      this.visualizationGroup.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    }

    while (this.pathGroup.children.length > 0) {
      const child = this.pathGroup.children[0];
      this.pathGroup.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
      }
    }
  }

  private clearMarkers(): void {
    while (this.markerGroup.children.length > 0) {
      const child = this.markerGroup.children[0];
      this.markerGroup.remove(child);
    }
  }

  private clearPath(name: string): void {
    const toRemove: THREE.Object3D[] = [];
    this.pathGroup.traverse((child) => {
      if (child.name === name) {
        toRemove.push(child);
      }
    });
    for (const obj of toRemove) {
      this.pathGroup.remove(obj);
      if (obj instanceof THREE.Line) {
        obj.geometry.dispose();
      }
    }
  }

  // ===========================================================================
  // VISUALIZATION HELPERS
  // ===========================================================================

  private visualizeTownOverview(): void {
    if (!this.townData) return;

    for (let i = 0; i < this.townData.buildings.length; i++) {
      const building = this.townData.buildings[i];
      const collisionData = this.buildingCollisionDataCache.get(i);

      if (!collisionData) continue;

      const isSelected = i === this.selectedBuildingIndex;
      const color = isSelected ? 0xffff00 : 0x888888;

      const { minTileX, maxTileX, minTileZ, maxTileZ } =
        collisionData.boundingBox;
      const width = maxTileX - minTileX + 1;
      const depth = maxTileZ - minTileZ + 1;

      const outlineGeo = new THREE.PlaneGeometry(width, depth);
      const outlineMat = this.getMaterial(color);
      outlineMat.opacity = isSelected ? 0.5 : 0.2;
      const outline = new THREE.Mesh(outlineGeo, outlineMat);
      outline.rotation.x = -Math.PI / 2;
      outline.position.set(
        (minTileX + maxTileX) / 2 + 0.5,
        0.02,
        (minTileZ + maxTileZ) / 2 + 0.5,
      );
      outline.name = `building-outline-${i}`;
      this.visualizationGroup.add(outline);

      if (building.entrance) {
        const entranceGeo = new THREE.CircleGeometry(0.5, 16);
        const entranceMat = this.getMaterial(COLORS.DOOR);
        const entrance = new THREE.Mesh(entranceGeo, entranceMat);
        entrance.rotation.x = -Math.PI / 2;
        entrance.position.set(
          building.entrance.x - this.townData.position.x,
          0.05,
          building.entrance.z - this.townData.position.z,
        );
        this.visualizationGroup.add(entrance);
      }
    }
  }

  private visualizeWalkableTiles(
    floor: FloorCollisionDataWithExterior,
    groundElevation: number,
  ): void {
    const interiorColor =
      floor.floorIndex === 0
        ? COLORS.WALKABLE_FLOOR_0
        : COLORS.WALKABLE_FLOOR_1;
    const floorY = floor.elevation + 0.02;

    for (const key of floor.walkableTiles) {
      const { x, z } = parseTileKey(key);
      this.addTileMesh(x, floorY, z, interiorColor);
    }

    if (floor.floorIndex === 0 && floor.exteriorTiles.size > 0) {
      const groundY = groundElevation + 0.02;
      for (const key of floor.exteriorTiles) {
        const { x, z } = parseTileKey(key);
        this.addTileMesh(x, groundY, z, COLORS.EXTERIOR_TILE);
      }
    }
  }

  private visualizeWalls(floor: FloorCollisionDataWithExterior): void {
    const y = floor.elevation + 0.25;

    for (const wall of floor.wallSegments) {
      if (wall.hasOpening) continue;

      const colorMap: Record<WallDirection, number> = {
        north: COLORS.WALL_NORTH,
        south: COLORS.WALL_SOUTH,
        east: COLORS.WALL_EAST,
        west: COLORS.WALL_WEST,
      };

      this.addWallIndicator(
        wall.tileX,
        wall.tileZ,
        y,
        wall.side,
        colorMap[wall.side],
      );
    }
  }

  private visualizeDoors(floor: FloorCollisionDataWithExterior): void {
    const y = floor.elevation + 0.25;

    for (const wall of floor.wallSegments) {
      if (!wall.hasOpening || wall.openingType === "window") continue;

      this.addWallIndicator(wall.tileX, wall.tileZ, y, wall.side, COLORS.DOOR);
    }
  }

  private visualizeStairs(floor: FloorCollisionDataWithExterior): void {
    if (!this.collisionData) return;

    for (const stair of floor.stairTiles) {
      let stairY: number;
      if (stair.isLanding) {
        const nextFloor = this.collisionData.floors[stair.toFloor];
        stairY = nextFloor
          ? nextFloor.elevation
          : floor.elevation + FLOOR_HEIGHT;
      } else {
        stairY = floor.elevation;
      }

      const stepGeo = new THREE.BoxGeometry(0.8, 0.3, 0.8);
      const stepMat = this.getMaterial(COLORS.STAIR);
      const stepMesh = new THREE.Mesh(stepGeo, stepMat);
      stepMesh.position.set(
        stair.tileX + 0.5,
        stairY + 0.17,
        stair.tileZ + 0.5,
      );
      this.visualizationGroup.add(stepMesh);

      const arrowDir = getSideVector(stair.direction);
      const arrowGeo = new THREE.ConeGeometry(0.2, 0.4, 8);
      const arrowMat = this.getMaterial(COLORS.STAIR);
      const arrow = new THREE.Mesh(arrowGeo, arrowMat);
      arrow.position.set(
        stair.tileX + 0.5 + arrowDir.x * 0.3,
        stairY + 0.5,
        stair.tileZ + 0.5 + arrowDir.z * 0.3,
      );

      if (stair.isLanding) {
        arrow.rotation.x = Math.PI / 2;
        arrow.rotation.z = Math.atan2(-arrowDir.x, arrowDir.z);
      }
      this.visualizationGroup.add(arrow);
    }
  }

  private visualizeEntryPoints(): void {
    if (!this.collisionData) return;

    const floor0 = this.collisionData.floors[0];
    if (!floor0) return;

    const groundY = this.collisionData.groundElevation + 0.03;

    const doorWalls = floor0.wallSegments.filter(
      (w) =>
        w.hasOpening && (w.openingType === "door" || w.openingType === "arch"),
    );

    for (const door of doorWalls) {
      const dirVec = getSideVector(door.side);
      const entryX = door.tileX + dirVec.x * 2;
      const entryZ = door.tileZ + dirVec.z * 2;

      const markerGeo = new THREE.CircleGeometry(0.6, 16);
      const markerMat = this.getMaterial(COLORS.ENTRY_POINT);
      const marker = new THREE.Mesh(markerGeo, markerMat);
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(entryX + 0.5, groundY, entryZ + 0.5);
      this.visualizationGroup.add(marker);
    }
  }

  private visualizeDemoPaths(): void {
    if (!this.collisionData) return;

    const floor0 = this.collisionData.floors[0];
    if (!floor0) return;

    const doorWall = floor0.wallSegments.find(
      (w) =>
        w.hasOpening && (w.openingType === "door" || w.openingType === "arch"),
    );

    if (!doorWall) return;

    const dirVec = getSideVector(doorWall.side);
    const entryTile: TileCoord = {
      x: doorWall.tileX + dirVec.x * 5,
      z: doorWall.tileZ + dirVec.z * 5,
    };

    const tiles = Array.from(floor0.walkableTiles).map(parseTileKey);
    const centerX = Math.floor(
      tiles.reduce((s, t) => s + t.x, 0) / tiles.length,
    );
    const centerZ = Math.floor(
      tiles.reduce((s, t) => s + t.z, 0) / tiles.length,
    );
    const centerTile: TileCoord = { x: centerX, z: centerZ };

    const createChecker = (floorIndex: number) =>
      this.createWalkabilityChecker(floorIndex);
    const floor0Checker = createChecker(0);

    try {
      const path = this.findPathAndValidate(
        entryTile,
        centerTile,
        floor0Checker,
      );

      if (path.length > 0) {
        this.renderPath(
          [entryTile, ...path],
          floor0.elevation + 0.1,
          COLORS.PATH_LINE,
          "demo-path-floor0",
        );
      }

      // Multi-floor demo paths
      if (
        this.collisionData.floors.length > 1 &&
        floor0.stairTiles.length > 0
      ) {
        const floor1 = this.collisionData.floors[1];
        if (!floor1) return;

        const stairBottom = floor0.stairTiles.find((s) => !s.isLanding);
        const stairTop = floor0.stairTiles.find((s) => s.isLanding);

        if (stairBottom && stairTop) {
          const stairBottomTile: TileCoord = {
            x: stairBottom.tileX,
            z: stairBottom.tileZ,
          };
          const stairTopTile: TileCoord = {
            x: stairTop.tileX,
            z: stairTop.tileZ,
          };

          const pathToStair = this.findPathAndValidate(
            centerTile,
            stairBottomTile,
            floor0Checker,
          );
          if (pathToStair.length > 0) {
            this.renderPath(
              [centerTile, ...pathToStair],
              floor0.elevation + 0.1,
              0x00aaff,
              "demo-path-to-stair",
            );
          }

          const floor1Tiles = Array.from(floor1.walkableTiles).map(
            parseTileKey,
          );
          const floor1CenterX = Math.floor(
            floor1Tiles.reduce((s, t) => s + t.x, 0) / floor1Tiles.length,
          );
          const floor1CenterZ = Math.floor(
            floor1Tiles.reduce((s, t) => s + t.z, 0) / floor1Tiles.length,
          );
          const floor1Center: TileCoord = {
            x: floor1CenterX,
            z: floor1CenterZ,
          };

          const floor1Checker = this.createWalkabilityChecker(1);
          const pathOnFloor1 = this.findPathAndValidate(
            stairTopTile,
            floor1Center,
            floor1Checker,
          );

          if (pathOnFloor1.length > 0) {
            this.renderPath(
              [stairTopTile, ...pathOnFloor1],
              floor1.elevation + 0.1,
              0xaa00ff,
              "demo-path-floor1",
            );
          }

          const multiFloorPath = findMultiFloorPath(
            { x: floor1CenterX, z: floor1CenterZ, floor: 1 },
            { x: entryTile.x, z: entryTile.z, floor: 0 },
            this.collisionData.floors,
            createChecker,
          );

          if (multiFloorPath) {
            this.renderMultiFloorPath(
              multiFloorPath,
              "demo-multifloor-descent",
            );
          }
        }
      }
    } catch (error) {
      console.error(
        "[NavigationVisualizer] Demo path validation failed - BUG DETECTED:",
        error,
      );

      const errorMarkerGeo = new THREE.BoxGeometry(2, 2, 2);
      const errorMarkerMat = this.getMaterial(0xff0000);
      const errorMarker = new THREE.Mesh(errorMarkerGeo, errorMarkerMat);
      errorMarker.position.set(
        centerX + 0.5,
        floor0.elevation + 1,
        centerZ + 0.5,
      );
      errorMarker.name = "demo-path-error";
      this.pathGroup.add(errorMarker);

      const nodeEnv = (
        globalThis as {
          process?: { env?: Record<string, string | undefined> };
        }
      ).process?.env?.NODE_ENV;
      if (nodeEnv === "development") {
        throw error;
      }
    }
  }

  private updateMarkers(): void {
    this.clearMarkers();

    if (!this.collisionData) return;

    const elevation = this.collisionData.floors[0]?.elevation ?? 0;

    if (this.clickState.pointA) {
      const markerA = new THREE.Mesh(
        this.markerGeometry,
        this.getMaterial(COLORS.POINT_A),
      );
      markerA.position.set(
        this.clickState.pointA.x + 0.5,
        elevation + 0.5,
        this.clickState.pointA.z + 0.5,
      );
      markerA.name = "point-a";
      this.markerGroup.add(markerA);
    }

    if (this.clickState.pointB) {
      const markerB = new THREE.Mesh(
        this.markerGeometry,
        this.getMaterial(COLORS.POINT_B),
      );
      markerB.position.set(
        this.clickState.pointB.x + 0.5,
        elevation + 0.5,
        this.clickState.pointB.z + 0.5,
      );
      markerB.name = "point-b";
      this.markerGroup.add(markerB);
    }
  }

  private updateUserPath(): void {
    this.clearPath("user-path");

    if (
      !this.clickState.pointA ||
      !this.clickState.pointB ||
      !this.collisionData
    ) {
      this.onPathUpdate?.({
        start: this.clickState.pointA,
        end: this.clickState.pointB,
        length: 0,
        partial: false,
      });
      return;
    }

    const floor0Checker = this.createWalkabilityChecker(0);
    const elevation = this.collisionData.floors[0]?.elevation ?? 0;

    try {
      const path = this.findPathAndValidate(
        this.clickState.pointA,
        this.clickState.pointB,
        floor0Checker,
      );

      const wasPartial = enginePathfinder.wasLastPathPartial();

      if (path.length > 0) {
        this.renderPath(
          [this.clickState.pointA, ...path],
          elevation + 0.15,
          wasPartial ? 0xffaa00 : 0x00ff00, // Orange for partial, green for complete
          "user-path",
        );
      } else {
        this.renderPath(
          [this.clickState.pointA, this.clickState.pointB],
          elevation + 0.15,
          0xff0000, // Red for no path
          "user-path",
        );
      }

      this.onPathUpdate?.({
        start: this.clickState.pointA,
        end: this.clickState.pointB,
        length: path.length,
        partial: wasPartial,
      });
    } catch (error) {
      console.error(
        "[NavigationVisualizer] User path validation failed - BUG DETECTED:",
        error,
      );
      this.renderPath(
        [this.clickState.pointA, this.clickState.pointB],
        elevation + 0.15,
        0xff0000,
        "user-path",
      );
      this.onPathUpdate?.({
        start: this.clickState.pointA,
        end: this.clickState.pointB,
        length: 0,
        partial: true,
      });
    }
  }

  // ===========================================================================
  // MESH HELPERS
  // ===========================================================================

  private addTileMesh(x: number, y: number, z: number, color: number): void {
    const material = this.getMaterial(color);
    const mesh = new THREE.Mesh(this.tileGeometry, material);
    mesh.position.set(x + 0.5, y, z + 0.5);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 100;
    this.visualizationGroup.add(mesh);
  }

  private addWallIndicator(
    tileX: number,
    tileZ: number,
    y: number,
    direction: WallDirection,
    color: number,
  ): void {
    const material = this.getMaterial(color);
    const mesh = new THREE.Mesh(this.wallGeometry, material);

    const offset = 0.45;
    let x = tileX + 0.5;
    let z = tileZ + 0.5;

    switch (direction) {
      case "north":
        z += offset;
        mesh.rotation.y = 0;
        break;
      case "south":
        z -= offset;
        mesh.rotation.y = 0;
        break;
      case "east":
        x += offset;
        mesh.rotation.y = Math.PI / 2;
        break;
      case "west":
        x -= offset;
        mesh.rotation.y = Math.PI / 2;
        break;
    }

    mesh.position.set(x, y, z);
    mesh.renderOrder = 101;
    this.visualizationGroup.add(mesh);
  }

  private renderPath(
    tiles: TileCoord[],
    y: number,
    color: number,
    name: string,
  ): void {
    if (tiles.length < 2) return;

    const points: THREE.Vector3[] = tiles.map(
      (t) => new THREE.Vector3(t.x + 0.5, y + 0.05, t.z + 0.5),
    );

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color, linewidth: 3 });
    const line = new THREE.Line(geometry, material);
    line.name = name;
    line.renderOrder = 200;
    this.pathGroup.add(line);

    const tileHighlightColor = COLORS.PATH_TILE;
    const tileMaterial = this.getMaterial(tileHighlightColor);
    for (const tile of tiles) {
      const mesh = new THREE.Mesh(this.tileGeometry, tileMaterial);
      mesh.position.set(tile.x + 0.5, y + 0.03, tile.z + 0.5);
      mesh.rotation.x = -Math.PI / 2;
      mesh.scale.set(0.7, 0.7, 1);
      mesh.name = name;
      mesh.renderOrder = 150;
      this.pathGroup.add(mesh);
    }
  }

  private renderMultiFloorPath(multiPath: MultiFloorPath, name: string): void {
    if (!this.collisionData) return;

    const floors = this.collisionData.floors;
    const segmentColors = [
      0x00ff00, // Green - floor 0
      0x00aaff, // Light blue - floor 1
      0xaa00ff, // Purple - floor 2
      0xffaa00, // Orange - floor 3+
    ];

    const allPoints: THREE.Vector3[] = [];

    for (let segIdx = 0; segIdx < multiPath.segments.length; segIdx++) {
      const segment = multiPath.segments[segIdx];
      const nextSegment = multiPath.segments[segIdx + 1];
      const floor = floors[segment.floorIndex];

      if (!floor || segment.tiles.length === 0) continue;

      const color =
        segmentColors[Math.min(segment.floorIndex, segmentColors.length - 1)];
      const tileMaterial = this.getMaterial(color);

      for (let i = 0; i < segment.tiles.length; i++) {
        const tile = segment.tiles[i];
        let y = segment.elevation;

        if (
          segment.endsAtStair &&
          nextSegment &&
          i === segment.tiles.length - 1
        ) {
          const stair = floor.stairTiles.find(
            (s) => s.tileX === tile.x && s.tileZ === tile.z,
          );
          if (stair) {
            const nextFloor = floors[nextSegment.floorIndex];
            if (nextFloor) {
              y = segment.elevation;
            }
          }
        }

        allPoints.push(new THREE.Vector3(tile.x + 0.5, y + 0.1, tile.z + 0.5));

        const mesh = new THREE.Mesh(this.tileGeometry, tileMaterial);
        mesh.position.set(tile.x + 0.5, y + 0.03, tile.z + 0.5);
        mesh.rotation.x = -Math.PI / 2;
        mesh.scale.set(0.7, 0.7, 1);
        mesh.name = name;
        mesh.renderOrder = 150;
        this.pathGroup.add(mesh);
      }

      if (segment.endsAtStair && nextSegment) {
        const lastTile = segment.tiles[segment.tiles.length - 1];
        const stair = floor.stairTiles.find(
          (s) => s.tileX === lastTile.x && s.tileZ === lastTile.z,
        );

        if (stair) {
          const nextFloor = floors[nextSegment.floorIndex];
          if (nextFloor) {
            const stairSteps = TILES_PER_CELL;
            const dirVec = getSideVector(stair.direction);
            for (let step = 1; step <= stairSteps; step++) {
              const t = step / stairSteps;
              const interpX = lastTile.x + dirVec.x * t;
              const interpZ = lastTile.z + dirVec.z * t;
              const interpY =
                segment.elevation +
                t * (nextSegment.elevation - segment.elevation);
              allPoints.push(
                new THREE.Vector3(interpX + 0.5, interpY + 0.1, interpZ + 0.5),
              );
            }
          }
        }
      }
    }

    if (allPoints.length >= 2) {
      const geometry = new THREE.BufferGeometry().setFromPoints(allPoints);
      const material = new THREE.LineBasicMaterial({
        color: 0xffffff,
        linewidth: 2,
      });
      const line = new THREE.Line(geometry, material);
      line.name = name;
      line.renderOrder = 200;
      this.pathGroup.add(line);
    }
  }

  private getMaterial(color: number): THREE.MeshBasicMaterial {
    if (!this.materials.has(color)) {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.materials.set(color, material);
    }
    return this.materials.get(color)!;
  }

  // ===========================================================================
  // WALKABILITY CHECKER (Creates callback for ENGINE BFSPathfinder)
  // ===========================================================================

  private createWalkabilityChecker(
    floorIndex: number,
  ): WalkabilityCheckerResult {
    const emptyWallLookup = new Map<string, Set<WallDirection>>();

    if (!this.collisionData) {
      return { isWalkable: () => true, wallLookup: emptyWallLookup };
    }

    const floor = this.collisionData.floors[floorIndex];
    if (!floor) {
      return { isWalkable: () => true, wallLookup: emptyWallLookup };
    }

    const { walkableTiles, exteriorTiles, wallSegments } = floor;

    // Build wall lookup for fast queries
    const wallLookup = new Map<string, Set<WallDirection>>();
    for (const wall of wallSegments) {
      if (wall.hasOpening) continue; // Doors/arches don't block

      const key = tileKey(wall.tileX, wall.tileZ);
      if (!wallLookup.has(key)) {
        wallLookup.set(key, new Set());
      }
      wallLookup.get(key)!.add(wall.side);
    }

    const isWalkable = (tile: TileCoord, fromTile?: TileCoord): boolean => {
      const key = tileKey(tile.x, tile.z);

      // Check if tile is walkable (interior OR exterior for ground floor)
      const isInterior = walkableTiles.has(key);
      const isExterior = exteriorTiles.has(key);
      if (!isInterior && !isExterior) {
        return false;
      }

      // Check wall blocking if we have a from tile
      if (fromTile) {
        const dx = tile.x - fromTile.x;
        const dz = tile.z - fromTile.z;

        // Determine approach direction
        let approachDir: WallDirection | null = null;
        if (dx === 0 && dz === 1) approachDir = "north";
        else if (dx === 0 && dz === -1) approachDir = "south";
        else if (dx === 1 && dz === 0) approachDir = "west";
        else if (dx === -1 && dz === 0) approachDir = "east";

        if (approachDir) {
          // Check if target tile has wall on the edge we're entering through
          const targetWalls = wallLookup.get(key);
          if (targetWalls?.has(approachDir)) {
            return false;
          }

          // Check if source tile has wall blocking exit
          const exitDir = getOppositeWallDirection(approachDir);
          const fromKey = tileKey(fromTile.x, fromTile.z);
          const fromWalls = wallLookup.get(fromKey);
          if (fromWalls?.has(exitDir)) {
            return false;
          }
        }
      }

      return true;
    };

    return { isWalkable, wallLookup };
  }

  /**
   * Find path using ENGINE BFSPathfinder and validate
   * @throws Error if path goes through a wall (indicates a bug)
   */
  private findPathAndValidate(
    start: TileCoord,
    end: TileCoord,
    checker: WalkabilityCheckerResult,
  ): TileCoord[] {
    // USE THE ENGINE BFSPathfinder - same code as the game!
    const path = enginePathfinder.findPath(start, end, checker.isWalkable);

    // Log if the engine pathfinder returned a partial path
    if (enginePathfinder.wasLastPathPartial()) {
      console.warn(
        `[NavigationVisualizer] Engine BFSPathfinder returned partial path from (${start.x}, ${start.z}) to (${end.x}, ${end.z})`,
      );
    }

    // Validate the path doesn't go through walls
    if (path.length > 0) {
      try {
        validatePath(path, start, checker.isWalkable, checker.wallLookup);
      } catch (error) {
        console.error("[NavigationVisualizer] Path validation failed:", error);
        throw error;
      }
    }

    return path;
  }

  // ===========================================================================
  // INFO GETTERS
  // ===========================================================================

  /**
   * Get statistics about current collision data
   */
  getStats(): {
    floors: number;
    walkableTiles: number;
    walls: number;
    doors: number;
    stairs: number;
  } | null {
    if (!this.collisionData) return null;

    let walkableTiles = 0;
    let walls = 0;
    let doors = 0;
    let stairs = 0;

    for (const floor of this.collisionData.floors) {
      walkableTiles += floor.walkableTiles.size;
      walls += floor.wallSegments.filter((w) => !w.hasOpening).length;
      doors += floor.wallSegments.filter(
        (w) =>
          w.hasOpening &&
          (w.openingType === "door" || w.openingType === "arch"),
      ).length;
      stairs += floor.stairTiles.length;
    }

    return {
      floors: this.collisionData.floors.length,
      walkableTiles,
      walls,
      doors,
      stairs,
    };
  }

  /**
   * Get click state for UI display
   */
  getClickState(): ClickState {
    return { ...this.clickState };
  }
}
