/**
 * BuildingGenerator
 * Main class for procedural building generation
 */

import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Convert all geometries in array to non-indexed for consistent merging.
 * Three.js mergeGeometries requires all geometries to either have indices or not.
 */
function toNonIndexed(
  geometries: THREE.BufferGeometry[],
): THREE.BufferGeometry[] {
  return geometries.map((geo) => {
    if (geo.index) {
      const nonIndexed = geo.toNonIndexed();
      geo.dispose();
      return nonIndexed;
    }
    return geo;
  });
}

import type {
  BuildingRecipe,
  BuildingLayout,
  BuildingStats,
  FloorPlan,
  Room,
  Cell,
  StairPlacement,
  BaseFootprint,
  RNG,
  PropPlacements,
  GeneratedBuilding,
  BuildingGeneratorOptions,
  WallMaterialType,
} from "./types";

import { WALL_MATERIAL_IDS } from "./types";

import {
  CELL_SIZE,
  WALL_HEIGHT,
  WALL_THICKNESS,
  FLOOR_THICKNESS,
  ROOF_THICKNESS,
  FLOOR_HEIGHT,
  FOUNDATION_HEIGHT,
  FOUNDATION_OVERHANG,
  FLOOR_ZFIGHT_OFFSET,
  TERRAIN_DEPTH,
  ENTRANCE_STEP_HEIGHT,
  ENTRANCE_STEP_DEPTH,
  ENTRANCE_STEP_COUNT,
  TERRAIN_STEP_COUNT,
  RAILING_HEIGHT,
  RAILING_POST_SIZE,
  RAILING_RAIL_HEIGHT,
  RAILING_RAIL_DEPTH,
  RAILING_POST_SPACING,
  DOOR_WIDTH,
  DOOR_HEIGHT,
  ARCH_WIDTH,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  WINDOW_SILL_HEIGHT,
  COUNTER_HEIGHT,
  COUNTER_DEPTH,
  COUNTER_LENGTH,
  COUNTER_WALL_OFFSET,
  FORGE_SIZE,
  ANVIL_SIZE,
  TABLE_WIDTH,
  TABLE_DEPTH,
  TABLE_HEIGHT,
  TABLE_TOP_THICKNESS,
  TABLE_LEG_SIZE,
  CHAIR_WIDTH,
  CHAIR_DEPTH,
  CHAIR_SEAT_HEIGHT,
  CHAIR_BACK_HEIGHT,
  CHAIR_BACK_THICKNESS,
  CHAIR_TABLE_GAP,
  BOOKSHELF_WIDTH,
  BOOKSHELF_DEPTH,
  BOOKSHELF_HEIGHT,
  BOOKSHELF_SHELF_THICKNESS,
  BARREL_DIAMETER,
  BARREL_HEIGHT,
  CRATE_SIZE,
  SCONCE_BRACKET_WIDTH,
  SCONCE_BRACKET_HEIGHT,
  SCONCE_BRACKET_DEPTH,
  SCONCE_CANDLE_SIZE,
  SCONCE_CANDLE_HEIGHT,
  SCONCE_MOUNT_HEIGHT,
  palette,
  getSideVector,
  INTERIOR_INSET,
} from "./constants";

import { getRecipe } from "./recipes";
import { createRng } from "./rng";
import {
  applyVertexColors,
  applyWallAttributes,
  applyFloorAttributes,
  applyRoofAttributes,
  applyGeometryAttributes,
  removeInternalFaces,
  getCellCenter,
  greedyMesh2D,
  createMergedFloorGeometry,
  calculateEdgeInsetsForRect,
  getCachedBox,
  createLOD1Geometry,
  createLOD2Geometry,
  geometryCache,
  createInteriorFloorGeometry,
  createInteriorCeilingGeometry,
  createFloorPlane,
} from "./geometry";
import { UV_SCALE_PRESETS } from "./uvUtils";
import { createGabledRoof } from "./GabledRoof";
import {
  createWindowGeometry,
  getWindowStyleForBuildingType,
} from "./WindowGeometry";
import type { WindowStyle, WindowConfig } from "./WindowGeometry";
import {
  createDoorFrameGeometry,
  getDoorFrameStyleForBuildingType,
  getArchDoorConfig,
} from "./DoorTrimGeometry";
import type { DoorFrameConfig } from "./DoorTrimGeometry";
import type { BuildingGeometryArrays } from "./types";
import {
  generateInteriorLights,
  bakeVertexLighting,
  bakeInteriorVertexLighting,
  DEFAULT_LIGHTING_CONFIG,
} from "./InteriorLighting";

// Re-export for convenience
export { BUILDING_RECIPES, getRecipe } from "./recipes";
export { createRng } from "./rng";
export * from "./types";
export * from "./constants";

// ============================================================================
// MATERIAL & GEOMETRY OPTIMIZATION REVIEW TODOs
// ============================================================================
//
// REVIEW-1: MATERIAL SYSTEM DISCONNECT
// The uber material (MeshStandardNodeMaterial with vertexColors) is a plain
// PBR material with NO custom colorNode. BuildingMaterialTSL.ts has a full
// procedural pattern system (brick, stone, wood, plaster, shingles) but it
// is NOT connected to the uber material. The UV2 material ID encoding
// (brick=0.0, stone=0.2, timber=0.4, stucco=0.6, wood=0.8, siding=0.85,
// solid=1.0) is baked into geometry but NEVER read by any shader.
// ACTION: Either integrate BuildingMaterialTSL patterns into a single uber
// shader that reads UV2 to select patterns at runtime, or remove the UV2
// encoding to eliminate dead computation.
//
// REVIEW-2: WINDOW/DOOR TRIM MISSING UV COORDINATES
// WindowGeometry.ts and DoorTrimGeometry.ts use applyVertexColors() directly
// which adds vertex colors + UV2 but does NOT add UV coordinates.
// All other geometry (walls, floors, roofs) gets UVs via applyGeometryAttributes().
// ACTION: Switch window/door trim to use applyGeometryAttributes() with
// materialId=solid and appropriate uvScale for consistent attributes.
//
// REVIEW-3: DRAW CALL REDUCTION
// Each building produces up to 8 separate meshes (floors, walls, roof,
// terraceRailings, windowFrames, windowGlass, doorFrames, shutters).
// windowFrames, doorFrames, and shutters all use the same uber material
// and have the same walkability (false). They could be merged into the
// walls mesh to save 2-3 draw calls per building.
// ACTION: Merge windowFrames, doorFrames, shutters into wallGeometries.
//
// REVIEW-4: TERRACE ROOF OVERDRAW
// Terrace roof tiles use BoxGeometry with FLOOR_THICKNESS (12 triangles).
// The bottom face is hidden by the room below, and the 4 thin side faces
// are barely visible. A single upward-facing PlaneGeometry (2 triangles)
// would save ~10 triangles per terrace cell.
// ACTION: Replace BoxGeometry with PlaneGeometry for terrace roof tiles.
//
// REVIEW-5: STAIR STEP PARTIAL OVERLAPS
// Stair steps use growing-height solid boxes (step 1 is 1-step tall,
// step 2 is 2-steps tall, etc). Where they overlap, internal faces exist
// that removeInternalFaces() cannot detect (different-sized triangles at
// different positions). Same issue with stringer boxes intersecting steps.
// ACTION: Use uniform-height step boxes or clip geometry at boundaries.
//
// REVIEW-6: CEILING SURFACE TYPE INCORRECT
// Ceilings use applyFloorAttributes() which sets surfaceType to FLOOR (0.33).
// Should be CEILING (1.0) for proper material differentiation when the UV2
// material system is activated.
// ACTION: Pass surfaceType="ceiling" for ceiling geometry.
//
// REVIEW-7: BAKE ALL STATIC GEOMETRY INTO SINGLE BUILDING MESH
// For maximum performance, all non-dynamic geometry (walls, floors, windows,
// doors, shutters, furniture, sconces) should be merged into as few meshes
// as possible. The current separation by element type is useful for debugging
// but costs extra draw calls. Consider a "production mode" that merges
// everything except glass (transparent) and roof (toggleable) into one mesh.
//
// ============================================================================

/**
 * BuildingGenerator class
 * Creates procedural buildings from recipes
 */
export class BuildingGenerator {
  private uberMaterial: MeshStandardNodeMaterial;
  /** Current wall material ID being used during building (set per-building) */
  private currentWallMaterialId: number = 0.0;
  /** Effective foundation height for the current building (foundationSteps * STEP_HEIGHT) */
  private currentFoundationHeight: number = FOUNDATION_HEIGHT;

  constructor() {
    // WebGPU-compatible material with vertex colors
    this.uberMaterial = new MeshStandardNodeMaterial();
    this.uberMaterial.vertexColors = true;
    this.uberMaterial.roughness = 0.85;
    this.uberMaterial.metalness = 0.05;
  }

  /**
   * Validate footprint and return dimensions
   * @throws Error if footprint is empty or malformed
   */
  private getFootprintDimensions(
    footprint: boolean[][],
    context: string,
  ): { rows: number; cols: number } {
    const rows = footprint.length;
    if (rows === 0) {
      throw new Error(`[BuildingGenerator] Empty footprint in ${context}`);
    }
    const cols = footprint[0].length;
    if (cols === 0) {
      throw new Error(
        `[BuildingGenerator] Footprint has empty first row in ${context}`,
      );
    }
    return { rows, cols };
  }

  /**
   * Generate a building from a recipe type
   */
  generate(
    typeKey: string,
    options: BuildingGeneratorOptions = {},
  ): GeneratedBuilding | null {
    const recipe = getRecipe(typeKey);
    if (!recipe) {
      console.warn(`Unknown building type: ${typeKey}`);
      return null;
    }

    const seed = options.seed || `${typeKey}_${Date.now()}`;
    const rng = createRng(seed);
    const includeRoof = options.includeRoof !== false;
    const useGreedyMeshing = options.useGreedyMeshing !== false; // Default: true
    const enableInteriorLighting = options.enableInteriorLighting !== false; // Default: true
    const interiorLightIntensity = options.interiorLightIntensity ?? 1.0;

    // Use cached layout if provided, otherwise generate new one
    // This optimization allows BuildingRenderingSystem to reuse layouts
    // already computed by TownSystem, avoiding duplicate computation
    const layout = options.cachedLayout || this.generateLayout(recipe, rng);
    if (options.roofStyle === "gable" && options.generateLODs) {
      throw new Error(
        "Gabled buildings require silhouette-preserving LODs; box LODs are not supported",
      );
    }
    const { building, stats, geometryArrays, propPlacements } =
      this.buildBuilding(
        layout,
        recipe,
        typeKey,
        rng,
        includeRoof,
        useGreedyMeshing,
        enableInteriorLighting,
        interiorLightIntensity,
        options,
      );

    const result: GeneratedBuilding = {
      mesh: building,
      layout,
      stats,
      recipe,
      typeKey,
      geometryArrays,
      propPlacements,
    };

    // Generate LOD meshes if requested
    if (options.generateLODs) {
      result.lods = this.generateLODs(layout);
    }

    return result;
  }

  /**
   * Generate LOD (Level of Detail) meshes for a building
   */
  private generateLODs(layout: BuildingLayout): import("./types").LODMesh[] {
    const lods: import("./types").LODMesh[] = [];
    const width = layout.width * CELL_SIZE;
    const depth = layout.depth * CELL_SIZE;
    const totalHeight =
      layout.floors * FLOOR_HEIGHT + this.currentFoundationHeight;

    // LOD1: Simplified building shell (medium distance)
    const lod1Geo = createLOD1Geometry(
      width,
      depth,
      layout.floors * FLOOR_HEIGHT,
      this.currentFoundationHeight,
    );
    applyVertexColors(
      lod1Geo,
      palette.wallOuter,
      0.35,
      0.35,
      0.78,
      this.currentWallMaterialId,
    );
    const lod1Mesh = new THREE.Mesh(lod1Geo, this.uberMaterial);
    lod1Mesh.name = "lod1";
    lods.push({
      level: 1 as import("./types").LODLevel,
      mesh: lod1Mesh,
      distance: 50, // Switch to LOD1 at 50m
    });

    // LOD2: Minimal box (far distance)
    const lod2Geo = createLOD2Geometry(width, depth, totalHeight);
    applyVertexColors(
      lod2Geo,
      palette.wallOuter,
      0.35,
      0.35,
      0.78,
      this.currentWallMaterialId,
    );
    const lod2Mesh = new THREE.Mesh(lod2Geo, this.uberMaterial);
    lod2Mesh.name = "lod2";
    lods.push({
      level: 2 as import("./types").LODLevel,
      mesh: lod2Mesh,
      distance: 100, // Switch to LOD2 at 100m
    });

    return lods;
  }

  /**
   * Generate a building layout from a recipe
   */
  generateLayout(recipe: BuildingRecipe, rng: RNG): BuildingLayout {
    const baseFootprint = this.generateBaseFootprint(recipe, rng);
    let floors = this.resolveFloorCount(recipe, rng);
    const floorPlans: FloorPlan[] = [];
    const upperFootprints: boolean[][][] = [];

    // Floor 0: base footprint
    upperFootprints.push(baseFootprint.cells);

    // Generate footprints for all upper floors (1, 2, ...)
    // Each upper floor can be slightly smaller than the one below
    const protectedCells: Cell[] = [];
    for (let floorIdx = 1; floorIdx < floors; floorIdx += 1) {
      // Generate upper footprint based on the floor below
      const prevFootprint =
        floorIdx === 1
          ? baseFootprint
          : {
              ...baseFootprint,
              cells: upperFootprints[floorIdx - 1],
            };
      const upper = this.generateUpperFootprint(
        prevFootprint,
        recipe,
        rng,
        protectedCells,
        floorIdx === 1, // Only require full coverage on first upper floor
      );
      if (upper) {
        upperFootprints.push(upper);
      } else {
        // Can't generate this floor, cap the building here
        floors = floorIdx;
        break;
      }
    }

    let stairs: StairPlacement | null = null;
    if (floors > 1) {
      stairs = this.pickStairPlacement(
        baseFootprint.cells,
        upperFootprints[1],
        rng,
      );
      if (!stairs) {
        floors = 1;
        upperFootprints.length = 1;
      }
    }

    for (let floor = 0; floor < floors; floor += 1) {
      const footprint = upperFootprints[floor];
      if (!footprint) {
        throw new Error(
          `Missing footprint for floor ${floor}. floors=${floors}, upperFootprints.length=${upperFootprints.length}`,
        );
      }
      const roomData = this.generateRoomsForFootprint(footprint, recipe, rng);
      const rooms = roomData.rooms;
      const roomMap = roomData.roomMap;
      const archBias = Math.min(
        0.9,
        Math.max(0.1, recipe.archBias - floor * 0.15),
      );
      const extraChance =
        recipe.extraConnectionChance * (floor === 0 ? 1 : 0.7);
      const adjacency = this.collectRoomAdjacencies(footprint, roomMap);
      const internalOpenings = this.selectRoomOpenings(
        rooms.length,
        adjacency,
        archBias,
        extraChance,
        rng,
        baseFootprint.width,
      );

      const entranceRoomId =
        floor === 0
          ? this.chooseEntranceRoomId(
              rooms,
              baseFootprint.foyerCells,
              baseFootprint.width,
            )
          : 0;
      const entranceCount = floor === 0 ? recipe.entranceCount : 0;
      const windowChance = recipe.windowChance * (floor === 0 ? 1 : 0.7);
      const externalOpenings = this.generateExternalOpenings(
        footprint,
        roomMap,
        recipe,
        rng,
        entranceCount,
        entranceRoomId,
        baseFootprint.frontSide,
        windowChance,
        baseFootprint.width,
        stairs,
      );

      if (floors > 1 && floor > 0) {
        this.applyPatioDoors(
          externalOpenings,
          upperFootprints[0],
          footprint,
          recipe,
          rng,
          baseFootprint.width,
        );
      }

      floorPlans.push({
        footprint,
        roomMap,
        rooms,
        internalOpenings,
        externalOpenings,
      });
    }

    if (stairs && floors > 1) {
      // With floors > 1, floor plans 0 and 1 must exist
      const groundFloor = floorPlans[0];
      const firstFloor = floorPlans[1];
      if (!groundFloor || !firstFloor) {
        throw new Error(
          `[BuildingGenerator] Expected floor plans 0 and 1 with ${floors} floors`,
        );
      }

      const anchorId = this.cellId(stairs.col, stairs.row, baseFootprint.width);
      const landingId = this.cellId(
        stairs.landing.col,
        stairs.landing.row,
        baseFootprint.width,
      );
      const openingKey = this.edgeKey(anchorId, landingId);
      groundFloor.internalOpenings.set(openingKey, "arch");
      firstFloor.internalOpenings.set(openingKey, "arch");

      this.ensureStairExit(
        groundFloor,
        { col: stairs.col, row: stairs.row },
        { col: stairs.landing.col, row: stairs.landing.row },
        baseFootprint.width,
      );
      this.ensureStairExit(
        firstFloor,
        { col: stairs.landing.col, row: stairs.landing.row },
        { col: stairs.col, row: stairs.row },
        baseFootprint.width,
      );
    }

    // Validate generated layout
    if (baseFootprint.width <= 0 || baseFootprint.depth <= 0) {
      throw new Error(
        `[BuildingGenerator] Invalid layout dimensions: ${baseFootprint.width}x${baseFootprint.depth}`,
      );
    }
    if (floors <= 0 || floorPlans.length === 0) {
      throw new Error(
        `[BuildingGenerator] Invalid floor count: floors=${floors}, floorPlans=${floorPlans.length}`,
      );
    }
    if (floorPlans.length !== floors) {
      throw new Error(
        `[BuildingGenerator] Floor count mismatch: floors=${floors}, floorPlans=${floorPlans.length}`,
      );
    }
    // Validate each floor plan has a footprint
    for (let i = 0; i < floorPlans.length; i++) {
      const plan = floorPlans[i];
      if (!plan.footprint || plan.footprint.length === 0) {
        throw new Error(`[BuildingGenerator] Floor ${i} has invalid footprint`);
      }
    }

    // ── Foundation steps ──
    // Resolve how many entrance steps this building has (determines foundation height).
    // 0 = building at ground level, no steps.
    let foundationSteps: number;
    if (recipe.foundationStepsRange) {
      foundationSteps = rng.int(
        recipe.foundationStepsRange[0],
        recipe.foundationStepsRange[1],
      );
    } else if (typeof recipe.foundationSteps === "number") {
      foundationSteps = recipe.foundationSteps;
    } else {
      foundationSteps = ENTRANCE_STEP_COUNT; // default: 2
    }

    // ── Basement generation ──
    const basementPlans: FloorPlan[] = [];
    let basementStairs: StairPlacement | null = null;

    if (recipe.hasBasement && rng.chance(recipe.basementChance ?? 0.5)) {
      const basementLevels = recipe.basementLevels ?? 1;
      const basementCoverage = recipe.basementCoverage ?? 0.6;
      const groundFootprint = floorPlans[0]?.footprint;

      if (groundFootprint) {
        for (let level = 0; level < basementLevels; level += 1) {
          const basementFootprint = this.generateBasementFootprint(
            groundFootprint,
            basementCoverage,
            rng,
          );
          const roomData = this.generateRoomsForFootprint(
            basementFootprint,
            recipe,
            rng,
          );
          const adjacency = this.collectRoomAdjacencies(
            basementFootprint,
            roomData.roomMap,
          );
          const internalOpenings = this.selectRoomOpenings(
            roomData.rooms.length,
            adjacency,
            0.8, // Basements use mostly arches
            0.3,
            rng,
            baseFootprint.width,
          );

          basementPlans.push({
            footprint: basementFootprint,
            roomMap: roomData.roomMap,
            rooms: roomData.rooms,
            internalOpenings,
            externalOpenings: new Map(),
          });
        }

        // Place stairs from ground floor down to basement
        if (basementPlans.length > 0) {
          const basementFp = basementPlans[0]?.footprint;
          if (basementFp && groundFootprint) {
            basementStairs = this.pickStairPlacement(
              groundFootprint,
              basementFp,
              rng,
            );
          }
        }
      }
    }

    // ── Exterior footprint ──
    // Compute the exterior (ground-meeting) footprint for terrain carving.
    // This includes ALL cells that are physically part of the building at ground level,
    // INCLUDING courtyard interiors and any area within the building's outer walls.
    const exteriorFootprint = this.computeExteriorFootprint(
      baseFootprint.cells,
      baseFootprint.width,
      baseFootprint.depth,
    );

    return {
      width: baseFootprint.width,
      depth: baseFootprint.depth,
      floors,
      floorPlans,
      stairs,
      foundationSteps,
      basementPlans,
      basementStairs,
      exteriorFootprint,
    };
  }

  /**
   * Compute the exterior footprint (convex hull of cells + fill interior holes).
   * Used for terrain carving: we need to cut terrain for the ENTIRE area the
   * building covers at ground level, not just interior walkable cells.
   * For example, a courtyard building must also cut the courtyard area.
   */
  private computeExteriorFootprint(
    cells: boolean[][],
    width: number,
    depth: number,
  ): boolean[][] {
    // Start with a copy of the interior cells
    const exterior = cells.map((row) => row.slice());

    // Flood-fill from edges to find truly external cells.
    // Any cell NOT reached by the flood fill is interior (courtyard, etc.)
    // and should be included in the exterior footprint.
    const visited: boolean[][] = Array.from({ length: depth }, () =>
      Array.from({ length: width }, () => false),
    );
    const queue: Array<{ col: number; row: number }> = [];

    // Seed the flood fill from all edge cells that are empty
    for (let row = 0; row < depth; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (
          (row === 0 || row === depth - 1 || col === 0 || col === width - 1) &&
          !cells[row][col]
        ) {
          visited[row][col] = true;
          queue.push({ col, row });
        }
      }
    }

    // BFS flood fill
    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = [
        { col: current.col - 1, row: current.row },
        { col: current.col + 1, row: current.row },
        { col: current.col, row: current.row - 1 },
        { col: current.col, row: current.row + 1 },
      ];
      for (const n of neighbors) {
        if (
          n.col >= 0 &&
          n.col < width &&
          n.row >= 0 &&
          n.row < depth &&
          !visited[n.row][n.col] &&
          !cells[n.row][n.col]
        ) {
          visited[n.row][n.col] = true;
          queue.push(n);
        }
      }
    }

    // Any empty cell NOT reached by flood fill is an interior void (courtyard)
    // — include it in the exterior footprint
    for (let row = 0; row < depth; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (!cells[row][col] && !visited[row][col]) {
          exterior[row][col] = true;
        }
      }
    }

    return exterior;
  }

  /**
   * Generate a basement footprint as a subset of the ground floor.
   * The basement covers a contiguous portion of the ground floor footprint.
   */
  private generateBasementFootprint(
    groundFootprint: boolean[][],
    coverage: number,
    rng: RNG,
  ): boolean[][] {
    const depth = groundFootprint.length;
    if (depth === 0) return [];
    const width = groundFootprint[0].length;

    // Count ground cells
    let totalCells = 0;
    for (let row = 0; row < depth; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (groundFootprint[row][col]) totalCells += 1;
      }
    }

    const targetCells = Math.max(1, Math.floor(totalCells * coverage));
    const basement = groundFootprint.map((row) => row.map(() => false));

    // Start from a random ground cell and grow outward
    const groundCells: Array<{ col: number; row: number }> = [];
    for (let row = 0; row < depth; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (groundFootprint[row][col]) {
          groundCells.push({ col, row });
        }
      }
    }
    if (groundCells.length === 0) return basement;

    // Start from center of the building for a natural basement shape
    const centerCol = Math.floor(width / 2);
    const centerRow = Math.floor(depth / 2);
    const startCell = groundCells.reduce((closest, cell) => {
      const distA =
        Math.abs(cell.col - centerCol) + Math.abs(cell.row - centerRow);
      const distB =
        Math.abs(closest.col - centerCol) + Math.abs(closest.row - centerRow);
      return distA < distB ? cell : closest;
    }, groundCells[0]);

    // BFS growth from center
    const filled = new Set<string>();
    const frontier: Array<{ col: number; row: number }> = [startCell];
    filled.add(`${startCell.col},${startCell.row}`);
    basement[startCell.row][startCell.col] = true;
    let count = 1;

    while (count < targetCells && frontier.length > 0) {
      const idx = rng.int(0, frontier.length - 1);
      const current = frontier[idx];
      frontier.splice(idx, 1);

      const neighbors = [
        { col: current.col - 1, row: current.row },
        { col: current.col + 1, row: current.row },
        { col: current.col, row: current.row - 1 },
        { col: current.col, row: current.row + 1 },
      ];

      for (const n of neighbors) {
        const key = `${n.col},${n.row}`;
        if (
          n.col >= 0 &&
          n.col < width &&
          n.row >= 0 &&
          n.row < depth &&
          groundFootprint[n.row][n.col] &&
          !filled.has(key) &&
          count < targetCells
        ) {
          filled.add(key);
          basement[n.row][n.col] = true;
          frontier.push(n);
          count += 1;
        }
      }
    }

    return basement;
  }

  /**
   * Build a Three.js mesh from a layout
   * Returns a group with three children for separate raycast filtering:
   * - "floors": floor tiles, stairs, entrance steps (walkable surfaces - raycastable for click-to-move)
   * - "walls": walls, ceilings, foundation, railings, props (non-walkable - excluded from click raycast)
   * - "roof": actual roof pieces and terrace roofs (can be hidden separately)
   */
  buildBuilding(
    layout: BuildingLayout,
    recipe: BuildingRecipe,
    typeKey: string,
    rng: RNG,
    includeRoof: boolean,
    useGreedyMeshing: boolean = true,
    enableInteriorLighting: boolean = true,
    interiorLightIntensity: number = 1.0,
    geometryOptions: Pick<
      BuildingGeneratorOptions,
      "roofStyle" | "includeProps"
    > = {},
  ): {
    building: THREE.Mesh | THREE.Group;
    stats: BuildingStats;
    geometryArrays: BuildingGeometryArrays;
    propPlacements: PropPlacements;
  } {
    const gabled = geometryOptions.roofStyle === "gable";
    const includeProps = geometryOptions.includeProps !== false;
    if (
      gabled &&
      (layout.floors !== 1 ||
        layout.basementPlans.length !== 0 ||
        layout.width < 1 ||
        layout.width > 8 ||
        layout.depth < 1 ||
        layout.depth > 8 ||
        !Number.isInteger(layout.width) ||
        !Number.isInteger(layout.depth) ||
        !Number.isInteger(layout.foundationSteps) ||
        layout.foundationSteps < 0 ||
        layout.foundationSteps > 8 ||
        layout.floorPlans.length !== 1 ||
        layout.floorPlans[0].footprint.length !== layout.depth ||
        layout.floorPlans[0].footprint.some(
          (row) =>
            row.length !== layout.width ||
            Array.from(row).some((cell) => cell !== true),
        ))
    ) {
      throw new Error(
        "Gabled buildings require one complete rectangular 4–32m floor without a basement",
      );
    }
    // Set wall material ID for this building based on recipe
    const wallMaterial: WallMaterialType = recipe.wallMaterial || "brick";
    this.currentWallMaterialId = WALL_MATERIAL_IDS[wallMaterial];

    // Compute effective foundation height from layout's step count
    this.currentFoundationHeight =
      layout.foundationSteps * ENTRANCE_STEP_HEIGHT;

    // Separate geometry arrays for floors (walkable), walls (non-walkable), and roof
    const floorGeometries: THREE.BufferGeometry[] = []; // Walkable surfaces
    const wallGeometries: THREE.BufferGeometry[] = []; // Non-walkable (walls, ceilings, props)
    const roofGeometries: THREE.BufferGeometry[] = [];
    // Terrace railings are separate so they can be hidden with roofs (classic fantasy MMORPG-style)
    const terraceRailingGeometries: THREE.BufferGeometry[] = [];

    // New geometry arrays for windows and doors
    const windowFrameGeometries: THREE.BufferGeometry[] = [];
    const windowGlassGeometries: THREE.BufferGeometry[] = [];
    const doorFrameGeometries: THREE.BufferGeometry[] = [];
    const shutterGeometries: THREE.BufferGeometry[] = [];

    // Determine window and door styles based on building type
    const windowStyle = getWindowStyleForBuildingType(typeKey);
    const doorStyle = getDoorFrameStyleForBuildingType(typeKey, true);

    const stats: BuildingStats = {
      wallSegments: 0,
      doorways: 0,
      archways: 0,
      windows: 0,
      roofPieces: 0,
      floorTiles: 0,
      stairSteps: 0,
      props: 0,
      rooms: 0,
      footprintCells: 0,
      upperFootprintCells: 0,
      basementLevels: layout.basementPlans.length,
      foundationSteps: layout.foundationSteps,
    };

    const propPlacements: PropPlacements = {};
    if (includeProps && typeKey === "inn") {
      propPlacements.innBar = this.reserveInnBarPlacement(layout, recipe, rng);
    }
    if (includeProps && typeKey === "bank") {
      propPlacements.bankCounter = this.reserveBankCounterPlacement(
        layout,
        recipe,
        rng,
      );
    }
    if (includeProps && typeKey === "smithy") {
      propPlacements.forge = this.reserveForgePlacement(layout, rng);
    }

    // Add foundation first (sits at ground level) - non-walkable
    if (useGreedyMeshing) {
      this.addFoundationOptimized(wallGeometries, layout);
    } else {
      this.addFoundation(wallGeometries, layout);
    }

    // Add entrance steps at doors on ground floor
    // Visual steps go to walls (decoration), invisible ramps go to floors (walkable)
    if (layout.foundationSteps > 0) {
      this.addEntranceSteps(wallGeometries, layout); // Visual box steps (decoration)
      this.addEntranceRamps(floorGeometries, layout); // Invisible walkable ramps
    }

    // ── Basement levels ──
    // Basement floors are below ground (negative Y). Each level is one FLOOR_HEIGHT
    // below the previous, starting from Y=0 (ground level) going down.
    // Temporarily set foundation height to 0 for basement wall generation so that
    // wall Y positions align with the basement floor (no above-ground offset).
    const savedFoundationHeight = this.currentFoundationHeight;
    this.currentFoundationHeight = 0;
    for (let bLevel = 0; bLevel < layout.basementPlans.length; bLevel += 1) {
      const basementPlan = layout.basementPlans[bLevel];
      if (!basementPlan) continue;
      // Basement floor Y: ground level minus (level+1) * FLOOR_HEIGHT
      const basementFloorY = -(bLevel + 1) * FLOOR_HEIGHT;

      // Generate basement floor tiles
      for (let row = 0; row < basementPlan.footprint.length; row += 1) {
        for (let col = 0; col < basementPlan.footprint[row].length; col += 1) {
          if (!basementPlan.footprint[row][col]) continue;
          const { x, z } = getCellCenter(
            col,
            row,
            CELL_SIZE,
            layout.width,
            layout.depth,
          );
          const floorGeo = createFloorPlane(CELL_SIZE, CELL_SIZE);
          floorGeo.translate(x, basementFloorY + FLOOR_ZFIGHT_OFFSET, z);
          applyGeometryAttributes(floorGeo, palette.floor, "generic", {
            uvScale: UV_SCALE_PRESETS.floorTile,
          });
          floorGeometries.push(floorGeo);
          stats.floorTiles += 1;
        }
      }

      // Generate basement walls (simplified — full external walls, internal arches)
      // Use the same wall generation approach as above-ground floors
      this.addWallsForFloor(
        wallGeometries,
        // Create a temporary layout-like object offset for basement
        {
          ...layout,
          // Trick: we use a negative "floor" index concept via manual Y offset
        },
        basementPlan,
        -(bLevel + 1), // Negative floor index for Y positioning
        stats,
        windowFrameGeometries,
        windowGlassGeometries,
        doorFrameGeometries,
        shutterGeometries,
        typeKey,
        windowStyle,
        doorStyle,
      );

      // Basement ceiling (underside of ground floor / level above)
      const ceilingY = basementFloorY + FLOOR_HEIGHT - 0.01;
      for (let row = 0; row < basementPlan.footprint.length; row += 1) {
        for (let col = 0; col < basementPlan.footprint[row].length; col += 1) {
          if (!basementPlan.footprint[row][col]) continue;
          const { x, z } = getCellCenter(
            col,
            row,
            CELL_SIZE,
            layout.width,
            layout.depth,
          );
          const ceilGeo = createFloorPlane(CELL_SIZE, CELL_SIZE);
          ceilGeo.rotateX(Math.PI); // Flip to face downward
          ceilGeo.translate(x, ceilingY, z);
          applyGeometryAttributes(ceilGeo, palette.ceiling, "generic", {
            uvScale: UV_SCALE_PRESETS.floorTile,
          });
          wallGeometries.push(ceilGeo);
        }
      }
    }

    // Restore foundation height for above-ground geometry
    this.currentFoundationHeight = savedFoundationHeight;

    // ── Basement stairs (visual) ──
    if (layout.basementStairs && layout.basementPlans.length > 0) {
      // Add a stairwell going down from ground floor to basement
      const bs = layout.basementStairs;
      const { x: stairX, z: stairZ } = getCellCenter(
        bs.col,
        bs.row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );
      // Create a simple staircase going from foundation height down to basement floor
      const stairTopY = this.currentFoundationHeight;
      const stairBottomY = -FLOOR_HEIGHT;
      const stairHeight = stairTopY - stairBottomY;
      const numSteps = Math.ceil(stairHeight / ENTRANCE_STEP_HEIGHT);
      for (let i = 0; i < numSteps; i += 1) {
        const stepY = stairTopY - (i + 1) * ENTRANCE_STEP_HEIGHT;
        const stepGeo = getCachedBox(
          CELL_SIZE * 0.8,
          ENTRANCE_STEP_HEIGHT,
          ENTRANCE_STEP_DEPTH,
        );
        const sideVec = getSideVector(bs.direction);
        const stepDist = (i + 0.5) * ENTRANCE_STEP_DEPTH;
        stepGeo.translate(
          stairX + sideVec.x * stepDist,
          stepY + ENTRANCE_STEP_HEIGHT / 2,
          stairZ + sideVec.z * stepDist,
        );
        applyGeometryAttributes(stepGeo, palette.stairs, "generic", {
          uvScale: UV_SCALE_PRESETS.stoneMedium,
          materialId: WALL_MATERIAL_IDS.stone,
        });
        floorGeometries.push(stepGeo);
        stats.stairSteps += 1;
      }
    }

    for (let floor = 0; floor < layout.floors; floor += 1) {
      // Floor tiles are WALKABLE
      if (useGreedyMeshing) {
        this.addFloorTilesOptimized(floorGeometries, layout, floor, stats);
      } else {
        this.addFloorTiles(floorGeometries, layout, floor, stats);
      }

      // Floor edge skirts are visual trim - non-walkable
      this.addFloorEdgeSkirts(wallGeometries, layout, floor);

      // Walls are non-walkable
      this.addWallsForFloor(
        wallGeometries,
        layout,
        layout.floorPlans[floor],
        floor,
        stats,
        windowFrameGeometries,
        windowGlassGeometries,
        doorFrameGeometries,
        shutterGeometries,
        typeKey,
        windowStyle,
        doorStyle,
      );

      // Add ceiling tiles for floors that have another floor above
      if (floor < layout.floors - 1) {
        // Ceilings are non-walkable (viewed from below)
        if (useGreedyMeshing) {
          this.addCeilingTilesOptimized(wallGeometries, layout, floor, stats);
        } else {
          this.addCeilingTiles(wallGeometries, layout, floor, stats);
        }
        // Terrace roofs go to roof group (they're roofs, not floors with ceilings above)
        this.addTerraceRoofs(roofGeometries, layout, floor, stats);
        // Terrace railings go to separate group (hidden with roofs when inside building)
        this.addTerraceRailings(terraceRailingGeometries, layout, floor);
      }
    }

    // Stairs - visual steps go to walls (decoration), invisible ramps go to floors (walkable)
    this.addStairs(wallGeometries, layout, stats); // Visual box steps (decoration)
    this.addStairRamps(floorGeometries, layout); // Invisible walkable ramps
    if (includeRoof) {
      // Actual roof pieces go to roof group
      if (gabled) {
        const gable = createGabledRoof(
          layout.width * CELL_SIZE,
          layout.depth * CELL_SIZE,
          WALL_HEIGHT + this.currentFoundationHeight,
          wallMaterial,
        );
        roofGeometries.push(...gable.roofs);
        wallGeometries.push(...gable.walls);
        stats.roofPieces += gable.roofs.length;
      } else {
        this.addRoofPieces(roofGeometries, layout, stats);
      }
    }
    // Props are non-walkable (counters, forges)
    if (includeProps) {
      this.addBuildingProps(
        wallGeometries,
        layout,
        recipe,
        typeKey,
        rng,
        stats,
        propPlacements,
      );

      // Interior furniture (tables, chairs, bookshelves, barrels, sconces)
      this.addInteriorFurniture(
        wallGeometries,
        layout,
        typeKey,
        rng,
        stats,
        propPlacements,
      );
    }

    stats.rooms = layout.floorPlans.reduce(
      (count, plan) => count + plan.rooms.length,
      0,
    );
    stats.footprintCells = this.countFootprintCells(
      layout.floorPlans[0].footprint,
    );
    if (layout.floors > 1) {
      stats.upperFootprintCells = this.countFootprintCells(
        layout.floorPlans[layout.floors - 1].footprint,
      );
    }

    // Create the building group with named children
    const buildingGroup = new THREE.Group();
    buildingGroup.userData = { layout, recipe, stats };

    // Create floors mesh (walkable surfaces - for click-to-move raycast)
    if (floorGeometries.length > 0) {
      const mergedFloors = mergeGeometries(floorGeometries, false);
      if (mergedFloors) {
        const cleanedFloors = removeInternalFaces(mergedFloors);
        mergedFloors.dispose();
        for (const geometry of floorGeometries) {
          geometry.dispose();
        }
        const floorMesh = new THREE.Mesh(cleanedFloors, this.uberMaterial);
        floorMesh.name = "floors";
        floorMesh.userData = { walkable: true };
        buildingGroup.add(floorMesh);
      }
    }

    // Create walls mesh (non-walkable - excluded from click raycast)
    if (wallGeometries.length > 0) {
      const mergedWalls = mergeGeometries(wallGeometries, false);
      if (mergedWalls) {
        const cleanedWalls = removeInternalFaces(mergedWalls);
        mergedWalls.dispose();
        for (const geometry of wallGeometries) {
          geometry.dispose();
        }
        const wallMesh = new THREE.Mesh(cleanedWalls, this.uberMaterial);
        wallMesh.name = "walls";
        wallMesh.userData = { walkable: false };
        buildingGroup.add(wallMesh);
      }
    }

    // Create roof mesh (separate so it can be hidden independently)
    if (roofGeometries.length > 0) {
      const mergedRoof = mergeGeometries(roofGeometries, false);
      if (mergedRoof) {
        const cleanedRoof = removeInternalFaces(mergedRoof);
        mergedRoof.dispose();
        for (const geometry of roofGeometries) {
          geometry.dispose();
        }
        const roofMesh = new THREE.Mesh(cleanedRoof, this.uberMaterial);
        roofMesh.name = "roof";
        roofMesh.userData = { walkable: false };
        buildingGroup.add(roofMesh);
      }
    }

    // Create terrace railings mesh (hidden with roofs when inside building - classic fantasy MMORPG-style)
    if (terraceRailingGeometries.length > 0) {
      const mergedTerraceRailings = mergeGeometries(
        terraceRailingGeometries,
        false,
      );
      if (mergedTerraceRailings) {
        const cleanedTerraceRailings = removeInternalFaces(
          mergedTerraceRailings,
        );
        mergedTerraceRailings.dispose();
        for (const geometry of terraceRailingGeometries) {
          geometry.dispose();
        }
        const terraceRailingMesh = new THREE.Mesh(
          cleanedTerraceRailings,
          this.uberMaterial,
        );
        terraceRailingMesh.name = "terraceRailings";
        terraceRailingMesh.userData = { walkable: false };
        buildingGroup.add(terraceRailingMesh);
      }
    }

    // Create window frame mesh
    if (windowFrameGeometries.length > 0) {
      const nonIndexedFrames = toNonIndexed(windowFrameGeometries);
      const mergedWindowFrames = mergeGeometries(nonIndexedFrames, false);
      if (mergedWindowFrames) {
        for (const geometry of nonIndexedFrames) geometry.dispose();
        const windowFrameMesh = new THREE.Mesh(
          mergedWindowFrames,
          this.uberMaterial,
        );
        windowFrameMesh.name = "windowFrames";
        windowFrameMesh.userData = { walkable: false };
        buildingGroup.add(windowFrameMesh);
      }
    }

    // Create window glass mesh (transparent)
    if (windowGlassGeometries.length > 0) {
      const nonIndexedGlass = toNonIndexed(windowGlassGeometries);
      const mergedGlass = mergeGeometries(nonIndexedGlass, false);
      if (mergedGlass) {
        for (const geometry of nonIndexedGlass) geometry.dispose();
        // WebGPU-compatible glass material
        const glassMaterial = new MeshStandardNodeMaterial();
        glassMaterial.vertexColors = true;
        glassMaterial.transparent = true;
        glassMaterial.opacity = 0.3;
        glassMaterial.roughness = 0.1;
        glassMaterial.metalness = 0.0;
        const glassMesh = new THREE.Mesh(mergedGlass, glassMaterial);
        glassMesh.name = "windowGlass";
        glassMesh.userData = { walkable: false, transparent: true };
        buildingGroup.add(glassMesh);
      }
    }

    // Create door frame mesh
    if (doorFrameGeometries.length > 0) {
      const nonIndexedDoors = toNonIndexed(doorFrameGeometries);
      const mergedDoorFrames = mergeGeometries(nonIndexedDoors, false);
      if (mergedDoorFrames) {
        for (const geometry of nonIndexedDoors) geometry.dispose();
        const doorFrameMesh = new THREE.Mesh(
          mergedDoorFrames,
          this.uberMaterial,
        );
        doorFrameMesh.name = "doorFrames";
        doorFrameMesh.userData = { walkable: false };
        buildingGroup.add(doorFrameMesh);
      }
    }

    // Create shutter mesh
    if (shutterGeometries.length > 0) {
      const nonIndexedShutters = toNonIndexed(shutterGeometries);
      const mergedShutters = mergeGeometries(nonIndexedShutters, false);
      if (mergedShutters) {
        for (const geometry of nonIndexedShutters) geometry.dispose();
        const shutterMesh = new THREE.Mesh(mergedShutters, this.uberMaterial);
        shutterMesh.name = "shutters";
        shutterMesh.userData = { walkable: false };
        buildingGroup.add(shutterMesh);
      }
    }

    // Build geometry arrays for multi-material rendering support
    const geometryArrays: BuildingGeometryArrays = {
      walls: wallGeometries,
      floors: floorGeometries,
      roofs: roofGeometries,
      windowFrames: windowFrameGeometries,
      windowGlass: windowGlassGeometries,
      doorFrames: doorFrameGeometries,
      shutters: shutterGeometries,
    };

    // Bake interior lighting into vertex colors if enabled
    // This illuminates interior-facing surfaces (floors, ceilings, interior walls)
    // with light from ceiling-mounted light fixtures (one per room at top center)
    //
    // IMPORTANT: Building geometry is always generated centered at origin (0,0,0).
    // The baked lighting is in local space. When placing buildings in the world,
    // move the entire group - the baked lighting will remain correct.
    if (enableInteriorLighting) {
      // Building is always generated at origin - lights are computed in local space
      const localOrigin = new THREE.Vector3(0, 0, 0);

      // Generate room center lights (one light at ceiling center of each room)
      const interiorLights = generateInteriorLights(layout, localOrigin, {
        ...DEFAULT_LIGHTING_CONFIG,
        baseIntensity:
          DEFAULT_LIGHTING_CONFIG.baseIntensity * interiorLightIntensity,
        useRoomCenterLights: true, // Use simplified room center lights
      });

      if (interiorLights.length > 0) {
        // Calculate building bounds in local space (centered at origin)
        const halfWidth = (layout.width * CELL_SIZE) / 2;
        const halfDepth = (layout.depth * CELL_SIZE) / 2;
        const totalHeight =
          layout.floors * FLOOR_HEIGHT + this.currentFoundationHeight;

        const buildingBoundsLocal = {
          minX: -halfWidth,
          maxX: halfWidth,
          minY: 0,
          maxY: totalHeight,
          minZ: -halfDepth,
          maxZ: halfDepth,
        };

        // Bake lighting into geometry
        // - Walls: interior-aware baking (only interior-facing surfaces get darkened)
        // - Floors: full baking (all surfaces are interior)
        // - Roofs/Glass/Shutters: just add white vertex colors (exterior, normal PBR lighting)
        buildingGroup.traverse((child) => {
          if (child instanceof THREE.Mesh && child.geometry) {
            const name = child.name.toLowerCase();
            const geo = child.geometry;

            if (name.includes("wall")) {
              // Walls: interior-aware baking (exterior faces stay white)
              bakeInteriorVertexLighting(
                geo,
                interiorLights,
                buildingBoundsLocal,
              );
            } else if (
              name.includes("glass") ||
              name.includes("roof") ||
              name.includes("shutter")
            ) {
              // Roofs/Glass/Shutters: initialize vertex colors to WHITE
              // These are exterior surfaces that should receive normal PBR lighting
              if (!geo.getAttribute("color")) {
                const positions = geo.getAttribute("position");
                if (positions) {
                  const colorArray = new Float32Array(positions.count * 3);
                  for (let i = 0; i < colorArray.length; i++) {
                    colorArray[i] = 1.0; // White = full PBR lighting
                  }
                  geo.setAttribute(
                    "color",
                    new THREE.BufferAttribute(colorArray, 3),
                  );
                }
              }
            } else {
              // Floors and other interior surfaces: full baking
              bakeVertexLighting(geo, interiorLights);
            }
          }
        });
      }
    }

    return { building: buildingGroup, stats, geometryArrays, propPlacements };
  }

  /**
   * Dispose instance material. Whole-world teardown may also clear the shared
   * primitive cache (legacy default); individual building leases must retain it.
   */
  dispose(options: { clearGeometryCache?: boolean } = {}): void {
    this.uberMaterial.dispose();
    if (options.clearGeometryCache !== false) geometryCache.clear();
  }

  /**
   * Get optimization statistics
   */
  static getOptimizationStats(): {
    geometryCacheCount: number;
    cacheKeys: string[];
  } {
    const cacheStats = geometryCache.getStats();
    return {
      geometryCacheCount: cacheStats.count,
      cacheKeys: cacheStats.keys,
    };
  }

  /**
   * Clear all cached geometries (call periodically to free memory)
   */
  static clearCache(): void {
    geometryCache.clear();
  }

  // ============================================================
  // PRIVATE HELPER METHODS
  // ============================================================

  private cellId(col: number, row: number, width: number): number {
    return row * width + col;
  }

  private edgeKey(a: number, b: number): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  private resolveFloorCount(recipe: BuildingRecipe, rng: RNG): number {
    if (recipe.floorsRange) {
      const minFloors = Math.max(1, recipe.floorsRange[0]);
      const maxFloors = Math.max(minFloors, recipe.floorsRange[1]);
      return rng.int(minFloors, maxFloors);
    }
    return Math.max(1, recipe.floors || 1);
  }

  private countFootprintCells(grid: boolean[][]): number {
    let count = 0;
    for (let row = 0; row < grid.length; row += 1) {
      for (let col = 0; col < grid[row].length; col += 1) {
        if (grid[row][col]) count += 1;
      }
    }
    return count;
  }

  private createFootprintGrid(
    width: number,
    depth: number,
    fill: boolean,
  ): boolean[][] {
    const grid: boolean[][] = [];
    for (let row = 0; row < depth; row += 1) {
      const line: boolean[] = [];
      for (let col = 0; col < width; col += 1) {
        line.push(Boolean(fill));
      }
      grid.push(line);
    }
    return grid;
  }

  /**
   * Get fallback side order for door placement when front side has no edges.
   * Tries opposite side first, then adjacent sides.
   *
   * @param frontSide - The primary/front side of the building
   * @returns Array of sides to try in order of preference
   */
  private getFallbackSideOrder(frontSide: string): string[] {
    switch (frontSide) {
      case "south":
        return ["north", "east", "west"]; // Opposite first, then sides
      case "north":
        return ["south", "east", "west"];
      case "east":
        return ["west", "north", "south"];
      case "west":
        return ["east", "north", "south"];
      default:
        return ["north", "south", "east", "west"];
    }
  }

  private isCellOccupied(grid: boolean[][], col: number, row: number): boolean {
    if (row < 0 || row >= grid.length) return false;
    if (col < 0 || col >= grid[row].length) return false;
    return Boolean(grid[row][col]);
  }

  private getExternalSideCount(
    grid: boolean[][],
    col: number,
    row: number,
  ): number {
    let count = 0;
    if (!this.isCellOccupied(grid, col, row)) return 0;
    if (!this.isCellOccupied(grid, col - 1, row)) count += 1;
    if (!this.isCellOccupied(grid, col + 1, row)) count += 1;
    if (!this.isCellOccupied(grid, col, row - 1)) count += 1;
    if (!this.isCellOccupied(grid, col, row + 1)) count += 1;
    return count;
  }

  private generateBaseFootprint(
    recipe: BuildingRecipe,
    rng: RNG,
  ): BaseFootprint {
    const mainWidth = rng.int(recipe.widthRange[0], recipe.widthRange[1]);
    const mainDepth = rng.int(recipe.depthRange[0], recipe.depthRange[1]);
    const frontSide = recipe.frontSide || "south";
    let width = mainWidth;
    let depth = mainDepth;
    let cells: boolean[][] = [];
    const foyerCells = new Set<number>();
    const towerCells = new Set<number>();
    const apseCells = new Set<number>();
    const transeptCells = new Set<number>();
    const wingCells = new Set<number>();

    const style = recipe.footprintStyle || "default";

    if (style === "foyer" && recipe.foyerDepthRange && recipe.foyerWidthRange) {
      // ── Foyer style: main building with extension at front ──
      const foyerWidth = rng.int(
        recipe.foyerWidthRange[0],
        recipe.foyerWidthRange[1],
      );
      const foyerDepth = rng.int(
        recipe.foyerDepthRange[0],
        recipe.foyerDepthRange[1],
      );
      depth = mainDepth + foyerDepth;
      cells = this.createFootprintGrid(width, depth, false);

      for (let row = 0; row < mainDepth; row += 1) {
        for (let col = 0; col < width; col += 1) {
          cells[row][col] = true;
        }
      }

      const foyerStart = Math.floor((width - foyerWidth) / 2);
      for (let row = mainDepth; row < depth; row += 1) {
        for (let col = foyerStart; col < foyerStart + foyerWidth; col += 1) {
          cells[row][col] = true;
          foyerCells.add(this.cellId(col, row, width));
        }
      }
    } else if (style === "courtyard" && recipe.courtyardSizeRange) {
      // ── Courtyard style: hollow rectangle with open-air center ──
      const courtyardSize = rng.int(
        recipe.courtyardSizeRange[0],
        recipe.courtyardSizeRange[1],
      );

      const minSize = courtyardSize + 2;
      width = Math.max(mainWidth, minSize);
      depth = Math.max(mainDepth, minSize);

      cells = this.createFootprintGrid(width, depth, true);

      const courtyardStartCol = Math.floor((width - courtyardSize) / 2);
      const courtyardStartRow = Math.floor((depth - courtyardSize) / 2);

      for (
        let row = courtyardStartRow;
        row < courtyardStartRow + courtyardSize;
        row += 1
      ) {
        for (
          let col = courtyardStartCol;
          col < courtyardStartCol + courtyardSize;
          col += 1
        ) {
          if (cells[row]) {
            cells[row][col] = false;
          }
        }
      }
    } else if (style === "gallery" && recipe.galleryWidthRange) {
      // ── Gallery style: solid ground, upper walkway ──
      cells = this.createFootprintGrid(width, depth, true);
    } else if (style === "cruciform" && recipe.transeptArmRange) {
      // ── Cruciform style: cross-shaped (cathedral / large church) ──
      // The nave runs north-south (rows), the transept runs east-west (cols).
      // We build the full bounding grid and then mark only the cross cells.
      const transeptArm = rng.int(
        recipe.transeptArmRange[0],
        recipe.transeptArmRange[1],
      );
      const transeptDepthVal = recipe.transeptDepthRange
        ? rng.int(recipe.transeptDepthRange[0], recipe.transeptDepthRange[1])
        : 1;

      // Total width = nave width + 2 * transept arm extension
      width = mainWidth + transeptArm * 2;
      depth = mainDepth;
      cells = this.createFootprintGrid(width, depth, false);

      // Fill the nave (centered in width)
      const naveStart = transeptArm;
      for (let row = 0; row < depth; row += 1) {
        for (let col = naveStart; col < naveStart + mainWidth; col += 1) {
          cells[row][col] = true;
        }
      }

      // Fill the transept arms (centered vertically)
      const transeptCenterRow = Math.floor(depth / 2);
      const transeptStartRow =
        transeptCenterRow - Math.floor(transeptDepthVal / 2);
      const transeptEndRow = transeptStartRow + transeptDepthVal;

      for (let row = transeptStartRow; row < transeptEndRow; row += 1) {
        for (let col = 0; col < width; col += 1) {
          if (row >= 0 && row < depth && cells[row]) {
            cells[row][col] = true;
            // Mark arm cells (outside the nave) as transept cells
            if (col < naveStart || col >= naveStart + mainWidth) {
              transeptCells.add(this.cellId(col, row, width));
            }
          }
        }
      }
    } else if (style === "towered" && recipe.towerSizeRange) {
      // ── Towered style: rectangular core with protruding corner towers ──
      // Common for castles, keeps, and fortresses.
      const towerSize = rng.int(
        recipe.towerSizeRange[0],
        recipe.towerSizeRange[1],
      );
      const towerExt = recipe.towerExtensionRange
        ? rng.int(recipe.towerExtensionRange[0], recipe.towerExtensionRange[1])
        : 1;

      // The total grid must accommodate the core + tower extensions on all sides.
      // Towers extend outward from the corners of the core body.
      width = mainWidth + towerExt * 2;
      depth = mainDepth + towerExt * 2;
      cells = this.createFootprintGrid(width, depth, false);

      // Fill the core (offset by tower extension)
      for (let row = towerExt; row < towerExt + mainDepth; row += 1) {
        for (let col = towerExt; col < towerExt + mainWidth; col += 1) {
          cells[row][col] = true;
        }
      }

      // Fill corner towers
      const towerCorners = [
        { startCol: 0, startRow: 0 }, // NW
        { startCol: width - towerSize, startRow: 0 }, // NE
        { startCol: 0, startRow: depth - towerSize }, // SW
        { startCol: width - towerSize, startRow: depth - towerSize }, // SE
      ];

      for (const corner of towerCorners) {
        for (
          let row = corner.startRow;
          row < corner.startRow + towerSize;
          row += 1
        ) {
          for (
            let col = corner.startCol;
            col < corner.startCol + towerSize;
            col += 1
          ) {
            if (row >= 0 && row < depth && col >= 0 && col < width) {
              cells[row][col] = true;
              towerCells.add(this.cellId(col, row, width));
            }
          }
        }
      }
    } else if (style === "apse" && recipe.apseDepthRange) {
      // ── Apse style: rectangular body with extended rear (semicircular approximation) ──
      // Used for churches — the apse is a wider/narrower extension at the back (row 0).
      const apseDepthVal = rng.int(
        recipe.apseDepthRange[0],
        recipe.apseDepthRange[1],
      );
      const apseWidth = recipe.apseWidthRange
        ? rng.int(recipe.apseWidthRange[0], recipe.apseWidthRange[1])
        : Math.max(1, mainWidth - 1);
      // Clamp apse width to be <= main width
      const clampedApseWidth = Math.min(apseWidth, mainWidth);

      depth = mainDepth + apseDepthVal;
      cells = this.createFootprintGrid(width, depth, false);

      // Fill main body (front/south portion)
      for (let row = apseDepthVal; row < depth; row += 1) {
        for (let col = 0; col < width; col += 1) {
          cells[row][col] = true;
        }
      }

      // Fill apse at rear (row 0 to apseDepthVal), centered
      const apseStart = Math.floor((width - clampedApseWidth) / 2);
      for (let row = 0; row < apseDepthVal; row += 1) {
        // Taper the apse slightly for each row away from the body
        // to approximate the semicircular shape with cell grid
        const rowsFromBody = apseDepthVal - row;
        const taperAmount = Math.floor(rowsFromBody * 0.3);
        const rowApseStart = apseStart + taperAmount;
        const rowApseEnd = apseStart + clampedApseWidth - taperAmount;
        for (let col = rowApseStart; col < rowApseEnd; col += 1) {
          if (col >= 0 && col < width) {
            cells[row][col] = true;
            apseCells.add(this.cellId(col, row, width));
          }
        }
      }
    } else if (
      style === "winged" &&
      recipe.wingDepthRange &&
      recipe.wingWidthRange
    ) {
      // ── Winged style: central block with side wings ──
      // Used for mansions, manors, estates. Wings extend from the sides.
      const wingDepthVal = rng.int(
        recipe.wingDepthRange[0],
        recipe.wingDepthRange[1],
      );
      const wingWidth = rng.int(
        recipe.wingWidthRange[0],
        recipe.wingWidthRange[1],
      );

      // Wings extend outward from each side
      width = mainWidth + wingWidth * 2;
      cells = this.createFootprintGrid(width, depth, false);

      // Fill the central block
      const centerStart = wingWidth;
      for (let row = 0; row < depth; row += 1) {
        for (let col = centerStart; col < centerStart + mainWidth; col += 1) {
          cells[row][col] = true;
        }
      }

      // Fill the wings (they span part of the depth, centered or front-aligned)
      const wingStartRow = Math.max(0, Math.floor((depth - wingDepthVal) / 2));
      const wingEndRow = Math.min(depth, wingStartRow + wingDepthVal);

      // Left wing
      for (let row = wingStartRow; row < wingEndRow; row += 1) {
        for (let col = 0; col < wingWidth; col += 1) {
          cells[row][col] = true;
          wingCells.add(this.cellId(col, row, width));
        }
      }

      // Right wing
      for (let row = wingStartRow; row < wingEndRow; row += 1) {
        for (let col = centerStart + mainWidth; col < width; col += 1) {
          cells[row][col] = true;
          wingCells.add(this.cellId(col, row, width));
        }
      }
    } else {
      // ── Default: filled rectangle with optional corner carving ──
      cells = this.createFootprintGrid(width, depth, true);
      if (
        recipe.carveChance &&
        recipe.carveSizeRange &&
        rng.chance(recipe.carveChance)
      ) {
        this.carveFootprintCorner(
          cells,
          width,
          depth,
          rng,
          recipe.carveSizeRange,
          0.6,
        );
      }
    }

    return {
      width,
      depth,
      cells,
      mainDepth,
      foyerCells,
      frontSide,
      towerCells,
      apseCells,
      transeptCells,
      wingCells,
    };
  }

  private carveFootprintCorner(
    grid: boolean[][],
    width: number,
    depth: number,
    rng: RNG,
    carveRange: [number, number],
    minFill: number,
  ): void {
    const minCarve = Math.min(carveRange[0], width - 1, depth - 1);
    const maxCarve = Math.min(carveRange[1], width - 1, depth - 1);
    if (minCarve <= 0 || maxCarve <= 0) return;
    const carveWidth = rng.int(minCarve, maxCarve);
    const carveDepth = rng.int(minCarve, maxCarve);
    const corners = [
      { col: 0, row: 0 },
      { col: width - carveWidth, row: 0 },
      { col: 0, row: depth - carveDepth },
      { col: width - carveWidth, row: depth - carveDepth },
    ];
    const corner = rng.pick(corners)!;
    const totalBefore = this.countFootprintCells(grid);
    let removed = 0;
    for (let row = corner.row; row < corner.row + carveDepth; row += 1) {
      for (let col = corner.col; col < corner.col + carveWidth; col += 1) {
        if (grid[row][col]) removed += 1;
      }
    }
    const totalAfter = totalBefore - removed;
    if (totalAfter < totalBefore * minFill) return;
    for (let row = corner.row; row < corner.row + carveDepth; row += 1) {
      for (let col = corner.col; col < corner.col + carveWidth; col += 1) {
        grid[row][col] = false;
      }
    }
  }

  private generateUpperFootprint(
    base: BaseFootprint,
    recipe: BuildingRecipe,
    rng: RNG,
    _protectedCells: Cell[],
    _isTopFloor: boolean,
  ): boolean[][] | null {
    const minCells = recipe.minUpperFloorCells || 2;
    const minShrink = recipe.minUpperFloorShrinkCells || 1;
    const baseCellCount = this.countFootprintCells(base.cells);
    if (baseCellCount < minCells + minShrink) return null;

    const upper = base.cells.map((row) => row.slice());
    let shrunk = 0;

    // Gallery style: create walkway around edges, open center overlooking main hall
    if (recipe.footprintStyle === "gallery" && recipe.galleryWidthRange) {
      const galleryWidth = rng.int(
        recipe.galleryWidthRange[0],
        recipe.galleryWidthRange[1],
      );

      // Remove interior cells to create gallery walkway around the edge
      for (let row = 0; row < upper.length; row += 1) {
        for (let col = 0; col < upper[row].length; col += 1) {
          if (!upper[row][col]) continue;

          // Check if this cell is in the interior (not on gallery edge)
          const distFromNorth = row;
          const distFromSouth = upper.length - 1 - row;
          const distFromWest = col;
          const distFromEast = upper[row].length - 1 - col;
          const minDistFromEdge = Math.min(
            distFromNorth,
            distFromSouth,
            distFromWest,
            distFromEast,
          );

          // If cell is further from edge than gallery width, remove it (open to hall below)
          if (minDistFromEdge >= galleryWidth) {
            upper[row][col] = false;
            shrunk += 1;
          }
        }
      }
    } else {
      // Default: shrink from edges
      const insetAmount = recipe.upperInsetRange
        ? rng.int(recipe.upperInsetRange[0], recipe.upperInsetRange[1])
        : 1;

      for (let i = 0; i < insetAmount; i += 1) {
        for (let row = 0; row < upper.length; row += 1) {
          for (let col = 0; col < upper[row].length; col += 1) {
            if (!upper[row][col]) continue;
            const extSides = this.getExternalSideCount(upper, col, row);
            if (extSides >= 2 && rng.chance(0.5)) {
              upper[row][col] = false;
              shrunk += 1;
            }
          }
        }
      }
    }

    // Exclude foyer from upper floor
    if (recipe.excludeFoyerFromUpper) {
      for (const cellId of base.foyerCells) {
        const col = cellId % base.width;
        const row = Math.floor(cellId / base.width);
        if (upper[row]?.[col]) {
          upper[row][col] = false;
          shrunk += 1;
        }
      }
    }

    const upperCount = this.countFootprintCells(upper);
    if (upperCount < minCells) return null;
    if (shrunk < minShrink && recipe.requireUpperShrink) return null;

    return upper;
  }

  private generateRoomsForFootprint(
    footprint: boolean[][],
    _recipe: BuildingRecipe,
    _rng: RNG,
  ): { rooms: Room[]; roomMap: number[][] } {
    const { rows: depth, cols: width } = this.getFootprintDimensions(
      footprint,
      "generateRoomsForFootprint",
    );
    const roomMap: number[][] = footprint.map((row) => row.map(() => -1));
    const rooms: Room[] = [];

    // Simple room generation: flood fill connected cells
    let nextRoomId = 0;
    for (let row = 0; row < depth; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (!footprint[row][col] || roomMap[row][col] !== -1) continue;

        const roomCells: Cell[] = [];
        const queue: Cell[] = [{ col, row }];
        roomMap[row][col] = nextRoomId;

        while (queue.length > 0) {
          const cell = queue.shift()!;
          roomCells.push(cell);

          const neighbors = [
            { col: cell.col - 1, row: cell.row },
            { col: cell.col + 1, row: cell.row },
            { col: cell.col, row: cell.row - 1 },
            { col: cell.col, row: cell.row + 1 },
          ];

          for (const n of neighbors) {
            if (
              n.row >= 0 &&
              n.row < depth &&
              n.col >= 0 &&
              n.col < width &&
              footprint[n.row][n.col] &&
              roomMap[n.row][n.col] === -1
            ) {
              roomMap[n.row][n.col] = nextRoomId;
              queue.push(n);
            }
          }
        }

        if (roomCells.length > 0) {
          const bounds = {
            minCol: Math.min(...roomCells.map((c) => c.col)),
            maxCol: Math.max(...roomCells.map((c) => c.col)),
            minRow: Math.min(...roomCells.map((c) => c.row)),
            maxRow: Math.max(...roomCells.map((c) => c.row)),
          };

          rooms.push({
            id: nextRoomId,
            area: roomCells.length,
            cells: roomCells,
            bounds,
          });
          nextRoomId += 1;
        }
      }
    }

    return { rooms, roomMap };
  }

  private collectRoomAdjacencies(
    footprint: boolean[][],
    roomMap: number[][],
  ): Map<string, Cell[]> {
    const adjacency = new Map<string, Cell[]>();
    const { rows: depth, cols: width } = this.getFootprintDimensions(
      footprint,
      "collectRoomAdjacencies",
    );

    for (let row = 0; row < depth; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (!footprint[row][col]) continue;
        const roomId = roomMap[row][col];

        const neighbors = [
          { col: col + 1, row, side: "east" },
          { col, row: row + 1, side: "south" },
        ];

        for (const n of neighbors) {
          if (
            n.row >= 0 &&
            n.row < depth &&
            n.col >= 0 &&
            n.col < width &&
            footprint[n.row][n.col]
          ) {
            const neighborRoomId = roomMap[n.row][n.col];
            if (neighborRoomId !== roomId) {
              const key = this.edgeKey(roomId, neighborRoomId);
              if (!adjacency.has(key)) {
                adjacency.set(key, []);
              }
              adjacency.get(key)!.push({ col, row });
            }
          }
        }
      }
    }

    return adjacency;
  }

  private selectRoomOpenings(
    roomCount: number,
    adjacency: Map<string, Cell[]>,
    archBias: number,
    extraChance: number,
    rng: RNG,
    _width: number,
  ): Map<string, string> {
    const openings = new Map<string, string>();

    // Build spanning tree of rooms
    const connected = new Set<number>([0]);
    const edges = Array.from(adjacency.keys());

    while (connected.size < roomCount && edges.length > 0) {
      const available = edges.filter((key) => {
        const [a, b] = key.split(":").map(Number);
        return (
          (connected.has(a) && !connected.has(b)) ||
          (connected.has(b) && !connected.has(a))
        );
      });

      if (available.length === 0) break;

      const edge = rng.pick(available)!;
      const [a, b] = edge.split(":").map(Number);
      connected.add(a);
      connected.add(b);

      const cells = adjacency.get(edge)!;
      const cell = rng.pick(cells)!;
      const openingType = rng.chance(archBias) ? "arch" : "door";
      const cellKey = `${cell.col},${cell.row}`;
      openings.set(cellKey, openingType);
    }

    // Add extra connections
    for (const edge of edges) {
      if (rng.chance(extraChance)) {
        const cells = adjacency.get(edge)!;
        const cell = rng.pick(cells)!;
        const cellKey = `${cell.col},${cell.row}`;
        if (!openings.has(cellKey)) {
          const openingType = rng.chance(archBias) ? "arch" : "door";
          openings.set(cellKey, openingType);
        }
      }
    }

    return openings;
  }

  private chooseEntranceRoomId(
    rooms: Room[],
    foyerCells: Set<number>,
    width: number,
  ): number {
    if (foyerCells.size > 0) {
      for (const room of rooms) {
        for (const cell of room.cells) {
          const cellId = this.cellId(cell.col, cell.row, width);
          if (foyerCells.has(cellId)) {
            return room.id;
          }
        }
      }
    }
    if (rooms.length === 0) {
      throw new Error(
        "[BuildingGenerator] No rooms found for entrance room detection",
      );
    }
    return rooms[0].id;
  }

  private generateExternalOpenings(
    footprint: boolean[][],
    roomMap: number[][],
    recipe: BuildingRecipe,
    rng: RNG,
    entranceCount: number,
    _entranceRoomId: number,
    frontSide: string,
    windowChance: number,
    width: number,
    stairs: StairPlacement | null,
  ): Map<string, string> {
    const openings = new Map<string, string>();
    const depth = footprint.length;

    // Track doors per room per side to prevent 2 doors on same wall
    // Key: "roomId-side", Value: number of doors placed
    const doorsPerRoomSide = new Map<string, number>();

    // Collect external edges with room info
    const externalEdges: Array<{
      col: number;
      row: number;
      side: string;
      roomId: number;
    }> = [];

    for (let row = 0; row < depth; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (!footprint[row][col]) continue;

        const roomId = roomMap[row]?.[col] ?? -1;

        const sides = [
          { dc: 0, dr: -1, side: "north" },
          { dc: 0, dr: 1, side: "south" },
          { dc: -1, dr: 0, side: "west" },
          { dc: 1, dr: 0, side: "east" },
        ];

        for (const { dc, dr, side } of sides) {
          const nc = col + dc;
          const nr = row + dr;
          if (!this.isCellOccupied(footprint, nc, nr)) {
            externalEdges.push({ col, row, side, roomId });
          }
        }
      }
    }

    // Place entrances on front side
    const frontEdges = externalEdges.filter((e) => e.side === frontSide);
    const shuffledFrontEdges = rng.shuffle(frontEdges);
    let entrancesPlaced = 0;

    for (const edge of shuffledFrontEdges) {
      if (entrancesPlaced >= entranceCount) break;

      // Check if this room already has a door on this side
      const roomSideKey = `${edge.roomId}-${edge.side}`;
      const existingDoors = doorsPerRoomSide.get(roomSideKey) || 0;

      if (existingDoors >= 1) {
        // This room already has a door on this side - skip
        continue;
      }

      const key = `${edge.col},${edge.row},${edge.side}`;
      const openingType = rng.chance(recipe.entranceArchChance)
        ? "arch"
        : "door";
      openings.set(key, openingType);
      doorsPerRoomSide.set(roomSideKey, existingDoors + 1);
      entrancesPlaced++;
    }

    // CRITICAL FALLBACK: Every building MUST have at least one door
    // If no doors were placed on the front side (due to footprint shape, carvings, etc.),
    // try other sides in order of preference: opposite side, then adjacent sides
    if (entrancesPlaced === 0 && entranceCount > 0) {
      const sidePreference = this.getFallbackSideOrder(frontSide);

      for (const fallbackSide of sidePreference) {
        if (entrancesPlaced >= entranceCount) break;

        const sideEdges = externalEdges.filter((e) => e.side === fallbackSide);
        const shuffledSideEdges = rng.shuffle(sideEdges);

        for (const edge of shuffledSideEdges) {
          if (entrancesPlaced >= entranceCount) break;

          const roomSideKey = `${edge.roomId}-${edge.side}`;
          const existingDoors = doorsPerRoomSide.get(roomSideKey) || 0;

          if (existingDoors >= 1) continue;

          const key = `${edge.col},${edge.row},${edge.side}`;
          const openingType = rng.chance(recipe.entranceArchChance)
            ? "arch"
            : "door";
          openings.set(key, openingType);
          doorsPerRoomSide.set(roomSideKey, existingDoors + 1);
          entrancesPlaced++;
        }
      }

      // Last resort: if STILL no doors (all rooms have doors on all sides somehow),
      // force a door on any available external edge
      if (entrancesPlaced === 0 && externalEdges.length > 0) {
        const anyEdge = externalEdges[0];
        const key = `${anyEdge.col},${anyEdge.row},${anyEdge.side}`;
        const openingType = rng.chance(recipe.entranceArchChance)
          ? "arch"
          : "door";
        openings.set(key, openingType);
        entrancesPlaced++;
      }
    }

    // Place windows
    for (const edge of externalEdges) {
      const key = `${edge.col},${edge.row},${edge.side}`;
      if (openings.has(key)) continue;

      // Skip if near stairs
      if (stairs && edge.col === stairs.col && edge.row === stairs.row)
        continue;

      if (rng.chance(windowChance)) {
        openings.set(key, "window");
      }
    }

    return openings;
  }

  private applyPatioDoors(
    externalOpenings: Map<string, string>,
    lowerFootprint: boolean[][],
    upperFootprint: boolean[][],
    recipe: BuildingRecipe,
    rng: RNG,
    _width: number,
  ): void {
    // Find all edges where upper floor cell is adjacent to a terrace (lower floor only)
    const patioEdges: Array<{ col: number; row: number; side: string }> = [];
    const { rows: depth, cols: width } = this.getFootprintDimensions(
      upperFootprint,
      "generatePatioOpenings",
    );

    for (let row = 0; row < depth; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (!upperFootprint[row]?.[col]) continue;

        const sides = [
          { dc: 0, dr: -1, side: "north" },
          { dc: 0, dr: 1, side: "south" },
          { dc: -1, dr: 0, side: "west" },
          { dc: 1, dr: 0, side: "east" },
        ];

        for (const { dc, dr, side } of sides) {
          const nc = col + dc;
          const nr = row + dr;
          // Terrace: cell exists on lower floor but NOT on upper floor
          if (
            !this.isCellOccupied(upperFootprint, nc, nr) &&
            this.isCellOccupied(lowerFootprint, nc, nr)
          ) {
            patioEdges.push({ col, row, side });
          }
        }
      }
    }

    // If there are terrace edges, ALWAYS add at least one door to access the terrace
    if (patioEdges.length === 0) return;

    // Determine count: recipe-based (with chance) or guaranteed minimum of 1
    let count = 1;
    if (recipe.patioDoorChance && recipe.patioDoorCountRange) {
      if (rng.chance(recipe.patioDoorChance)) {
        count = rng.int(
          recipe.patioDoorCountRange[0],
          recipe.patioDoorCountRange[1],
        );
      }
    }
    // Always ensure at least 1 door to access the terrace
    count = Math.max(1, count);

    const selected = rng.shuffle(patioEdges).slice(0, count);

    for (const edge of selected) {
      const key = `${edge.col},${edge.row},${edge.side}`;
      externalOpenings.set(key, "door");
    }
  }

  /**
   * Pick a valid stair placement with robust rules:
   *
   * RULES:
   * 1. Stair cell must exist on BOTH floors (it's an opening on upper floor)
   * 2. Landing cell must exist on BOTH floors (flat landing area)
   * 3. Lower floor: both cells must be accessible (have neighbors besides each other)
   * 4. Upper floor landing must lead somewhere useful:
   *    - Has at least one interior neighbor on upper floor (room access), OR
   *    - Is adjacent to a terrace (cell on lower but not upper floor) - gets a door
   * 5. Stairs prefer to be against a wall (stair cell has an external edge)
   * 6. Stairs prefer to point toward building interior (landing has more neighbors)
   */
  private pickStairPlacement(
    lowerFootprint: boolean[][],
    upperFootprint: boolean[][],
    rng: RNG,
  ): StairPlacement | null {
    const candidates: Array<{
      placement: StairPlacement;
      score: number;
    }> = [];
    const { rows: depth, cols: width } = this.getFootprintDimensions(
      lowerFootprint,
      "findStairLocation",
    );

    for (let row = 0; row < depth; row += 1) {
      for (let col = 0; col < width; col += 1) {
        // RULE 1: Stair cell must exist on both floors
        if (!lowerFootprint[row][col]) continue;
        if (!upperFootprint[row]?.[col]) continue;

        const directions = [
          { dc: 0, dr: -1, dir: "north" },
          { dc: 0, dr: 1, dir: "south" },
          { dc: -1, dr: 0, dir: "west" },
          { dc: 1, dr: 0, dir: "east" },
        ];

        for (const { dc, dr, dir } of directions) {
          const lc = col + dc;
          const lr = row + dr;

          // RULE 2: Landing cell must exist on both floors
          if (!this.isCellOccupied(lowerFootprint, lc, lr)) continue;
          if (!this.isCellOccupied(upperFootprint, lc, lr)) continue;

          // RULE 3: Lower floor accessibility
          // Both cells need at least one neighbor besides each other on lower floor
          const stairLowerNeighbors = this.countOccupiedNeighbors(
            lowerFootprint,
            col,
            row,
            lc,
            lr,
          );
          const landingLowerNeighbors = this.countOccupiedNeighbors(
            lowerFootprint,
            lc,
            lr,
            col,
            row,
          );
          if (stairLowerNeighbors < 1 || landingLowerNeighbors < 1) continue;

          // RULE 4: Upper floor landing must lead somewhere useful
          // Check if landing has interior neighbors on upper floor (excluding stair cell which is an opening)
          const landingUpperNeighbors = this.countOccupiedNeighbors(
            upperFootprint,
            lc,
            lr,
            col,
            row,
          );

          // Check if landing is adjacent to a terrace (cell on lower but not upper floor)
          const hasTerraceAccess = this.hasAdjacentTerrace(
            lowerFootprint,
            upperFootprint,
            lc,
            lr,
            col,
            row,
          );

          // Landing must have EITHER interior access OR terrace access on upper floor
          if (landingUpperNeighbors < 1 && !hasTerraceAccess) continue;

          // Calculate placement score for prioritization
          let score = 0;

          // RULE 5: Prefer stairs against a wall (external edge on stair cell)
          const stairExternalEdges = this.countExternalEdges(
            lowerFootprint,
            col,
            row,
          );
          if (stairExternalEdges >= 1) score += 10; // Strong preference for wall-backed stairs

          // RULE 6: Prefer landing that opens into building interior
          score += landingUpperNeighbors * 3; // More interior connections = better
          score += landingLowerNeighbors * 2;

          // Bonus for terrace access (stairs leading to terrace door is valid)
          if (hasTerraceAccess) score += 5;

          // Slight penalty for corner positions (less natural)
          if (stairExternalEdges >= 2) score -= 2;

          // RULE 7: Avoid prime bar/counter positions
          // Bars prefer long walls, entrance-facing positions, and non-corner cells
          // Stairs should avoid these to leave good bar spots available
          const wallLength = this.measureExternalWallLength(
            lowerFootprint,
            col,
            row,
          );
          if (wallLength >= 3) {
            // This cell is on a long wall - good for bar, avoid for stairs
            score -= 8;
          }

          // Check if this cell faces an entrance (exterior door)
          // Bars like to face entrances, stairs should not be there
          const landingExternalEdges = this.countExternalEdges(
            lowerFootprint,
            lc,
            lr,
          );
          if (landingExternalEdges >= 1 && landingLowerNeighbors >= 2) {
            // Landing is near external edge with good interior access - prime bar territory
            score -= 5;
          }

          // Cells with high interior connectivity are good for bars
          // Prefer stairs in more secluded positions
          const stairInteriorNeighbors = 4 - stairExternalEdges;
          if (stairInteriorNeighbors >= 3) {
            // Too central - might be prime bar spot
            score -= 3;
          }

          // RULE 8: Avoid doorway positions (doors are typically on south/front side)
          // Check if stair or landing cell is likely to have a door (south-facing external edge)
          const stairHasSouthExternal = !this.isCellOccupied(
            lowerFootprint,
            col,
            row + 1,
          );
          const landingHasSouthExternal = !this.isCellOccupied(
            lowerFootprint,
            lc,
            lr + 1,
          );

          // Heavy penalty for stairs/landing directly on south edge (likely door position)
          if (stairHasSouthExternal) score -= 20;
          if (landingHasSouthExternal) score -= 20;

          // Also check for external edges on other sides that could have doors
          // (entrances can be on any external edge, but south is most common)
          const stairHasNorthExternal = !this.isCellOccupied(
            lowerFootprint,
            col,
            row - 1,
          );
          const stairHasEastExternal = !this.isCellOccupied(
            lowerFootprint,
            col + 1,
            row,
          );
          const stairHasWestExternal = !this.isCellOccupied(
            lowerFootprint,
            col - 1,
            row,
          );

          // Moderate penalty for external edges on other sides
          if (stairHasNorthExternal) score -= 5;
          if (stairHasEastExternal) score -= 5;
          if (stairHasWestExternal) score -= 5;

          // RULE 9: Avoid being 1 tile away from likely door positions
          // Check cells adjacent to stair cell for external edges (potential door neighbors)
          let nearDoorPenalty = 0;
          const stairNeighbors = [
            { c: col - 1, r: row },
            { c: col + 1, r: row },
            { c: col, r: row - 1 },
            { c: col, r: row + 1 },
          ];

          for (const neighbor of stairNeighbors) {
            if (neighbor.c === lc && neighbor.r === lr) continue; // Skip landing
            if (!this.isCellOccupied(lowerFootprint, neighbor.c, neighbor.r))
              continue;

            // Check if this neighbor has a south-facing external edge (likely door)
            if (
              !this.isCellOccupied(lowerFootprint, neighbor.c, neighbor.r + 1)
            ) {
              nearDoorPenalty += 8; // Penalty for being adjacent to likely door cell
            }
            // Check other external edges too
            if (
              !this.isCellOccupied(lowerFootprint, neighbor.c, neighbor.r - 1)
            ) {
              nearDoorPenalty += 3;
            }
            if (
              !this.isCellOccupied(lowerFootprint, neighbor.c + 1, neighbor.r)
            ) {
              nearDoorPenalty += 3;
            }
            if (
              !this.isCellOccupied(lowerFootprint, neighbor.c - 1, neighbor.r)
            ) {
              nearDoorPenalty += 3;
            }
          }
          score -= nearDoorPenalty;

          candidates.push({
            placement: {
              col,
              row,
              direction: dir,
              landing: { col: lc, row: lr },
            },
            score,
          });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Sort by score (highest first)
    candidates.sort((a, b) => b.score - a.score);

    // Pick randomly from top-scoring candidates (within 2 points of best)
    const topScore = candidates[0].score;
    const topCandidates = candidates.filter((c) => c.score >= topScore - 2);

    // topCandidates always has at least one element since candidates[0] passes the filter
    return rng.pick(topCandidates)!.placement;
  }

  /**
   * Check if a cell is adjacent to a terrace (cell exists on lower floor but not upper)
   */
  private hasAdjacentTerrace(
    lowerFootprint: boolean[][],
    upperFootprint: boolean[][],
    col: number,
    row: number,
    excludeCol: number,
    excludeRow: number,
  ): boolean {
    const neighbors = [
      { dc: -1, dr: 0 },
      { dc: 1, dr: 0 },
      { dc: 0, dr: -1 },
      { dc: 0, dr: 1 },
    ];
    for (const { dc, dr } of neighbors) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc === excludeCol && nr === excludeRow) continue;
      // Terrace: exists on lower floor but NOT on upper floor
      if (
        this.isCellOccupied(lowerFootprint, nc, nr) &&
        !this.isCellOccupied(upperFootprint, nc, nr)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Count external edges of a cell (sides without neighbors)
   */
  private countExternalEdges(
    grid: boolean[][],
    col: number,
    row: number,
  ): number {
    let count = 0;
    const neighbors = [
      { dc: -1, dr: 0 },
      { dc: 1, dr: 0 },
      { dc: 0, dr: -1 },
      { dc: 0, dr: 1 },
    ];
    for (const { dc, dr } of neighbors) {
      if (!this.isCellOccupied(grid, col + dc, row + dr)) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Measure the longest external wall segment this cell is part of.
   * Used to identify prime bar/counter positions (bars prefer long walls).
   */
  private measureExternalWallLength(
    grid: boolean[][],
    col: number,
    row: number,
  ): number {
    let maxLength = 0;

    // Check each side for external wall
    const sides = [
      { dc: 0, dr: -1, perpDc: 1, perpDr: 0 }, // north wall
      { dc: 0, dr: 1, perpDc: 1, perpDr: 0 }, // south wall
      { dc: 1, dr: 0, perpDc: 0, perpDr: 1 }, // east wall
      { dc: -1, dr: 0, perpDc: 0, perpDr: 1 }, // west wall
    ];

    for (const { dc, dr, perpDc, perpDr } of sides) {
      // Check if this side has an external wall
      if (this.isCellOccupied(grid, col + dc, row + dr)) continue;

      // Count wall length in both perpendicular directions
      let length = 1;

      // Count positive direction
      let checkCol = col + perpDc;
      let checkRow = row + perpDr;
      while (
        this.isCellOccupied(grid, checkCol, checkRow) &&
        !this.isCellOccupied(grid, checkCol + dc, checkRow + dr)
      ) {
        length += 1;
        checkCol += perpDc;
        checkRow += perpDr;
      }

      // Count negative direction
      checkCol = col - perpDc;
      checkRow = row - perpDr;
      while (
        this.isCellOccupied(grid, checkCol, checkRow) &&
        !this.isCellOccupied(grid, checkCol + dc, checkRow + dr)
      ) {
        length += 1;
        checkCol -= perpDc;
        checkRow -= perpDr;
      }

      maxLength = Math.max(maxLength, length);
    }

    return maxLength;
  }

  /**
   * Count occupied neighbors of a cell, excluding a specific cell
   */
  private countOccupiedNeighbors(
    grid: boolean[][],
    col: number,
    row: number,
    excludeCol: number,
    excludeRow: number,
  ): number {
    let count = 0;
    const neighbors = [
      { dc: -1, dr: 0 },
      { dc: 1, dr: 0 },
      { dc: 0, dr: -1 },
      { dc: 0, dr: 1 },
    ];
    for (const { dc, dr } of neighbors) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc === excludeCol && nr === excludeRow) continue;
      if (this.isCellOccupied(grid, nc, nr)) count += 1;
    }
    return count;
  }

  private ensureStairExit(
    plan: FloorPlan,
    stairCell: Cell,
    landingCell: Cell,
    width: number,
  ): void {
    const stairId = this.cellId(stairCell.col, stairCell.row, width);
    const landingId = this.cellId(landingCell.col, landingCell.row, width);
    const key = this.edgeKey(stairId, landingId);
    if (!plan.internalOpenings.has(key)) {
      plan.internalOpenings.set(key, "arch");
    }
  }

  // ============================================================
  // GEOMETRY BUILDING METHODS
  // ============================================================

  /**
   * Add foundation that elevates the building off the ground
   * This makes buildings more robust on uneven terrain
   *
   * The foundation has two parts:
   * 1. Above-ground foundation (FOUNDATION_HEIGHT) - visible stone base
   * 2. Below-ground terrain base (TERRAIN_DEPTH) - extends into terrain for uneven ground
   */
  private addFoundation(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
  ): void {
    const plan = layout.floorPlans[0];

    for (let row = 0; row < plan.footprint.length; row += 1) {
      for (let col = 0; col < plan.footprint[row].length; col += 1) {
        if (!plan.footprint[row][col]) continue;

        const { x, z } = getCellCenter(
          col,
          row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );

        // Check which sides have external walls (for overhang)
        const hasNorth = !this.isCellOccupied(plan.footprint, col, row - 1);
        const hasSouth = !this.isCellOccupied(plan.footprint, col, row + 1);
        const hasEast = !this.isCellOccupied(plan.footprint, col + 1, row);
        const hasWest = !this.isCellOccupied(plan.footprint, col - 1, row);

        // Foundation extends slightly past walls with overhang at external edges
        let sizeX = CELL_SIZE;
        let sizeZ = CELL_SIZE;
        let offsetX = 0;
        let offsetZ = 0;

        if (hasWest) {
          sizeX += FOUNDATION_OVERHANG;
          offsetX -= FOUNDATION_OVERHANG / 2;
        }
        if (hasEast) {
          sizeX += FOUNDATION_OVERHANG;
          offsetX += FOUNDATION_OVERHANG / 2;
        }
        if (hasNorth) {
          sizeZ += FOUNDATION_OVERHANG;
          offsetZ -= FOUNDATION_OVERHANG / 2;
        }
        if (hasSouth) {
          sizeZ += FOUNDATION_OVERHANG;
          offsetZ += FOUNDATION_OVERHANG / 2;
        }

        // Above-ground foundation (visible stone base)
        const foundationGeo = new THREE.BoxGeometry(
          sizeX,
          this.currentFoundationHeight,
          sizeZ,
        );
        foundationGeo.translate(
          x + offsetX,
          this.currentFoundationHeight / 2,
          z + offsetZ,
        );
        applyGeometryAttributes(foundationGeo, palette.foundation, "generic", {
          uvScale: UV_SCALE_PRESETS.stoneMedium,
          materialId: WALL_MATERIAL_IDS.stone,
        });
        geometries.push(foundationGeo);

        // Below-ground terrain base (extends into terrain for uneven ground)
        // This ensures the building has a solid base even on slopes
        const terrainBaseGeo = new THREE.BoxGeometry(
          sizeX,
          TERRAIN_DEPTH,
          sizeZ,
        );
        terrainBaseGeo.translate(x + offsetX, -TERRAIN_DEPTH / 2, z + offsetZ);
        applyGeometryAttributes(terrainBaseGeo, palette.foundation, "generic", {
          uvScale: UV_SCALE_PRESETS.stoneMedium,
          materialId: WALL_MATERIAL_IDS.stone,
        });
        geometries.push(terrainBaseGeo);
      }
    }
  }

  /**
   * Add foundation using greedy meshing optimization.
   * Interior tiles are merged, edge tiles handled individually for overhangs.
   */
  private addFoundationOptimized(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
  ): void {
    const plan = layout.floorPlans[0];
    const { rows, cols } = this.getFootprintDimensions(
      plan.footprint,
      "addFoundationOptimized",
    );

    // Separate interior vs edge cells
    const interiorGrid: boolean[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => false),
    );
    const edgeCells: Array<{ col: number; row: number }> = [];

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (!plan.footprint[row][col]) continue;

        const hasNorth = !this.isCellOccupied(plan.footprint, col, row - 1);
        const hasSouth = !this.isCellOccupied(plan.footprint, col, row + 1);
        const hasEast = !this.isCellOccupied(plan.footprint, col + 1, row);
        const hasWest = !this.isCellOccupied(plan.footprint, col - 1, row);

        if (hasNorth || hasSouth || hasEast || hasWest) {
          edgeCells.push({ col, row });
        } else {
          interiorGrid[row][col] = true;
        }
      }
    }

    // Greedy mesh interior foundation tiles
    const rects = greedyMesh2D(interiorGrid);

    for (const rect of rects) {
      // Above-ground foundation
      const foundationGeo = createMergedFloorGeometry(
        rect,
        CELL_SIZE,
        this.currentFoundationHeight,
        this.currentFoundationHeight / 2,
        layout.width,
        layout.depth,
        0,
      );
      applyGeometryAttributes(foundationGeo, palette.foundation, "generic", {
        uvScale: UV_SCALE_PRESETS.stoneMedium,
        materialId: WALL_MATERIAL_IDS.stone,
      });
      geometries.push(foundationGeo);

      // Below-ground terrain base
      const terrainGeo = createMergedFloorGeometry(
        rect,
        CELL_SIZE,
        TERRAIN_DEPTH,
        -TERRAIN_DEPTH / 2,
        layout.width,
        layout.depth,
        0,
      );
      applyGeometryAttributes(terrainGeo, palette.foundation, "generic", {
        uvScale: UV_SCALE_PRESETS.stoneMedium,
        materialId: WALL_MATERIAL_IDS.stone,
      });
      geometries.push(terrainGeo);
    }

    // Handle edge cells individually (with overhangs)
    for (const { col, row } of edgeCells) {
      const { x, z } = getCellCenter(
        col,
        row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );

      const hasNorth = !this.isCellOccupied(plan.footprint, col, row - 1);
      const hasSouth = !this.isCellOccupied(plan.footprint, col, row + 1);
      const hasEast = !this.isCellOccupied(plan.footprint, col + 1, row);
      const hasWest = !this.isCellOccupied(plan.footprint, col - 1, row);

      let sizeX = CELL_SIZE;
      let sizeZ = CELL_SIZE;
      let offsetX = 0;
      let offsetZ = 0;

      if (hasWest) {
        sizeX += FOUNDATION_OVERHANG;
        offsetX -= FOUNDATION_OVERHANG / 2;
      }
      if (hasEast) {
        sizeX += FOUNDATION_OVERHANG;
        offsetX += FOUNDATION_OVERHANG / 2;
      }
      if (hasNorth) {
        sizeZ += FOUNDATION_OVERHANG;
        offsetZ -= FOUNDATION_OVERHANG / 2;
      }
      if (hasSouth) {
        sizeZ += FOUNDATION_OVERHANG;
        offsetZ += FOUNDATION_OVERHANG / 2;
      }

      const foundationGeo = getCachedBox(
        sizeX,
        this.currentFoundationHeight,
        sizeZ,
      );
      foundationGeo.translate(
        x + offsetX,
        this.currentFoundationHeight / 2,
        z + offsetZ,
      );
      applyGeometryAttributes(foundationGeo, palette.foundation, "generic", {
        uvScale: UV_SCALE_PRESETS.stoneMedium,
        materialId: WALL_MATERIAL_IDS.stone,
      });
      geometries.push(foundationGeo);

      const terrainGeo = getCachedBox(sizeX, TERRAIN_DEPTH, sizeZ);
      terrainGeo.translate(x + offsetX, -TERRAIN_DEPTH / 2, z + offsetZ);
      applyGeometryAttributes(terrainGeo, palette.foundation, "generic", {
        uvScale: UV_SCALE_PRESETS.stoneMedium,
        materialId: WALL_MATERIAL_IDS.stone,
      });
      geometries.push(terrainGeo);
    }
  }

  /**
   * Add entrance steps at doors on the ground floor
   *
   * Steps are added in two parts:
   * 1. Upper steps: Go UP from ground level to foundation height (variable per recipe)
   * 2. Terrain steps: Go DOWN from ground level into terrain (for uneven ground)
   *
   * When foundationSteps is 0 the building sits flush with the ground and no
   * upper steps are generated, though terrain steps are still created for slope handling.
   */
  private addEntranceSteps(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
  ): void {
    const plan = layout.floorPlans[0];
    const halfCell = CELL_SIZE / 2;
    const stepCount = layout.foundationSteps;

    // Find all ground floor doors
    for (const [key, opening] of plan.externalOpenings) {
      // Only add steps for doors (not windows or arches)
      if (opening !== "door") continue;

      const [colStr, rowStr, side] = key.split(",");
      const col = parseInt(colStr, 10);
      const row = parseInt(rowStr, 10);

      const { x, z } = getCellCenter(
        col,
        row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );
      const sideVec = getSideVector(side);

      // Position steps outside the building
      const stepWidth = DOOR_WIDTH + 0.2; // Slightly wider than door
      const isVertical = sideVec.x !== 0;

      // PART 1: Upper steps - go UP from ground level to foundation
      // These steps start at ground level (Y=0) and go up to foundation height
      // When stepCount is 0 this loop doesn't execute (flush building)
      for (let i = 0; i < stepCount; i += 1) {
        // Step Y position: starts at top (near foundation) and goes down
        const stepY = ENTRANCE_STEP_HEIGHT * (stepCount - i - 1);
        const stepDistance =
          halfCell + FOUNDATION_OVERHANG + ENTRANCE_STEP_DEPTH * (i + 0.5);

        const stepX = x + sideVec.x * stepDistance;
        const stepZ = z + sideVec.z * stepDistance;

        // Use cached geometry for entrance steps
        const geometry = getCachedBox(
          isVertical ? ENTRANCE_STEP_DEPTH : stepWidth,
          ENTRANCE_STEP_HEIGHT,
          isVertical ? stepWidth : ENTRANCE_STEP_DEPTH,
        );
        geometry.translate(stepX, stepY + ENTRANCE_STEP_HEIGHT / 2, stepZ);
        applyGeometryAttributes(geometry, palette.foundation, "generic", {
          uvScale: UV_SCALE_PRESETS.stoneMedium,
          materialId: WALL_MATERIAL_IDS.stone,
        });
        geometries.push(geometry);
      }

      // PART 2: Terrain steps - go DOWN from ground level into terrain
      // These steps allow walking up from uneven/lower terrain
      const upperStepsEndDistance =
        halfCell + FOUNDATION_OVERHANG + ENTRANCE_STEP_DEPTH * stepCount;

      for (let i = 0; i < TERRAIN_STEP_COUNT; i += 1) {
        // Step top Y position: starts at ground level (Y=0) and goes down
        const stepTopY = -ENTRANCE_STEP_HEIGHT * i;
        const stepDistance =
          upperStepsEndDistance + ENTRANCE_STEP_DEPTH * (i + 0.5);

        const stepX = x + sideVec.x * stepDistance;
        const stepZ = z + sideVec.z * stepDistance;

        // Each step extends from its top down to the terrain base (TERRAIN_DEPTH)
        const stepHeight = stepTopY + TERRAIN_DEPTH;

        // Use cached geometry for terrain steps
        const geometry = getCachedBox(
          isVertical ? ENTRANCE_STEP_DEPTH : stepWidth,
          stepHeight,
          isVertical ? stepWidth : ENTRANCE_STEP_DEPTH,
        );
        // Position so top of step is at stepTopY (center = top - height/2)
        const stepCenterY = stepTopY - stepHeight / 2;
        geometry.translate(stepX, stepCenterY, stepZ);
        applyGeometryAttributes(geometry, palette.foundation, "generic", {
          uvScale: UV_SCALE_PRESETS.stoneMedium,
          materialId: WALL_MATERIAL_IDS.stone,
        });
        geometries.push(geometry);
      }
    }
  }

  /**
   * Add invisible walkable ramps at entrance doors.
   * These replace the visual box steps for actual walking collision.
   * The ramp is a thin angled plane that the character walks up smoothly.
   */
  private addEntranceRamps(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
  ): void {
    const plan = layout.floorPlans[0];
    const halfCell = CELL_SIZE / 2;

    // Find all ground floor doors
    for (const [key, opening] of plan.externalOpenings) {
      if (opening !== "door") continue;

      const [colStr, rowStr, side] = key.split(",");
      const col = parseInt(colStr, 10);
      const row = parseInt(rowStr, 10);

      const { x, z } = getCellCenter(
        col,
        row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );
      const sideVec = getSideVector(side);

      // Ramp parameters
      const rampWidth = DOOR_WIDTH + 0.4; // Wider than door for easy walking
      const isVertical = sideVec.x !== 0;

      // Calculate ramp extent
      // Starts at the door threshold (inside edge of foundation)
      // Ends at the bottom of the terrain steps
      const stepCount = layout.foundationSteps;
      const rampStartDist = halfCell + FOUNDATION_OVERHANG * 0.5; // Inside foundation edge
      const rampEndDist =
        halfCell +
        FOUNDATION_OVERHANG +
        ENTRANCE_STEP_DEPTH * stepCount +
        ENTRANCE_STEP_DEPTH * TERRAIN_STEP_COUNT;

      const rampLength = rampEndDist - rampStartDist;

      // Start Y = foundation height (top of ramp, at door)
      // Foundation height is derived from step count
      const dynamicFoundationHeight = stepCount * ENTRANCE_STEP_HEIGHT;
      // End Y = terrain level at bottom of terrain steps
      const startY = dynamicFoundationHeight;
      const endY = -ENTRANCE_STEP_HEIGHT * (TERRAIN_STEP_COUNT - 1);

      // Create a plane geometry for the ramp
      const rampGeo = new THREE.PlaneGeometry(
        isVertical ? rampLength : rampWidth,
        isVertical ? rampWidth : rampLength,
      );

      // Calculate ramp center position
      const rampCenterDist = (rampStartDist + rampEndDist) / 2;
      const rampCenterX = x + sideVec.x * rampCenterDist;
      const rampCenterZ = z + sideVec.z * rampCenterDist;
      const rampCenterY = (startY + endY) / 2;

      // Calculate the angle of inclination
      const heightDiff = startY - endY;
      const angle = Math.atan2(heightDiff, rampLength);

      // Position and rotate the ramp
      // First rotate to be horizontal (default plane is vertical facing +Z)
      rampGeo.rotateX(-Math.PI / 2);

      // Then tilt the ramp based on direction
      if (Math.abs(sideVec.z) > 0.5) {
        // North/South facing ramp - tilt around X axis
        const tiltAngle = sideVec.z > 0 ? angle : -angle;
        rampGeo.rotateX(tiltAngle);
      } else {
        // East/West facing ramp - tilt around Z axis
        const tiltAngle = sideVec.x > 0 ? -angle : angle;
        rampGeo.rotateZ(tiltAngle);
      }

      rampGeo.translate(rampCenterX, rampCenterY, rampCenterZ);

      // Use floor color for the ramp (will be mostly hidden under steps anyway)
      // The ramp is thin and positioned under the visual steps
      applyGeometryAttributes(rampGeo, palette.floor, "generic", {
        uvScale: UV_SCALE_PRESETS.floorTile,
      });

      geometries.push(rampGeo);
    }
  }

  private addFloorTiles(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    floor: number,
    stats: BuildingStats,
  ): void {
    const plan = layout.floorPlans[floor];
    // Floor surface sits slightly above the structural base (foundation for ground floor,
    // ceiling for upper floors) to prevent z-fighting between coplanar surfaces
    const floorBaseY = floor * FLOOR_HEIGHT + this.currentFoundationHeight;
    const y = floorBaseY + FLOOR_ZFIGHT_OFFSET;

    for (let row = 0; row < plan.footprint.length; row += 1) {
      for (let col = 0; col < plan.footprint[row].length; col += 1) {
        if (!plan.footprint[row][col]) continue;

        // Skip stair cell on upper floors (it's an opening to lower floor)
        if (layout.stairs && floor > 0) {
          const isStairCell =
            col === layout.stairs.col && row === layout.stairs.row;
          if (isStairCell) continue;
        }

        const { x, z } = getCellCenter(
          col,
          row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );

        // Check for external walls (edges without neighbors)
        const hasNorth = !this.isCellOccupied(plan.footprint, col, row - 1);
        const hasSouth = !this.isCellOccupied(plan.footprint, col, row + 1);
        const hasEast = !this.isCellOccupied(plan.footprint, col + 1, row);
        const hasWest = !this.isCellOccupied(plan.footprint, col - 1, row);

        // Start with full cell size
        let xSize = CELL_SIZE;
        let zSize = CELL_SIZE;
        let xOffset = 0;
        let zOffset = 0;

        // Only inset at external walls where wall geometry exists
        if (hasWest) {
          xSize -= INTERIOR_INSET;
          xOffset += INTERIOR_INSET / 2;
        }
        if (hasEast) {
          xSize -= INTERIOR_INSET;
          xOffset -= INTERIOR_INSET / 2;
        }
        if (hasNorth) {
          zSize -= INTERIOR_INSET;
          zOffset += INTERIOR_INSET / 2;
        }
        if (hasSouth) {
          zSize -= INTERIOR_INSET;
          zOffset -= INTERIOR_INSET / 2;
        }

        // Ensure minimum size
        xSize = Math.max(xSize, CELL_SIZE * 0.5);
        zSize = Math.max(zSize, CELL_SIZE * 0.5);

        // Create floor tile - use flat plane (top face only, no side faces)
        const geometry = createFloorPlane(xSize, zSize);
        geometry.translate(x + xOffset, y, z + zOffset);
        applyFloorAttributes(
          geometry,
          palette.floor,
          UV_SCALE_PRESETS.floorTile,
        );
        geometries.push(geometry);
        stats.floorTiles += 1;
      }
    }
  }

  /**
   * Add ceiling tiles between floors (non-optimized path)
   * Only adds ceiling where BOTH current floor AND floor above exist at this cell
   *
   * Uses flat plane geometry (bottom face only) to eliminate side faces that
   * would z-fight with walls.
   */
  private addCeilingTiles(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    floor: number,
    _stats: BuildingStats,
  ): void {
    const currentPlan = layout.floorPlans[floor];
    const abovePlan = layout.floorPlans[floor + 1];
    if (!abovePlan) return;

    // Ceiling hangs just below where the floor above starts
    const y = (floor + 1) * FLOOR_HEIGHT + this.currentFoundationHeight - 0.01;

    for (let row = 0; row < currentPlan.footprint.length; row += 1) {
      for (let col = 0; col < currentPlan.footprint[row].length; col += 1) {
        // Only add ceiling where BOTH current floor AND floor above exist
        if (!currentPlan.footprint[row][col]) continue;
        if (!this.isCellOccupied(abovePlan.footprint, col, row)) continue;

        // Skip stair cell - it's the opening for stairs from below
        if (layout.stairs) {
          const isStairCell =
            col === layout.stairs.col && row === layout.stairs.row;
          if (isStairCell) continue;
        }

        const { x, z } = getCellCenter(
          col,
          row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );

        // Calculate insets based on external walls on EITHER floor
        let xSize = CELL_SIZE;
        let zSize = CELL_SIZE;
        let xOffset = 0;
        let zOffset = 0;

        // Check if this is an edge of either floor
        const upperHasNorth = !this.isCellOccupied(
          abovePlan.footprint,
          col,
          row - 1,
        );
        const upperHasSouth = !this.isCellOccupied(
          abovePlan.footprint,
          col,
          row + 1,
        );
        const upperHasEast = !this.isCellOccupied(
          abovePlan.footprint,
          col + 1,
          row,
        );
        const upperHasWest = !this.isCellOccupied(
          abovePlan.footprint,
          col - 1,
          row,
        );

        const hasNorth = !this.isCellOccupied(
          currentPlan.footprint,
          col,
          row - 1,
        );
        const hasSouth = !this.isCellOccupied(
          currentPlan.footprint,
          col,
          row + 1,
        );
        const hasEast = !this.isCellOccupied(
          currentPlan.footprint,
          col + 1,
          row,
        );
        const hasWest = !this.isCellOccupied(
          currentPlan.footprint,
          col - 1,
          row,
        );

        // Inset ceiling to fit within walls (use the more restrictive of the two floors)
        if (hasWest || upperHasWest) {
          xSize -= INTERIOR_INSET;
          xOffset += INTERIOR_INSET / 2;
        }
        if (hasEast || upperHasEast) {
          xSize -= INTERIOR_INSET;
          xOffset -= INTERIOR_INSET / 2;
        }
        if (hasNorth || upperHasNorth) {
          zSize -= INTERIOR_INSET;
          zOffset += INTERIOR_INSET / 2;
        }
        if (hasSouth || upperHasSouth) {
          zSize -= INTERIOR_INSET;
          zOffset -= INTERIOR_INSET / 2;
        }

        // Use flat plane (bottom face only, no side faces)
        const geometry = new THREE.PlaneGeometry(xSize, zSize);
        geometry.rotateX(Math.PI / 2); // Face downward (-Y)
        geometry.translate(x + xOffset, y, z + zOffset);
        applyFloorAttributes(
          geometry,
          palette.ceiling,
          UV_SCALE_PRESETS.floorTile,
        );
        geometries.push(geometry);
      }
    }
  }

  /**
   * Add floor tiles using greedy meshing optimization.
   *
   * IMPORTANT: Uses flat plane geometry (top face only) to eliminate side faces.
   * Interior floors are inset from exterior walls by INTERIOR_INSET to prevent
   * z-fighting and ensure clean geometry that doesn't collide with walls.
   *
   * Groups cells into larger rectangles via greedy meshing to reduce triangle count.
   */
  private addFloorTilesOptimized(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    floor: number,
    stats: BuildingStats,
  ): void {
    const plan = layout.floorPlans[floor];
    // Floor surface sits slightly above the structural base (foundation for ground floor,
    // ceiling for upper floors) to prevent z-fighting between coplanar surfaces
    const floorBaseY = floor * FLOOR_HEIGHT + this.currentFoundationHeight;
    const y = floorBaseY + FLOOR_ZFIGHT_OFFSET;

    const { rows, cols } = this.getFootprintDimensions(
      plan.footprint,
      "addFloorOptimized",
    );

    // Build grid of ALL floor cells for this floor
    const floorGrid: boolean[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => false),
    );

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (!plan.footprint[row][col]) continue;

        // Skip stair cell on upper floors (open hole for stairs)
        if (layout.stairs && floor > 0) {
          if (col === layout.stairs.col && row === layout.stairs.row) continue;
        }

        floorGrid[row][col] = true;
      }
    }

    // Greedy mesh all floor cells together
    const rects = greedyMesh2D(floorGrid);

    for (const rect of rects) {
      // Calculate per-edge insets based on exterior walls
      const edgeInsets = calculateEdgeInsetsForRect(
        rect,
        plan.footprint,
        INTERIOR_INSET,
      );

      // Use flat plane geometry (top face only, no side faces)
      const geometry = createInteriorFloorGeometry(
        rect,
        CELL_SIZE,
        y,
        layout.width,
        layout.depth,
        edgeInsets,
      );
      applyFloorAttributes(geometry, palette.floor, UV_SCALE_PRESETS.floorTile);
      geometries.push(geometry);
      stats.floorTiles += rect.width * rect.height;
    }
  }

  /**
   * Add ceiling tiles using greedy meshing optimization.
   *
   * IMPORTANT: Uses flat plane geometry (bottom face only) to eliminate side faces.
   * Interior ceilings are inset from exterior walls by INTERIOR_INSET to prevent
   * z-fighting and ensure clean geometry that doesn't collide with walls.
   *
   * Ceiling tiles are only added where BOTH current floor AND floor above exist,
   * and are inset from any walls on either floor.
   */
  private addCeilingTilesOptimized(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    floor: number,
    _stats: BuildingStats,
  ): void {
    const currentPlan = layout.floorPlans[floor];
    const abovePlan = layout.floorPlans[floor + 1];
    if (!abovePlan) return;

    // Ceiling hangs at the bottom of the floor above
    // Position just below where the floor above starts to prevent z-fighting
    const y = (floor + 1) * FLOOR_HEIGHT + this.currentFoundationHeight - 0.01;

    const { rows, cols } = this.getFootprintDimensions(
      currentPlan.footprint,
      "addIntermediateCeilingsOptimized",
    );

    // Build grid of cells that need ceilings (intersection of current and above footprints)
    const ceilingGrid: boolean[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => false),
    );

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (!currentPlan.footprint[row][col]) continue;
        if (!this.isCellOccupied(abovePlan.footprint, col, row)) continue;

        // Skip stair cell (open hole for stairs)
        if (layout.stairs) {
          if (col === layout.stairs.col && row === layout.stairs.row) continue;
        }

        ceilingGrid[row][col] = true;
      }
    }

    // Greedy mesh ceiling tiles
    const rects = greedyMesh2D(ceilingGrid);

    for (const rect of rects) {
      // Calculate per-edge insets based on BOTH current and above footprints
      // An edge needs inset if it's external to EITHER floor (has wall on either)
      const currentEdgeInsets = calculateEdgeInsetsForRect(
        rect,
        currentPlan.footprint,
        INTERIOR_INSET,
      );
      const aboveEdgeInsets = calculateEdgeInsetsForRect(
        rect,
        abovePlan.footprint,
        INTERIOR_INSET,
      );

      // Use the more restrictive inset (larger value) for each edge
      // This ensures ceiling is inset from walls on either floor
      const edgeInsets = {
        west: Math.max(currentEdgeInsets.west, aboveEdgeInsets.west),
        east: Math.max(currentEdgeInsets.east, aboveEdgeInsets.east),
        north: Math.max(currentEdgeInsets.north, aboveEdgeInsets.north),
        south: Math.max(currentEdgeInsets.south, aboveEdgeInsets.south),
      };

      // Use flat plane geometry (bottom face only, no side faces)
      const geometry = createInteriorCeilingGeometry(
        rect,
        CELL_SIZE,
        y,
        layout.width,
        layout.depth,
        edgeInsets,
      );
      applyFloorAttributes(
        geometry,
        palette.ceiling,
        UV_SCALE_PRESETS.floorTile,
      );
      geometries.push(geometry);
    }
  }

  /**
   * Add terrace roofs - flat roofs on cells that have floor below but no floor above
   * These are the "patio" or "balcony" areas
   */
  private addTerraceRoofs(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    floor: number,
    stats: BuildingStats,
  ): void {
    const currentPlan = layout.floorPlans[floor];
    const abovePlan = layout.floorPlans[floor + 1];
    if (!abovePlan) return;

    // Terrace roof sits at the same level as the floor above
    const y = (floor + 1) * FLOOR_HEIGHT + this.currentFoundationHeight;

    for (let row = 0; row < currentPlan.footprint.length; row += 1) {
      for (let col = 0; col < currentPlan.footprint[row].length; col += 1) {
        // Only add terrace roof where:
        // 1. Current floor exists
        // 2. Floor above does NOT exist (this creates the terrace)
        if (!currentPlan.footprint[row][col]) continue;
        if (this.isCellOccupied(abovePlan.footprint, col, row)) continue;

        const { x, z } = getCellCenter(
          col,
          row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );

        // Check if this cell is adjacent to the upper floor (edge of terrace)
        const adjacentToUpper =
          this.isCellOccupied(abovePlan.footprint, col - 1, row) ||
          this.isCellOccupied(abovePlan.footprint, col + 1, row) ||
          this.isCellOccupied(abovePlan.footprint, col, row - 1) ||
          this.isCellOccupied(abovePlan.footprint, col, row + 1);

        // Calculate tile size - extend to meet walls of upper floor
        let xSize = CELL_SIZE;
        let zSize = CELL_SIZE;
        let xOffset = 0;
        let zOffset = 0;

        // Check external walls on current floor
        const hasNorth = !this.isCellOccupied(
          currentPlan.footprint,
          col,
          row - 1,
        );
        const hasSouth = !this.isCellOccupied(
          currentPlan.footprint,
          col,
          row + 1,
        );
        const hasEast = !this.isCellOccupied(
          currentPlan.footprint,
          col + 1,
          row,
        );
        const hasWest = !this.isCellOccupied(
          currentPlan.footprint,
          col - 1,
          row,
        );

        // Check if adjacent cell has upper floor (where upper floor wall would be)
        const upperWallNorth = this.isCellOccupied(
          abovePlan.footprint,
          col,
          row - 1,
        );
        const upperWallSouth = this.isCellOccupied(
          abovePlan.footprint,
          col,
          row + 1,
        );
        const upperWallEast = this.isCellOccupied(
          abovePlan.footprint,
          col + 1,
          row,
        );
        const upperWallWest = this.isCellOccupied(
          abovePlan.footprint,
          col - 1,
          row,
        );

        // Inset from external walls
        const inset = WALL_THICKNESS / 2;
        if (hasWest) {
          xSize -= inset;
          xOffset += inset / 2;
        }
        if (hasEast) {
          xSize -= inset;
          xOffset -= inset / 2;
        }
        if (hasNorth) {
          zSize -= inset;
          zOffset += inset / 2;
        }
        if (hasSouth) {
          zSize -= inset;
          zOffset -= inset / 2;
        }

        // Extend slightly under upper floor walls to prevent gaps
        const extend = WALL_THICKNESS;
        if (upperWallWest) {
          xSize += extend;
          xOffset -= extend / 2;
        }
        if (upperWallEast) {
          xSize += extend;
          xOffset += extend / 2;
        }
        if (upperWallNorth) {
          zSize += extend;
          zOffset -= extend / 2;
        }
        if (upperWallSouth) {
          zSize += extend;
          zOffset += extend / 2;
        }

        // Create terrace roof tile - use patio color if adjacent to upper floor, roof color otherwise
        const color = adjacentToUpper ? palette.patio : palette.roof;
        const geometry = new THREE.BoxGeometry(xSize, FLOOR_THICKNESS, zSize);
        geometry.translate(x + xOffset, y - FLOOR_THICKNESS / 2, z + zOffset);
        applyRoofAttributes(geometry, color, UV_SCALE_PRESETS.shingle);
        geometries.push(geometry);
        stats.roofPieces += 1;
      }
    }
  }

  /**
   * Add railings around terrace edges with posts and horizontal rails.
   * Creates a proper wood railing with:
   * - Vertical posts at corners and intervals
   * - Top rail connecting posts
   * - Middle rail for safety
   *
   * IMPORTANT: Railings are aligned to wall centerlines, not cell boundaries.
   * Wall centerline = halfCell - halfThick from cell center.
   */
  private addTerraceRailings(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    floor: number,
  ): void {
    const currentPlan = layout.floorPlans[floor];
    const abovePlan = layout.floorPlans[floor + 1];
    if (!abovePlan) return;

    // Railing starts at the wall top (not terrace floor) to avoid gap
    const wallTopY =
      (floor + 1) * FLOOR_HEIGHT +
      this.currentFoundationHeight -
      FLOOR_THICKNESS;
    const postHeight = RAILING_HEIGHT + FLOOR_THICKNESS;
    const halfCell = CELL_SIZE / 2;
    const halfThick = WALL_THICKNESS / 2;

    // Railing offset from cell center - aligned to wall centerline
    // Walls are centered on the cell boundary but inset by halfThick
    // So railing should be at halfCell - halfThick from cell center
    const railingOffset = halfCell - halfThick;

    // Heights for top rail and middle rail
    const topRailY = wallTopY + postHeight - RAILING_RAIL_HEIGHT / 2;
    const middleRailY = wallTopY + postHeight * 0.5;

    // Track all post positions and edges for rail generation
    interface RailingEdge {
      startX: number;
      startZ: number;
      endX: number;
      endZ: number;
      isVertical: boolean; // Along Z axis (not X)
    }
    const edges: RailingEdge[] = [];
    const postPositions = new Set<string>();

    // First pass: collect all edges that need railings
    for (let row = 0; row < currentPlan.footprint.length; row += 1) {
      for (let col = 0; col < currentPlan.footprint[row].length; col += 1) {
        if (!currentPlan.footprint[row][col]) continue;
        if (this.isCellOccupied(abovePlan.footprint, col, row)) continue;

        const { x, z } = getCellCenter(
          col,
          row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );

        // Check for external terrace edges
        const needsNorth =
          !this.isCellOccupied(currentPlan.footprint, col, row - 1) &&
          !this.isCellOccupied(abovePlan.footprint, col, row - 1);
        const needsSouth =
          !this.isCellOccupied(currentPlan.footprint, col, row + 1) &&
          !this.isCellOccupied(abovePlan.footprint, col, row + 1);
        const needsEast =
          !this.isCellOccupied(currentPlan.footprint, col + 1, row) &&
          !this.isCellOccupied(abovePlan.footprint, col + 1, row);
        const needsWest =
          !this.isCellOccupied(currentPlan.footprint, col - 1, row) &&
          !this.isCellOccupied(abovePlan.footprint, col - 1, row);

        // Add edges - positioned at wall centerline (halfCell - halfThick from cell center)
        if (needsNorth) {
          edges.push({
            startX: x - railingOffset,
            startZ: z - railingOffset,
            endX: x + railingOffset,
            endZ: z - railingOffset,
            isVertical: false,
          });
        }
        if (needsSouth) {
          edges.push({
            startX: x - railingOffset,
            startZ: z + railingOffset,
            endX: x + railingOffset,
            endZ: z + railingOffset,
            isVertical: false,
          });
        }
        if (needsEast) {
          edges.push({
            startX: x + railingOffset,
            startZ: z - railingOffset,
            endX: x + railingOffset,
            endZ: z + railingOffset,
            isVertical: true,
          });
        }
        if (needsWest) {
          edges.push({
            startX: x - railingOffset,
            startZ: z - railingOffset,
            endX: x - railingOffset,
            endZ: z + railingOffset,
            isVertical: true,
          });
        }

        // Add corner posts where two edges meet - at wall centerline intersection
        if (needsNorth && needsWest)
          postPositions.add(`${x - railingOffset},${z - railingOffset}`);
        if (needsNorth && needsEast)
          postPositions.add(`${x + railingOffset},${z - railingOffset}`);
        if (needsSouth && needsWest)
          postPositions.add(`${x - railingOffset},${z + railingOffset}`);
        if (needsSouth && needsEast)
          postPositions.add(`${x + railingOffset},${z + railingOffset}`);
      }
    }

    // Second pass: generate posts along edges at intervals
    for (const edge of edges) {
      const edgeLength = edge.isVertical
        ? Math.abs(edge.endZ - edge.startZ)
        : Math.abs(edge.endX - edge.startX);

      // Calculate number of intermediate posts needed
      const numSegments = Math.ceil(edgeLength / RAILING_POST_SPACING);

      // Add posts at start, intervals, and end
      for (let i = 0; i <= numSegments; i++) {
        const t = i / numSegments;
        const px = edge.startX + (edge.endX - edge.startX) * t;
        const pz = edge.startZ + (edge.endZ - edge.startZ) * t;
        const key = `${px.toFixed(3)},${pz.toFixed(3)}`;

        if (!postPositions.has(key)) {
          postPositions.add(key);
        }
      }
    }

    // Third pass: create all posts
    for (const posKey of postPositions) {
      const [px, pz] = posKey.split(",").map(Number);

      const postGeo = new THREE.BoxGeometry(
        RAILING_POST_SIZE,
        postHeight,
        RAILING_POST_SIZE,
      );
      postGeo.translate(px, wallTopY + postHeight / 2, pz);
      applyGeometryAttributes(postGeo, palette.trim, "generic", {
        uvScale: UV_SCALE_PRESETS.woodPlank,
        materialId: WALL_MATERIAL_IDS.solid,
      });
      geometries.push(postGeo);
    }

    // Fourth pass: create horizontal rails between posts
    // Process each edge and create rails that span from post to post
    const processedEdges = new Set<string>();

    for (const edge of edges) {
      const edgeKey = `${edge.startX},${edge.startZ}-${edge.endX},${edge.endZ}`;
      if (processedEdges.has(edgeKey)) continue;
      processedEdges.add(edgeKey);

      const railLength = edge.isVertical
        ? Math.abs(edge.endZ - edge.startZ)
        : Math.abs(edge.endX - edge.startX);

      // Skip very short edges
      if (railLength < 0.1) continue;

      const railCenterX = (edge.startX + edge.endX) / 2;
      const railCenterZ = (edge.startZ + edge.endZ) / 2;

      // Top rail
      const topRailGeo = new THREE.BoxGeometry(
        edge.isVertical ? RAILING_RAIL_DEPTH : railLength,
        RAILING_RAIL_HEIGHT,
        edge.isVertical ? railLength : RAILING_RAIL_DEPTH,
      );
      topRailGeo.translate(railCenterX, topRailY, railCenterZ);
      applyGeometryAttributes(topRailGeo, palette.trim, "generic", {
        uvScale: UV_SCALE_PRESETS.woodPlank,
        materialId: WALL_MATERIAL_IDS.solid,
      });
      geometries.push(topRailGeo);

      // Middle rail
      const midRailGeo = new THREE.BoxGeometry(
        edge.isVertical ? RAILING_RAIL_DEPTH : railLength,
        RAILING_RAIL_HEIGHT,
        edge.isVertical ? railLength : RAILING_RAIL_DEPTH,
      );
      midRailGeo.translate(railCenterX, middleRailY, railCenterZ);
      applyGeometryAttributes(midRailGeo, palette.trim, "generic", {
        uvScale: UV_SCALE_PRESETS.woodPlank,
        materialId: WALL_MATERIAL_IDS.solid,
      });
      geometries.push(midRailGeo);
    }
  }

  private addFloorEdgeSkirts(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    floor: number,
  ): void {
    const plan = layout.floorPlans[floor];
    const y = floor * FLOOR_HEIGHT + this.currentFoundationHeight;
    // Track which edges have been processed to avoid duplicates
    const processedEdges = new Set<string>();

    // First pass: collect all corner post positions for this floor
    // This ensures skirts are shortened correctly even when corner post was placed by adjacent cell
    const cornerPostPositions = new Set<string>();

    for (let row = 0; row < plan.footprint.length; row += 1) {
      for (let col = 0; col < plan.footprint[row].length; col += 1) {
        if (!plan.footprint[row][col]) continue;

        const hasNorth = !this.isCellOccupied(plan.footprint, col, row - 1);
        const hasSouth = !this.isCellOccupied(plan.footprint, col, row + 1);
        const hasEast = !this.isCellOccupied(plan.footprint, col + 1, row);
        const hasWest = !this.isCellOccupied(plan.footprint, col - 1, row);

        // Record corner post positions (same key format as wall generation)
        if (hasNorth && hasWest)
          cornerPostPositions.add(`${col - 0.5},${row - 0.5}`);
        if (hasNorth && hasEast)
          cornerPostPositions.add(`${col + 0.5},${row - 0.5}`);
        if (hasSouth && hasWest)
          cornerPostPositions.add(`${col - 0.5},${row + 0.5}`);
        if (hasSouth && hasEast)
          cornerPostPositions.add(`${col + 0.5},${row + 0.5}`);
      }
    }

    // Second pass: generate skirts with proper lengths accounting for corner posts
    for (let row = 0; row < plan.footprint.length; row += 1) {
      for (let col = 0; col < plan.footprint[row].length; col += 1) {
        if (!plan.footprint[row][col]) continue;

        const { x, z } = getCellCenter(
          col,
          row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );
        const halfCell = CELL_SIZE / 2;
        const halfThick = WALL_THICKNESS / 2;

        // Check for corner posts at each skirt endpoint using the GLOBAL corner positions
        const hasCornerNW = cornerPostPositions.has(
          `${col - 0.5},${row - 0.5}`,
        );
        const hasCornerNE = cornerPostPositions.has(
          `${col + 0.5},${row - 0.5}`,
        );
        const hasCornerSW = cornerPostPositions.has(
          `${col - 0.5},${row + 0.5}`,
        );
        const hasCornerSE = cornerPostPositions.has(
          `${col + 0.5},${row + 0.5}`,
        );

        // Define sides with corner information from global map
        const sides = [
          {
            dc: -1,
            dr: 0,
            side: "west",
            hasStart: hasCornerNW,
            hasEnd: hasCornerSW,
            isVertical: true,
          },
          {
            dc: 1,
            dr: 0,
            side: "east",
            hasStart: hasCornerNE,
            hasEnd: hasCornerSE,
            isVertical: true,
          },
          {
            dc: 0,
            dr: -1,
            side: "north",
            hasStart: hasCornerNW,
            hasEnd: hasCornerNE,
            isVertical: false,
          },
          {
            dc: 0,
            dr: 1,
            side: "south",
            hasStart: hasCornerSW,
            hasEnd: hasCornerSE,
            isVertical: false,
          },
        ];

        for (const { dc, dr, side, hasStart, hasEnd, isVertical } of sides) {
          const edgeKey = `${Math.min(col, col + dc)},${Math.min(row, row + dr)},${side}`;

          if (
            !this.isCellOccupied(plan.footprint, col + dc, row + dr) &&
            !processedEdges.has(edgeKey)
          ) {
            processedEdges.add(edgeKey);

            // Calculate length, accounting for corner posts
            let length = CELL_SIZE;
            let offset = 0;

            if (hasStart) {
              length -= WALL_THICKNESS;
              offset += WALL_THICKNESS / 2;
            }
            if (hasEnd) {
              length -= WALL_THICKNESS;
              offset -= WALL_THICKNESS / 2;
            }

            // Position of skirt center
            const ox = isVertical
              ? (-halfCell + halfThick) * (side === "west" ? 1 : -1)
              : offset;
            const oz = isVertical
              ? offset
              : (-halfCell + halfThick) * (side === "north" ? 1 : -1);

            // Use PlaneGeometry instead of BoxGeometry to avoid side faces
            // that would be visible from outside and get darkened by interior lighting
            const skirtHeight = FLOOR_THICKNESS * 2;
            const geometry = new THREE.PlaneGeometry(length, skirtHeight);

            // Rotate plane to face outward based on side
            // PlaneGeometry faces +Z by default (normal points toward +Z)
            // For Y rotation: +Z rotates toward -X (counterclockwise from above)
            if (side === "west") {
              geometry.rotateY(Math.PI / 2); // +Z → -X, face outward (west)
            } else if (side === "east") {
              geometry.rotateY(-Math.PI / 2); // +Z → +X, face outward (east)
            } else if (side === "north") {
              geometry.rotateY(Math.PI); // +Z → -Z, face outward (north)
            }
            // south: no rotation needed, +Z faces outward (south)

            geometry.translate(x + ox, y - FLOOR_THICKNESS, z + oz);
            // Skirts use trim color with solid material (no procedural pattern)
            applyGeometryAttributes(geometry, palette.trim, "generic", {
              uvScale: UV_SCALE_PRESETS.woodPlank,
              materialId: WALL_MATERIAL_IDS.solid,
            });
            geometries.push(geometry);
          }
        }
      }
    }
  }

  private addWallsForFloor(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    plan: FloorPlan,
    floor: number,
    stats: BuildingStats,
    windowFrameGeometries: THREE.BufferGeometry[],
    windowGlassGeometries: THREE.BufferGeometry[],
    doorFrameGeometries: THREE.BufferGeometry[],
    shutterGeometries: THREE.BufferGeometry[],
    buildingType: string,
    windowStyle: WindowStyle,
    doorStyle: import("./DoorTrimGeometry").DoorFrameStyle,
  ): void {
    const y = floor * FLOOR_HEIGHT + this.currentFoundationHeight;
    // For non-top floors, extend walls up to meet the floor above (eliminates gap)
    const isTopFloor = floor === layout.floors - 1;
    const effectiveWallHeight = isTopFloor ? WALL_HEIGHT : FLOOR_HEIGHT;

    // Track which wall segments have been placed to avoid duplicates
    const placedWalls = new Set<string>();
    // Track corner posts that need to be placed (global map so walls can check for posts from any cell)
    const cornerPosts = new Map<
      string,
      { x: number; z: number; height: number }
    >();

    // First pass: identify all corner posts
    // Corner posts are placed at external corners where two external walls meet
    for (let row = 0; row < plan.footprint.length; row += 1) {
      for (let col = 0; col < plan.footprint[row].length; col += 1) {
        if (!plan.footprint[row][col]) continue;

        const { x, z } = getCellCenter(
          col,
          row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );
        const halfCell = CELL_SIZE / 2;
        const halfThick = WALL_THICKNESS / 2;

        // Check for external walls (no neighbor in that direction)
        const hasNorth = !this.isCellOccupied(plan.footprint, col, row - 1);
        const hasSouth = !this.isCellOccupied(plan.footprint, col, row + 1);
        const hasEast = !this.isCellOccupied(plan.footprint, col + 1, row);
        const hasWest = !this.isCellOccupied(plan.footprint, col - 1, row);

        // Place corner posts at external corners (where two external walls meet)
        // Key format: "col±0.5,row±0.5" ensures each corner position is unique
        if (hasNorth && hasWest) {
          const key = `${col - 0.5},${row - 0.5}`;
          cornerPosts.set(key, {
            x: x - halfCell + halfThick,
            z: z - halfCell + halfThick,
            height: effectiveWallHeight,
          });
        }
        if (hasNorth && hasEast) {
          const key = `${col + 0.5},${row - 0.5}`;
          cornerPosts.set(key, {
            x: x + halfCell - halfThick,
            z: z - halfCell + halfThick,
            height: effectiveWallHeight,
          });
        }
        if (hasSouth && hasWest) {
          const key = `${col - 0.5},${row + 0.5}`;
          cornerPosts.set(key, {
            x: x - halfCell + halfThick,
            z: z + halfCell - halfThick,
            height: effectiveWallHeight,
          });
        }
        if (hasSouth && hasEast) {
          const key = `${col + 0.5},${row + 0.5}`;
          cornerPosts.set(key, {
            x: x + halfCell - halfThick,
            z: z + halfCell - halfThick,
            height: effectiveWallHeight,
          });
        }
      }
    }

    // Second pass: generate walls with proper lengths accounting for corner posts
    for (let row = 0; row < plan.footprint.length; row += 1) {
      for (let col = 0; col < plan.footprint[row].length; col += 1) {
        if (!plan.footprint[row][col]) continue;

        const { x, z } = getCellCenter(
          col,
          row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );
        const halfCell = CELL_SIZE / 2;
        const halfThick = WALL_THICKNESS / 2;

        // Check for corner posts at each wall endpoint using the GLOBAL cornerPosts map
        // This ensures walls are shortened even when the corner post was placed by an adjacent cell
        const hasCornerNW = cornerPosts.has(`${col - 0.5},${row - 0.5}`);
        const hasCornerNE = cornerPosts.has(`${col + 0.5},${row - 0.5}`);
        const hasCornerSW = cornerPosts.has(`${col - 0.5},${row + 0.5}`);
        const hasCornerSE = cornerPosts.has(`${col + 0.5},${row + 0.5}`);

        // Wall segments - calculate length and offset based on corner posts
        // hasStart/hasEnd now check the global corner posts map, not just this cell's corners
        const sides: Array<{
          dc: number;
          dr: number;
          side: string;
          isVertical: boolean;
          hasStart: boolean; // Has corner post at start (negative direction)
          hasEnd: boolean; // Has corner post at end (positive direction)
        }> = [
          {
            dc: -1,
            dr: 0,
            side: "west",
            isVertical: true,
            hasStart: hasCornerNW,
            hasEnd: hasCornerSW,
          },
          {
            dc: 1,
            dr: 0,
            side: "east",
            isVertical: true,
            hasStart: hasCornerNE,
            hasEnd: hasCornerSE,
          },
          {
            dc: 0,
            dr: -1,
            side: "north",
            isVertical: false,
            hasStart: hasCornerNW,
            hasEnd: hasCornerNE,
          },
          {
            dc: 0,
            dr: 1,
            side: "south",
            isVertical: false,
            hasStart: hasCornerSW,
            hasEnd: hasCornerSE,
          },
        ];

        for (const { dc, dr, side, isVertical, hasStart, hasEnd } of sides) {
          const nc = col + dc;
          const nr = row + dr;
          const externalKey = `${col},${row},${side}`;
          const opening = plan.externalOpenings.get(externalKey);

          // Create unique wall key to avoid duplicates
          const wallKey = `${Math.min(col, nc)},${Math.min(row, nr)},${isVertical ? "v" : "h"}`;

          if (!this.isCellOccupied(plan.footprint, nc, nr)) {
            // External wall - only place if not already placed
            if (!placedWalls.has(wallKey)) {
              placedWalls.add(wallKey);

              // Calculate wall length: full cell minus corner posts at each end
              let wallLength = CELL_SIZE;
              let offset = 0;

              if (hasStart) {
                wallLength -= WALL_THICKNESS;
                offset += WALL_THICKNESS / 2;
              }
              if (hasEnd) {
                wallLength -= WALL_THICKNESS;
                offset -= WALL_THICKNESS / 2;
              }

              // Position of wall center
              const ox = isVertical
                ? (-halfCell + halfThick) * (side === "west" ? 1 : -1)
                : offset;
              const oz = isVertical
                ? offset
                : (-halfCell + halfThick) * (side === "north" ? 1 : -1);

              this.addWallWithOpening(
                geometries,
                x + ox,
                y,
                z + oz,
                isVertical ? WALL_THICKNESS : wallLength,
                isVertical ? wallLength : WALL_THICKNESS,
                opening,
                stats,
                isVertical,
                effectiveWallHeight,
                true, // isExternal = true
                windowFrameGeometries,
                windowGlassGeometries,
                doorFrameGeometries,
                shutterGeometries,
                buildingType,
                windowStyle,
                doorStyle,
              );
            }
          } else {
            // Internal wall - check for openings (no corner posts for internal walls)
            const internalKey = `${col},${row}`;
            const internalOpening = plan.internalOpenings.get(internalKey);
            if (internalOpening && !placedWalls.has(wallKey)) {
              placedWalls.add(wallKey);

              const wallLength = CELL_SIZE - WALL_THICKNESS; // Internal walls don't have corner posts
              const ox = isVertical
                ? (-halfCell + halfThick) * (side === "west" ? 1 : -1)
                : 0;
              const oz = isVertical
                ? 0
                : (-halfCell + halfThick) * (side === "north" ? 1 : -1);

              this.addWallWithOpening(
                geometries,
                x + ox,
                y,
                z + oz,
                isVertical ? WALL_THICKNESS : wallLength,
                isVertical ? wallLength : WALL_THICKNESS,
                internalOpening,
                stats,
                isVertical,
                effectiveWallHeight,
                false, // isExternal = false (internal wall)
                windowFrameGeometries,
                windowGlassGeometries,
                doorFrameGeometries,
                shutterGeometries,
                buildingType,
                windowStyle,
                doorStyle,
              );
            }
          }
        }
      }
    }

    // Add corner posts with correct height (use corner color)
    for (const [_key, pos] of cornerPosts) {
      const geometry = new THREE.BoxGeometry(
        WALL_THICKNESS,
        pos.height,
        WALL_THICKNESS,
      );
      geometry.translate(pos.x, y + pos.height / 2, pos.z);
      // Corner posts use wall UV scale for consistency
      applyGeometryAttributes(geometry, palette.wallCorner, "generic", {
        uvScale: UV_SCALE_PRESETS.brick,
        materialId: this.currentWallMaterialId,
      });
      geometries.push(geometry);
    }
  }

  private addWallWithOpening(
    geometries: THREE.BufferGeometry[],
    x: number,
    y: number,
    z: number,
    width: number,
    depth: number,
    opening: string | undefined,
    stats: BuildingStats,
    isVertical: boolean,
    wallHeight: number = WALL_HEIGHT,
    isExternal: boolean = true,
    windowFrameGeometries?: THREE.BufferGeometry[],
    windowGlassGeometries?: THREE.BufferGeometry[],
    doorFrameGeometries?: THREE.BufferGeometry[],
    shutterGeometries?: THREE.BufferGeometry[],
    _buildingType?: string,
    windowStyle?: WindowStyle,
    doorStyle?: import("./DoorTrimGeometry").DoorFrameStyle,
  ): void {
    const wallLength = isVertical ? depth : width;
    const wallThickness = isVertical ? width : depth;

    // Use outer wall color for external walls, inner wall color for internal
    const wallColor = isExternal ? palette.wallOuter : palette.wallInner;
    const uvScale = UV_SCALE_PRESETS.brick;
    const matId = this.currentWallMaterialId;

    if (!opening) {
      // Solid wall
      const geometry = new THREE.BoxGeometry(width, wallHeight, depth);
      geometry.translate(x, y + wallHeight / 2, z);
      applyWallAttributes(geometry, wallColor, isVertical, uvScale, matId);
      geometries.push(geometry);
      stats.wallSegments += 1;
      return;
    }

    // Wall with opening
    const openingWidth =
      opening === "arch"
        ? ARCH_WIDTH
        : opening === "door"
          ? DOOR_WIDTH
          : WINDOW_WIDTH;
    const openingHeight = opening === "window" ? WINDOW_HEIGHT : DOOR_HEIGHT;
    const openingBottom = opening === "window" ? WINDOW_SILL_HEIGHT : 0;
    const sideWidth = Math.max(0, (wallLength - openingWidth) / 2);

    // Left/Front side piece (full wall height)
    if (sideWidth > 0.01) {
      const geo = isVertical
        ? new THREE.BoxGeometry(wallThickness, wallHeight, sideWidth)
        : new THREE.BoxGeometry(sideWidth, wallHeight, wallThickness);
      const offset = wallLength / 2 - sideWidth / 2;
      geo.translate(
        x + (isVertical ? 0 : -offset),
        y + wallHeight / 2,
        z + (isVertical ? -offset : 0),
      );
      applyWallAttributes(geo, wallColor, isVertical, uvScale, matId);
      geometries.push(geo);
    }

    // Right/Back side piece (full wall height)
    if (sideWidth > 0.01) {
      const geo = isVertical
        ? new THREE.BoxGeometry(wallThickness, wallHeight, sideWidth)
        : new THREE.BoxGeometry(sideWidth, wallHeight, wallThickness);
      const offset = wallLength / 2 - sideWidth / 2;
      geo.translate(
        x + (isVertical ? 0 : offset),
        y + wallHeight / 2,
        z + (isVertical ? offset : 0),
      );
      applyWallAttributes(geo, wallColor, isVertical, uvScale, matId);
      geometries.push(geo);
    }

    // Top piece above opening (extends to full wall height)
    const topHeight = wallHeight - openingHeight - openingBottom;
    if (topHeight > 0.01) {
      const geo = isVertical
        ? new THREE.BoxGeometry(wallThickness, topHeight, openingWidth)
        : new THREE.BoxGeometry(openingWidth, topHeight, wallThickness);
      geo.translate(x, y + openingBottom + openingHeight + topHeight / 2, z);
      applyWallAttributes(geo, wallColor, isVertical, uvScale, matId);
      geometries.push(geo);
    }

    // Bottom piece (for windows)
    if (openingBottom > 0.01) {
      const geo = isVertical
        ? new THREE.BoxGeometry(wallThickness, openingBottom, openingWidth)
        : new THREE.BoxGeometry(openingWidth, openingBottom, wallThickness);
      geo.translate(x, y + openingBottom / 2, z);
      applyWallAttributes(geo, wallColor, isVertical, uvScale, matId);
      geometries.push(geo);
    }

    // === Generate window geometry for window openings ===
    if (
      opening === "window" &&
      windowFrameGeometries &&
      windowGlassGeometries &&
      isExternal
    ) {
      const windowConfig: WindowConfig = {
        width: openingWidth,
        height: openingHeight,
        frameThickness: 0.04,
        frameDepth: wallThickness * 0.8,
        style: windowStyle || "crossbar-2x2",
        isVertical,
      };

      const windowResult = createWindowGeometry(windowConfig);

      // Calculate window center position
      const windowCenterY = y + openingBottom + openingHeight / 2;

      // Translate and add frame geometry
      if (windowResult.frame) {
        windowResult.frame.translate(x, windowCenterY, z);
        windowFrameGeometries.push(windowResult.frame);
      }

      // Translate and add glass panes
      for (const pane of windowResult.panes) {
        pane.translate(x, windowCenterY, z);
        windowGlassGeometries.push(pane);
      }

      // Translate and add mullions
      if (windowResult.mullions) {
        windowResult.mullions.translate(x, windowCenterY, z);
        windowFrameGeometries.push(windowResult.mullions);
      }

      // Translate and add sill
      if (windowResult.sill) {
        windowResult.sill.translate(x, y + openingBottom, z);
        windowFrameGeometries.push(windowResult.sill);
      }

      // Translate and add shutters
      if (shutterGeometries) {
        for (const shutter of windowResult.shutters) {
          shutter.translate(x, windowCenterY, z);
          shutterGeometries.push(shutter);
        }
      }
    }

    // === Generate door frame geometry for door/arch openings ===
    if (
      (opening === "door" || opening === "arch") &&
      doorFrameGeometries &&
      isExternal
    ) {
      const isArched = opening === "arch";
      const doorConfig: DoorFrameConfig = isArched
        ? getArchDoorConfig(isVertical)
        : {
            width: openingWidth,
            height: openingHeight,
            frameWidth: 0.08,
            frameDepth: wallThickness * 0.6,
            style: doorStyle || "simple",
            isVertical,
            isArched: false,
            includeThreshold: true,
          };

      const doorResult = createDoorFrameGeometry(doorConfig);

      // Door frame is positioned at floor level of the opening
      const doorY = y;

      // Translate and add frame geometry
      if (doorResult.frame) {
        doorResult.frame.translate(x, doorY, z);
        doorFrameGeometries.push(doorResult.frame);
      }

      // Translate and add threshold
      if (doorResult.threshold) {
        doorResult.threshold.translate(x, doorY, z);
        doorFrameGeometries.push(doorResult.threshold);
      }

      // Translate and add lintel
      if (doorResult.lintel) {
        doorResult.lintel.translate(x, doorY, z);
        doorFrameGeometries.push(doorResult.lintel);
      }

      // Translate and add architrave
      if (doorResult.architrave) {
        doorResult.architrave.translate(x, doorY, z);
        doorFrameGeometries.push(doorResult.architrave);
      }

      // Translate and add arch trim
      if (doorResult.archTrim) {
        doorResult.archTrim.translate(x, doorY, z);
        doorFrameGeometries.push(doorResult.archTrim);
      }
    }

    // Update stats
    stats.wallSegments += 1;
    if (opening === "door") stats.doorways += 1;
    else if (opening === "arch") stats.archways += 1;
    else if (opening === "window") stats.windows += 1;
  }

  private addStairs(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    stats: BuildingStats,
  ): void {
    if (!layout.stairs) return;

    const { col, row, direction } = layout.stairs;
    const { x: cellCenterX, z: cellCenterZ } = getCellCenter(
      col,
      row,
      CELL_SIZE,
      layout.width,
      layout.depth,
    );

    // Get direction vector based on direction name
    const sideVec = getSideVector(direction);
    const dirX = sideVec.x;
    const dirZ = sideVec.z;

    // Stairs span from the back of the stair cell to the landing cell
    // - Stair cell (col,row): contains the actual step geometry
    // - Landing cell: is an adjacent cell with a floor tile at the upper level
    // The stairs must reach the landing cell edge so there's no gap

    // Stairs parameters
    const stepCount = 12; // Steps to climb one floor
    const stepHeight = FLOOR_HEIGHT / stepCount;

    // Width fits within a cell with room for stringers
    const stepWidth = CELL_SIZE - WALL_THICKNESS * 4;
    const stringerThickness = WALL_THICKNESS * 1.5;

    // Bottom landing gives room to approach stairs from below
    const bottomLandingDepth = CELL_SIZE * 0.15;
    // Top of stairs extends to the cell edge (landing tile is in next cell)
    const topOverhang = CELL_SIZE * 0.05; // Slight overhang into landing cell for seamless connection
    // Total run from bottom landing to cell edge + small overhang
    const totalRun = CELL_SIZE - bottomLandingDepth + topOverhang;
    const stepDepth = totalRun / stepCount;

    // Start position - back edge of cell with landing margin
    const stairStartX =
      cellCenterX - dirX * (CELL_SIZE / 2 - bottomLandingDepth);
    const stairStartZ =
      cellCenterZ - dirZ * (CELL_SIZE / 2 - bottomLandingDepth);

    // Base Y position (ground floor)
    const baseY = this.currentFoundationHeight;

    // Create steps as individual treads (within the stair cell)
    for (let i = 0; i < stepCount; i += 1) {
      // Position along the run
      const progress = (i + 0.5) / stepCount;
      const stepX = stairStartX + dirX * totalRun * progress;
      const stepZ = stairStartZ + dirZ * totalRun * progress;

      // Height of this step's top surface
      const stepTopY = baseY + stepHeight * (i + 1);

      // Create step as a solid block from floor to step top
      const fullStepHeight = stepTopY - baseY;

      const geometry = new THREE.BoxGeometry(
        Math.abs(dirZ) > 0.5 ? stepWidth : stepDepth,
        fullStepHeight,
        Math.abs(dirX) > 0.5 ? stepWidth : stepDepth,
      );
      geometry.translate(stepX, baseY + fullStepHeight / 2, stepZ);
      applyGeometryAttributes(geometry, palette.stairs, "generic", {
        uvScale: UV_SCALE_PRESETS.woodPlank,
        materialId: WALL_MATERIAL_IDS.solid,
      });
      geometries.push(geometry);
      stats.stairSteps += 1;
    }

    // Add stair side walls/stringers running along the stairs
    const perpX = -dirZ;
    const perpZ = dirX;

    // Stringer positions (on either side of the steps)
    const leftOffsetX = perpX * (stepWidth / 2 + stringerThickness / 2);
    const leftOffsetZ = perpZ * (stepWidth / 2 + stringerThickness / 2);
    const rightOffsetX = -perpX * (stepWidth / 2 + stringerThickness / 2);
    const rightOffsetZ = -perpZ * (stepWidth / 2 + stringerThickness / 2);

    // Stringers run the length of the stairs, centered on the stair midpoint
    const stringerCenterX = stairStartX + (dirX * totalRun) / 2;
    const stringerCenterZ = stairStartZ + (dirZ * totalRun) / 2;
    const stringerCenterY = baseY + FLOOR_HEIGHT / 2;

    // Left stringer
    const leftStringerGeo = new THREE.BoxGeometry(
      Math.abs(dirZ) > 0.5 ? stringerThickness : totalRun,
      FLOOR_HEIGHT,
      Math.abs(dirX) > 0.5 ? stringerThickness : totalRun,
    );
    leftStringerGeo.translate(
      stringerCenterX + leftOffsetX,
      stringerCenterY,
      stringerCenterZ + leftOffsetZ,
    );
    // Stringers use trim color with solid material (no procedural pattern)
    applyGeometryAttributes(leftStringerGeo, palette.trim, "generic", {
      uvScale: UV_SCALE_PRESETS.woodPlank,
      materialId: WALL_MATERIAL_IDS.solid,
    });
    geometries.push(leftStringerGeo);

    // Right stringer
    const rightStringerGeo = new THREE.BoxGeometry(
      Math.abs(dirZ) > 0.5 ? stringerThickness : totalRun,
      FLOOR_HEIGHT,
      Math.abs(dirX) > 0.5 ? stringerThickness : totalRun,
    );
    rightStringerGeo.translate(
      stringerCenterX + rightOffsetX,
      stringerCenterY,
      stringerCenterZ + rightOffsetZ,
    );
    // Stringers use trim color with solid material (no procedural pattern)
    applyGeometryAttributes(rightStringerGeo, palette.trim, "generic", {
      uvScale: UV_SCALE_PRESETS.woodPlank,
      materialId: WALL_MATERIAL_IDS.solid,
    });
    geometries.push(rightStringerGeo);
  }

  /**
   * Add invisible walkable ramps for interior stairs.
   * These replace the visual box steps for actual walking collision.
   * The ramp is a thin angled plane spanning from one floor to the next.
   */
  private addStairRamps(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
  ): void {
    if (!layout.stairs) return;

    const { col, row, direction, landing } = layout.stairs;
    const { x: cellCenterX, z: cellCenterZ } = getCellCenter(
      col,
      row,
      CELL_SIZE,
      layout.width,
      layout.depth,
    );

    // Get direction vector
    const sideVec = getSideVector(direction);
    const dirX = sideVec.x;
    const dirZ = sideVec.z;

    // Ramp parameters - spans from stair cell to landing cell
    const stepWidth = CELL_SIZE - WALL_THICKNESS * 4;
    // Must match stair geometry parameters
    const bottomLandingDepth = CELL_SIZE * 0.15;
    const topLandingInset = CELL_SIZE * 0.15; // How far into landing cell the ramp ends

    // Base Y position
    const baseY = this.currentFoundationHeight;

    // Start position (bottom of stairs) - matches visual stair start
    const rampStartX =
      cellCenterX - dirX * (CELL_SIZE / 2 - bottomLandingDepth);
    const rampStartZ =
      cellCenterZ - dirZ * (CELL_SIZE / 2 - bottomLandingDepth);

    // End position (landing cell) - should connect with the landing floor tile
    const { x: landingCenterX, z: landingCenterZ } = getCellCenter(
      landing.col,
      landing.row,
      CELL_SIZE,
      layout.width,
      layout.depth,
    );

    // Ramp ends slightly into the landing cell for seamless connection with floor tile
    const rampEndX = landingCenterX - dirX * (CELL_SIZE / 2 - topLandingInset);
    const rampEndZ = landingCenterZ - dirZ * (CELL_SIZE / 2 - topLandingInset);

    const rampLength = Math.sqrt(
      Math.pow(rampEndX - rampStartX, 2) + Math.pow(rampEndZ - rampStartZ, 2),
    );

    // Height change
    const startY = baseY;
    const endY = baseY + FLOOR_HEIGHT;
    const heightDiff = endY - startY;

    // Create plane geometry for the ramp
    const isXAligned = Math.abs(dirX) > 0.5;
    const rampGeo = new THREE.PlaneGeometry(
      isXAligned ? rampLength : stepWidth,
      isXAligned ? stepWidth : rampLength,
    );

    // Calculate ramp center
    const rampCenterX = (rampStartX + rampEndX) / 2;
    const rampCenterZ = (rampStartZ + rampEndZ) / 2;
    const rampCenterY = (startY + endY) / 2;

    // Calculate inclination angle
    const angle = Math.atan2(heightDiff, rampLength);

    // Rotate plane to be horizontal first
    rampGeo.rotateX(-Math.PI / 2);

    // Then tilt based on stair direction
    if (Math.abs(dirZ) > 0.5) {
      // North/South stairs - tilt around X axis
      const tiltAngle = dirZ > 0 ? -angle : angle;
      rampGeo.rotateX(tiltAngle);
    } else {
      // East/West stairs - tilt around Z axis
      const tiltAngle = dirX > 0 ? angle : -angle;
      rampGeo.rotateZ(tiltAngle);
    }

    rampGeo.translate(rampCenterX, rampCenterY, rampCenterZ);

    // Use floor color (ramp is thin and hidden under visual steps)
    applyGeometryAttributes(rampGeo, palette.floor, "generic", {
      uvScale: UV_SCALE_PRESETS.floorTile,
    });

    geometries.push(rampGeo);
  }

  private addRoofPieces(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    stats: BuildingStats,
  ): void {
    const topFloor = layout.floors - 1;
    const plan = layout.floorPlans[topFloor];
    // Roof sits directly on top of the walls (not at floor level above)
    // Wall top = topFloor * FLOOR_HEIGHT + WALL_HEIGHT + currentFoundationHeight
    const y =
      topFloor * FLOOR_HEIGHT + WALL_HEIGHT + this.currentFoundationHeight;

    for (let row = 0; row < plan.footprint.length; row += 1) {
      for (let col = 0; col < plan.footprint[row].length; col += 1) {
        if (!plan.footprint[row][col]) continue;

        const { x, z } = getCellCenter(
          col,
          row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );

        // Check which sides have external walls (no neighbor)
        const hasNorth = !this.isCellOccupied(plan.footprint, col, row - 1);
        const hasSouth = !this.isCellOccupied(plan.footprint, col, row + 1);
        const hasEast = !this.isCellOccupied(plan.footprint, col + 1, row);
        const hasWest = !this.isCellOccupied(plan.footprint, col - 1, row);

        // Calculate roof tile size to align with walls
        let roofSizeX = CELL_SIZE;
        let roofSizeZ = CELL_SIZE;
        let roofOffsetX = 0;
        let roofOffsetZ = 0;

        // Extend roof slightly past walls for overhang effect
        const overhang = WALL_THICKNESS / 2;

        if (hasWest) {
          roofOffsetX -= overhang / 2;
          roofSizeX += overhang;
        }
        if (hasEast) {
          roofOffsetX += overhang / 2;
          roofSizeX += overhang;
        }
        if (hasNorth) {
          roofOffsetZ -= overhang / 2;
          roofSizeZ += overhang;
        }
        if (hasSouth) {
          roofOffsetZ += overhang / 2;
          roofSizeZ += overhang;
        }

        // Flat roof tile
        const geometry = new THREE.BoxGeometry(
          roofSizeX,
          ROOF_THICKNESS,
          roofSizeZ,
        );
        geometry.translate(
          x + roofOffsetX,
          y + ROOF_THICKNESS / 2,
          z + roofOffsetZ,
        );
        applyRoofAttributes(geometry, palette.roof, UV_SCALE_PRESETS.shingle);
        geometries.push(geometry);
        stats.roofPieces += 1;
      }
    }
  }

  // ============================================================
  // PROP PLACEMENT METHODS
  // ============================================================

  /**
   * Find the best placement for an NPC (innkeeper, banker, shopkeeper) with counter.
   * Tries to find 2 adjacent cells for a longer counter, falls back to single cell.
   *
   * RULES:
   * 1. NOT in a stair cell or landing cell - don't block stairs
   * 2. Prefer rooms with external door that are FURTHEST from building centroid
   * 3. Within that room, prefer walls FURTHEST from the door
   * 4. Against a solid wall (no door/window behind the NPC)
   * 5. Prefer longer wall segments (more professional look)
   * 6. Not directly blocking an entrance doorway
   * 7. Avoid cells near stairs
   * 8. Try for 2-tile counter when space allows
   */
  private findNpcPlacement(
    layout: BuildingLayout,
    rng: RNG,
  ): {
    roomId: number;
    col: number;
    row: number;
    side: string;
    secondCell?: { col: number; row: number };
  } | null {
    const groundFloor = layout.floorPlans[0];
    if (!groundFloor || groundFloor.rooms.length === 0) return null;

    // Calculate building centroid
    const centroid = this.calculateFootprintCentroid(
      groundFloor.footprint,
      layout.width,
      layout.depth,
    );

    // Find rooms with external door access and calculate their distance from centroid
    const roomsWithDoors: Array<{
      room: Room;
      doorPositions: Array<{ col: number; row: number; side: string }>;
      distFromCentroid: number;
    }> = [];

    for (const room of groundFloor.rooms) {
      const doorPositions: Array<{ col: number; row: number; side: string }> =
        [];

      for (const cell of room.cells) {
        for (const side of ["north", "south", "east", "west"]) {
          const key = `${cell.col},${cell.row},${side}`;
          const opening = groundFloor.externalOpenings.get(key);
          if (opening === "door" || opening === "arch") {
            doorPositions.push({ col: cell.col, row: cell.row, side });
          }
        }
      }

      if (doorPositions.length > 0) {
        // Calculate room centroid distance from building centroid
        const roomCentroid = this.calculateRoomCentroid(
          room,
          layout.width,
          layout.depth,
        );
        const distFromCentroid = Math.sqrt(
          Math.pow(roomCentroid.x - centroid.x, 2) +
            Math.pow(roomCentroid.z - centroid.z, 2),
        );
        roomsWithDoors.push({ room, doorPositions, distFromCentroid });
      }
    }

    // Sort by distance from centroid (furthest first) - bar should be at the "back" of building
    roomsWithDoors.sort((a, b) => b.distFromCentroid - a.distFromCentroid);

    // If no rooms with doors, fallback to largest room
    const candidateRooms =
      roomsWithDoors.length > 0
        ? roomsWithDoors.map((r) => ({
            room: r.room,
            doorPositions: r.doorPositions,
          }))
        : groundFloor.rooms.map((r) => ({
            room: r,
            doorPositions: [] as Array<{
              col: number;
              row: number;
              side: string;
            }>,
          }));

    // First try to find a 2-tile placement
    for (const { room, doorPositions } of candidateRooms) {
      const placement = this.findBestCellsForNpc(
        layout,
        groundFloor,
        room,
        rng,
        2,
        doorPositions,
      );
      if (placement) {
        return { roomId: room.id, ...placement };
      }
    }

    // Fall back to single-tile placement
    for (const { room, doorPositions } of candidateRooms) {
      const placement = this.findBestCellsForNpc(
        layout,
        groundFloor,
        room,
        rng,
        1,
        doorPositions,
      );
      if (placement) {
        return { roomId: room.id, ...placement };
      }
    }

    return null;
  }

  /**
   * Calculate the centroid of a footprint in world coordinates.
   */
  private calculateFootprintCentroid(
    footprint: boolean[][],
    layoutWidth: number,
    layoutDepth: number,
  ): { x: number; z: number } {
    let sumX = 0;
    let sumZ = 0;
    let count = 0;

    const halfWidth = (layoutWidth * CELL_SIZE) / 2;
    const halfDepth = (layoutDepth * CELL_SIZE) / 2;

    for (let row = 0; row < footprint.length; row++) {
      for (let col = 0; col < (footprint[row]?.length || 0); col++) {
        if (footprint[row][col]) {
          const x = col * CELL_SIZE + CELL_SIZE / 2 - halfWidth;
          const z = row * CELL_SIZE + CELL_SIZE / 2 - halfDepth;
          sumX += x;
          sumZ += z;
          count++;
        }
      }
    }

    return count > 0 ? { x: sumX / count, z: sumZ / count } : { x: 0, z: 0 };
  }

  /**
   * Calculate the centroid of a room in world coordinates.
   */
  private calculateRoomCentroid(
    room: Room,
    layoutWidth: number,
    layoutDepth: number,
  ): { x: number; z: number } {
    let sumX = 0;
    let sumZ = 0;

    const halfWidth = (layoutWidth * CELL_SIZE) / 2;
    const halfDepth = (layoutDepth * CELL_SIZE) / 2;

    for (const cell of room.cells) {
      const x = cell.col * CELL_SIZE + CELL_SIZE / 2 - halfWidth;
      const z = cell.row * CELL_SIZE + CELL_SIZE / 2 - halfDepth;
      sumX += x;
      sumZ += z;
    }

    return room.cells.length > 0
      ? { x: sumX / room.cells.length, z: sumZ / room.cells.length }
      : { x: 0, z: 0 };
  }

  /**
   * Find the best cell(s) and wall side within a room for NPC placement.
   * @param tileCount - Number of tiles to find (1 or 2)
   * @param doorPositions - External door positions in this room (for distance calculation)
   */
  private findBestCellsForNpc(
    layout: BuildingLayout,
    floorPlan: FloorPlan,
    room: Room,
    rng: RNG,
    tileCount: 1 | 2,
    doorPositions: Array<{ col: number; row: number; side: string }> = [],
  ): {
    col: number;
    row: number;
    side: string;
    secondCell?: { col: number; row: number };
  } | null {
    const candidates: Array<{
      col: number;
      row: number;
      side: string;
      score: number;
      secondCell?: { col: number; row: number };
    }> = [];

    // Build a set of room cells for quick lookup
    const roomCellSet = new Set(room.cells.map((c) => `${c.col},${c.row}`));

    // Pre-calculate door positions in grid coordinates for distance checks
    const doorCells = doorPositions.map((d) => ({ col: d.col, row: d.row }));

    for (const cell of room.cells) {
      // RULE 1: Skip stair cells and landing cells
      if (layout.stairs) {
        if (cell.col === layout.stairs.col && cell.row === layout.stairs.row)
          continue;
        if (
          cell.col === layout.stairs.landing.col &&
          cell.row === layout.stairs.landing.row
        )
          continue;
      }

      // RULE 7: Penalty for cells adjacent to stairs (within 1 cell)
      let nearStairs = false;
      if (layout.stairs) {
        const stairDist =
          Math.abs(cell.col - layout.stairs.col) +
          Math.abs(cell.row - layout.stairs.row);
        const landingDist =
          Math.abs(cell.col - layout.stairs.landing.col) +
          Math.abs(cell.row - layout.stairs.landing.row);
        nearStairs = stairDist <= 1 || landingDist <= 1;
      }

      // Check each wall side of this cell
      for (const side of ["north", "south", "east", "west"] as const) {
        // Check if this cell is valid for NPC placement on this side
        if (!this.isValidNpcCell(layout, floorPlan, cell.col, cell.row, side))
          continue;

        // For 2-tile placement, find an adjacent cell along the wall
        let secondCell: { col: number; row: number } | undefined;
        if (tileCount === 2) {
          secondCell = this.findAdjacentNpcCell(
            layout,
            floorPlan,
            room,
            cell.col,
            cell.row,
            side,
            roomCellSet,
          );
          if (!secondCell) continue; // Need 2 cells but can't find adjacent valid cell
        }

        // Calculate base placement score
        let score = this.scoreNpcPlacement(
          floorPlan,
          room,
          cell.col,
          cell.row,
          side,
        );

        // RULE 3: Prefer walls FURTHEST from doors in the room
        if (doorCells.length > 0) {
          // Calculate minimum distance to any door
          let minDoorDist = Infinity;
          for (const door of doorCells) {
            const dist =
              Math.abs(cell.col - door.col) + Math.abs(cell.row - door.row);
            minDoorDist = Math.min(minDoorDist, dist);
          }
          // Bonus for being far from doors (up to +20 for 4+ cells away)
          score += Math.min(minDoorDist * 5, 20);
        }

        // RULE 7: Penalty for being near stairs
        if (nearStairs) {
          score -= 25;
        }

        // Bonus for 2-tile counter (more professional)
        if (secondCell) {
          score += 25;
          // Add score from second cell too
          score +=
            this.scoreNpcPlacement(
              floorPlan,
              room,
              secondCell.col,
              secondCell.row,
              side,
            ) * 0.5;

          // Also check second cell's distance from doors
          if (doorCells.length > 0) {
            let minDoorDist2 = Infinity;
            for (const door of doorCells) {
              const dist =
                Math.abs(secondCell.col - door.col) +
                Math.abs(secondCell.row - door.row);
              minDoorDist2 = Math.min(minDoorDist2, dist);
            }
            score += Math.min(minDoorDist2 * 2.5, 10);
          }
        }

        candidates.push({
          col: cell.col,
          row: cell.row,
          side,
          score,
          secondCell,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by score and pick from top candidates
    candidates.sort((a, b) => b.score - a.score);
    const topScore = candidates[0].score;
    const topCandidates = candidates.filter((c) => c.score >= topScore - 5);

    const picked = rng.pick(topCandidates)!;
    return {
      col: picked.col,
      row: picked.row,
      side: picked.side,
      secondCell: picked.secondCell,
    };
  }

  /**
   * Check if a cell is valid for NPC placement on a given side.
   */
  private isValidNpcCell(
    layout: BuildingLayout,
    floorPlan: FloorPlan,
    col: number,
    row: number,
    side: string,
  ): boolean {
    // Skip stair cells
    if (layout.stairs) {
      if (col === layout.stairs.col && row === layout.stairs.row) return false;
      if (
        col === layout.stairs.landing.col &&
        row === layout.stairs.landing.row
      )
        return false;
    }

    const wallKey = `${col},${row},${side}`;

    // Must be against a solid external wall (no opening behind NPC)
    const externalOpening = floorPlan.externalOpenings.get(wallKey);
    if (externalOpening) return false;

    // Check if this side is an external wall
    const { dc, dr } = this.getSideOffset(side);
    const neighborCol = col + dc;
    const neighborRow = row + dr;
    const isExternalWall = !this.isCellOccupied(
      floorPlan.footprint,
      neighborCol,
      neighborRow,
    );

    if (!isExternalWall) return false;

    // Bar should not be adjacent to a door tile
    // Check all adjacent cells (perpendicular to wall) for doors
    const perpDc = side === "north" || side === "south" ? 1 : 0;
    const perpDr = side === "east" || side === "west" ? 1 : 0;

    // Check both perpendicular neighbors
    for (const dir of [1, -1]) {
      const adjCol = col + perpDc * dir;
      const adjRow = row + perpDr * dir;

      // Check if adjacent cell has a door on any side
      for (const adjSide of ["north", "south", "east", "west"]) {
        const adjKey = `${adjCol},${adjRow},${adjSide}`;
        const adjOpening = floorPlan.externalOpenings.get(adjKey);
        if (adjOpening === "door" || adjOpening === "arch") {
          return false; // Adjacent to a door - not valid for bar
        }
      }
    }

    // Also check the cell itself for doors on other sides
    for (const checkSide of ["north", "south", "east", "west"]) {
      if (checkSide === side) continue; // Already checked this side (it's behind the NPC)
      const checkKey = `${col},${row},${checkSide}`;
      const checkOpening = floorPlan.externalOpenings.get(checkKey);
      if (checkOpening === "door" || checkOpening === "arch") {
        return false; // This cell has a door on another side - not ideal for bar
      }
    }

    return true;
  }

  /**
   * Find an adjacent cell along the same wall that's also valid for NPC placement.
   * The 2-tile bar should not extend through walls or be adjacent to doors.
   */
  private findAdjacentNpcCell(
    layout: BuildingLayout,
    floorPlan: FloorPlan,
    _room: Room,
    col: number,
    row: number,
    side: string,
    roomCellSet: Set<string>,
  ): { col: number; row: number } | undefined {
    // Get perpendicular direction (along the wall)
    const perpDc = side === "north" || side === "south" ? 1 : 0;
    const perpDr = side === "east" || side === "west" ? 1 : 0;

    // Check both directions along the wall
    const directions = [
      { col: col + perpDc, row: row + perpDr },
      { col: col - perpDc, row: row - perpDr },
    ];

    for (const adj of directions) {
      // Must be in the same room (ensures bar doesn't go through internal walls)
      if (!roomCellSet.has(`${adj.col},${adj.row}`)) continue;

      // Must exist in footprint (ensures bar doesn't extend outside building)
      if (!this.isCellOccupied(floorPlan.footprint, adj.col, adj.row)) continue;

      // Must also be valid for NPC placement on the same side
      // This checks for doors, stairs, etc.
      if (!this.isValidNpcCell(layout, floorPlan, adj.col, adj.row, side))
        continue;

      // Additional check: ensure this cell also has the same external wall on the same side
      // (bar should be against a continuous wall, not extending past a corner)
      const { dc, dr } = this.getSideOffset(side);
      const neighborCol = adj.col + dc;
      const neighborRow = adj.row + dr;
      const isExternalWall = !this.isCellOccupied(
        floorPlan.footprint,
        neighborCol,
        neighborRow,
      );
      if (!isExternalWall) continue;

      return { col: adj.col, row: adj.row };
    }

    return undefined;
  }

  /**
   * Calculate a score for NPC placement at a specific cell and side.
   * Note: Distance from doors is handled separately in findBestCellsForNpc.
   */
  private scoreNpcPlacement(
    floorPlan: FloorPlan,
    _room: Room,
    col: number,
    row: number,
    side: string,
  ): number {
    let score = 0;

    // Prefer walls that are part of longer wall segments (more professional bar)
    const wallLength = this.measureWallLength(
      floorPlan.footprint,
      col,
      row,
      side,
    );
    score += wallLength * 5;

    // Prefer cells not in corners (bar should be centered on wall)
    const externalEdgeCount = this.countExternalEdges(
      floorPlan.footprint,
      col,
      row,
    );
    if (externalEdgeCount >= 2) {
      score -= 10;
    }

    // Bonus for cells with more interior neighbors (NPC faces toward customers)
    const interiorNeighbors = 4 - externalEdgeCount;
    score += interiorNeighbors * 3;

    // Penalty if door is directly in front of NPC (don't block entrance)
    const oppositeSide = this.getOppositeSide(side);
    const oppositeKey = `${col},${row},${oppositeSide}`;
    const oppositeOpening = floorPlan.externalOpenings.get(oppositeKey);
    if (oppositeOpening === "door" || oppositeOpening === "arch") {
      // This would put the bar right at the entrance - avoid!
      score -= 20;
    }

    // Penalty for window directly in front of NPC (looks odd facing a window)
    if (oppositeOpening === "window") {
      score -= 15;
    }

    // Penalty for windows on adjacent cells along the same wall side.
    // A bar next to a window on the backing wall looks wrong visually.
    const perpDc = side === "north" || side === "south" ? 1 : 0;
    const perpDr = side === "east" || side === "west" ? 1 : 0;
    for (const dir of [1, -1]) {
      const adjCol = col + perpDc * dir;
      const adjRow = row + perpDr * dir;
      // Check if adjacent cell along the wall has a window on the same side
      const adjKey = `${adjCol},${adjRow},${side}`;
      const adjOpening = floorPlan.externalOpenings.get(adjKey);
      if (adjOpening === "window") {
        score -= 10;
      }
    }

    return score;
  }

  /**
   * Measure how long a wall segment is (how many consecutive cells share this external edge).
   */
  private measureWallLength(
    footprint: boolean[][],
    col: number,
    row: number,
    side: string,
  ): number {
    const { dc, dr } = this.getSideOffset(side);
    const perpDc = side === "north" || side === "south" ? 1 : 0;
    const perpDr = side === "east" || side === "west" ? 1 : 0;

    let length = 1;

    // Count in positive perpendicular direction
    let checkCol = col + perpDc;
    let checkRow = row + perpDr;
    while (
      this.isCellOccupied(footprint, checkCol, checkRow) &&
      !this.isCellOccupied(footprint, checkCol + dc, checkRow + dr)
    ) {
      length += 1;
      checkCol += perpDc;
      checkRow += perpDr;
    }

    // Count in negative perpendicular direction
    checkCol = col - perpDc;
    checkRow = row - perpDr;
    while (
      this.isCellOccupied(footprint, checkCol, checkRow) &&
      !this.isCellOccupied(footprint, checkCol + dc, checkRow + dr)
    ) {
      length += 1;
      checkCol -= perpDc;
      checkRow -= perpDr;
    }

    return length;
  }

  /**
   * Get the offset for a side direction.
   */
  private getSideOffset(side: string): { dc: number; dr: number } {
    switch (side) {
      case "north":
        return { dc: 0, dr: -1 };
      case "south":
        return { dc: 0, dr: 1 };
      case "east":
        return { dc: 1, dr: 0 };
      case "west":
        return { dc: -1, dr: 0 };
      default:
        return { dc: 0, dr: 0 };
    }
  }

  /**
   * Get the opposite side.
   */
  private getOppositeSide(side: string): string {
    switch (side) {
      case "north":
        return "south";
      case "south":
        return "north";
      case "east":
        return "west";
      case "west":
        return "east";
      default:
        return side;
    }
  }

  private reserveInnBarPlacement(
    layout: BuildingLayout,
    _recipe: BuildingRecipe,
    rng: RNG,
  ): { roomId: number; col: number; row: number; side: string } | null {
    return this.findNpcPlacement(layout, rng);
  }

  private reserveBankCounterPlacement(
    layout: BuildingLayout,
    _recipe: BuildingRecipe,
    rng: RNG,
  ): { roomId: number; col: number; row: number; side: string } | null {
    return this.findNpcPlacement(layout, rng);
  }

  /**
   * Reserve a forge placement for smithy buildings.
   * The blacksmith NPC will stand near the forge.
   */
  private reserveForgePlacement(
    layout: BuildingLayout,
    _rng: RNG,
  ): { col: number; row: number } | null {
    const groundFloor = layout.floorPlans[0];
    if (!groundFloor || groundFloor.rooms.length === 0) return null;

    // Pick the first room's first cell for forge placement
    // (deterministic, could use rng for variety if needed)
    const room = groundFloor.rooms[0];
    if (room.cells.length === 0) return null;

    const cell = room.cells[0];
    return { col: cell.col, row: cell.row };
  }

  private addBuildingProps(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    _recipe: BuildingRecipe,
    typeKey: string,
    _rng: RNG,
    stats: BuildingStats,
    propPlacements: PropPlacements,
  ): void {
    if (typeKey === "inn" && propPlacements.innBar) {
      const { col, row, side, secondCell } = propPlacements.innBar;
      this.addCounterWithNpc(
        geometries,
        layout,
        col,
        row,
        side,
        secondCell,
        palette.bar,
        palette.innkeeper,
        stats,
      );
    }

    if (typeKey === "bank" && propPlacements.bankCounter) {
      const { col, row, side, secondCell } = propPlacements.bankCounter;
      this.addCounterWithNpc(
        geometries,
        layout,
        col,
        row,
        side,
        secondCell,
        palette.counter,
        palette.banker,
        stats,
      );
    }

    if (typeKey === "smithy" && propPlacements.forge) {
      const { col, row } = propPlacements.forge;
      const { x, z } = getCellCenter(
        col,
        row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );
      this.addForgeProps(geometries, x, this.currentFoundationHeight, z, stats);
    }
  }

  /**
   * Add a counter (bar/service desk), supporting 1 or 2 tile placements.
   * NPC placeholder cubes have been removed - actual NPCs are spawned by TownSystem.
   */
  private addCounterWithNpc(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    col: number,
    row: number,
    side: string,
    secondCell: { col: number; row: number } | undefined,
    counterColor: THREE.Color,
    _npcColor: THREE.Color, // No longer used - NPCs spawned separately
    stats: BuildingStats,
  ): void {
    const { x: x1, z: z1 } = getCellCenter(
      col,
      row,
      CELL_SIZE,
      layout.width,
      layout.depth,
    );

    if (secondCell) {
      // 2-tile counter: calculate center between the two cells
      const { x: x2, z: z2 } = getCellCenter(
        secondCell.col,
        secondCell.row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );
      const centerX = (x1 + x2) / 2;
      const centerZ = (z1 + z2) / 2;

      // Counter spans both cells
      this.addCounter(
        geometries,
        centerX,
        this.currentFoundationHeight,
        centerZ,
        side,
        counterColor,
        stats,
        2,
      );
      // NPC placeholder removed - actual NPCs spawned by TownSystem using propPlacements
    } else {
      // Single-tile counter
      this.addCounter(
        geometries,
        x1,
        this.currentFoundationHeight,
        z1,
        side,
        counterColor,
        stats,
        1,
      );
      // NPC placeholder removed - actual NPCs spawned by TownSystem using propPlacements
    }
  }

  private addCounter(
    geometries: THREE.BufferGeometry[],
    x: number,
    y: number,
    z: number,
    side: string,
    color: THREE.Color,
    stats: BuildingStats,
    tileCount: number = 1,
  ): void {
    const vec = getSideVector(side);
    // Position counter between NPC (behind) and customers (in front)
    // COUNTER_WALL_OFFSET places the counter center at the right distance
    // from cell center toward the wall, leaving room for the NPC behind it
    const offsetX = vec.x * COUNTER_WALL_OFFSET;
    const offsetZ = vec.z * COUNTER_WALL_OFFSET;

    const isNS = side === "north" || side === "south";

    // Counter length scales with tile count
    const counterLength = COUNTER_LENGTH + (tileCount - 1) * CELL_SIZE * 0.8;

    const geometry = new THREE.BoxGeometry(
      isNS ? counterLength : COUNTER_DEPTH,
      COUNTER_HEIGHT,
      isNS ? COUNTER_DEPTH : counterLength,
    );
    geometry.translate(x + offsetX, y + COUNTER_HEIGHT / 2, z + offsetZ);
    // Counter uses wood plank UVs
    applyGeometryAttributes(geometry, color, "generic", {
      uvScale: UV_SCALE_PRESETS.woodPlank,
    });
    geometries.push(geometry);
    stats.props += 1;
  }

  // Note: addNpcCube removed - NPC placeholders are no longer generated.
  // Actual NPCs are spawned by TownSystem using propPlacements data.

  private addForgeProps(
    geometries: THREE.BufferGeometry[],
    x: number,
    y: number,
    z: number,
    stats: BuildingStats,
  ): void {
    // Forge
    const forgeGeo = new THREE.BoxGeometry(FORGE_SIZE, FORGE_SIZE, FORGE_SIZE);
    forgeGeo.translate(x - CELL_SIZE / 4, y + FORGE_SIZE / 2, z);
    // Forge uses brick UVs
    applyGeometryAttributes(forgeGeo, palette.forge, "generic", {
      uvScale: UV_SCALE_PRESETS.brick,
    });
    geometries.push(forgeGeo);
    stats.props += 1;

    // Anvil
    const anvilGeo = new THREE.BoxGeometry(
      ANVIL_SIZE,
      ANVIL_SIZE * 0.6,
      ANVIL_SIZE * 1.5,
    );
    anvilGeo.translate(x + CELL_SIZE / 4, y + (ANVIL_SIZE * 0.6) / 2, z);
    // Anvil uses generic UVs for metal texture
    applyGeometryAttributes(anvilGeo, palette.anvil, "generic", {
      uvScale: 0.5,
    });
    geometries.push(anvilGeo);
    stats.props += 1;
  }

  // ============================================================
  // INTERIOR FURNITURE SYSTEM
  // ============================================================

  /**
   * Configuration for what furniture a room should contain.
   */
  private getRoomFurnitureConfig(
    typeKey: string,
    room: Room,
    _floorPlan: FloorPlan,
    floor: number,
    hasPropInRoom: boolean,
  ): {
    tables: number;
    chairsPerTable: number;
    bookshelves: number;
    barrels: number;
    sconces: number;
  } {
    const roomArea = room.area; // In cells

    // Base: at least 1 sconce per room, more for larger rooms
    const config = {
      tables: 0,
      chairsPerTable: 2,
      bookshelves: 0,
      barrels: 0,
      sconces: Math.max(1, Math.floor(roomArea / 2)),
    };

    // Single-cell rooms only get sconces (too small for furniture)
    if (roomArea < 2) {
      return config;
    }

    switch (typeKey) {
      case "inn":
        if (floor === 0 && hasPropInRoom) {
          // Bar room: barrels near the bar, extra sconces for atmosphere
          config.barrels = Math.min(2, roomArea - 1);
          config.sconces = Math.max(2, config.sconces);
        } else if (floor === 0) {
          // Dining/common rooms: tables and chairs
          config.tables = Math.min(roomArea - 1, 3);
          config.chairsPerTable = roomArea >= 3 ? 4 : 2;
        } else {
          // Upper floor rooms: small table, bookshelf
          config.tables = 1;
          config.chairsPerTable = 2;
          config.bookshelves = 1;
        }
        break;

      case "bank":
        // Banks: lots of bookshelves (ledgers/records)
        config.bookshelves = Math.min(roomArea, 3);
        if (!hasPropInRoom && roomArea >= 2) {
          config.tables = 1;
          config.chairsPerTable = 2;
        }
        break;

      case "simple-house":
        if (roomArea >= 2) {
          config.tables = 1;
          config.chairsPerTable = roomArea >= 3 ? 4 : 2;
          config.bookshelves = 1;
        }
        break;

      case "long-house":
        if (roomArea >= 2) {
          config.tables = 1;
          config.chairsPerTable = Math.min(roomArea + 1, 4);
        }
        if (roomArea >= 3) {
          config.bookshelves = 1;
        }
        break;

      case "store":
        // Stores: shelving and storage
        config.barrels = Math.min(roomArea, 3);
        config.bookshelves = Math.min(roomArea - 1, 2);
        break;

      case "smithy":
        if (!hasPropInRoom) {
          config.barrels = Math.min(2, roomArea);
        }
        break;

      case "mansion":
        if (floor === 0) {
          config.tables = Math.min(roomArea - 1, 2);
          config.chairsPerTable = 4;
          config.bookshelves = Math.min(roomArea - 1, 2);
        } else {
          config.tables = 1;
          config.chairsPerTable = 2;
          config.bookshelves = Math.min(roomArea, 2);
        }
        break;

      case "keep":
      case "fortress":
        config.tables = roomArea >= 2 ? 1 : 0;
        config.chairsPerTable = 2;
        config.bookshelves = 1;
        config.barrels = roomArea >= 3 ? 1 : 0;
        break;

      case "church":
      case "cathedral":
        // Large open rooms: minimal furniture, more bookshelves
        if (roomArea >= 4) {
          config.tables = 1; // Altar table
          config.chairsPerTable = 0; // No chairs at altar
        }
        config.bookshelves = Math.min(roomArea - 1, 2);
        config.sconces = Math.max(2, Math.floor(roomArea));
        break;

      case "guild-hall":
        if (floor === 0 && roomArea >= 4) {
          config.tables = Math.min(roomArea - 2, 3);
          config.chairsPerTable = 4;
          config.bookshelves = 2;
        } else {
          config.tables = roomArea >= 2 ? 1 : 0;
          config.chairsPerTable = 2;
          config.bookshelves = Math.min(roomArea, 2);
        }
        break;

      default:
        // Generic: small table and bookshelf for any untyped building
        if (roomArea >= 2) {
          config.tables = 1;
          config.chairsPerTable = 2;
          config.bookshelves = 1;
        }
        break;
    }

    return config;
  }

  /**
   * Place all interior furniture for the building.
   * Called from buildBuilding() after props (counters, forges) but before lighting.
   */
  private addInteriorFurniture(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    typeKey: string,
    rng: RNG,
    stats: BuildingStats,
    propPlacements: PropPlacements,
  ): void {
    // Build set of occupied cells (counters, forge, stairs)
    const occupiedCells = new Set<string>();

    if (layout.stairs) {
      occupiedCells.add(`${layout.stairs.col},${layout.stairs.row}`);
      occupiedCells.add(
        `${layout.stairs.landing.col},${layout.stairs.landing.row}`,
      );
    }

    if (propPlacements.innBar) {
      occupiedCells.add(
        `${propPlacements.innBar.col},${propPlacements.innBar.row}`,
      );
      if (propPlacements.innBar.secondCell) {
        occupiedCells.add(
          `${propPlacements.innBar.secondCell.col},${propPlacements.innBar.secondCell.row}`,
        );
      }
    }
    if (propPlacements.bankCounter) {
      occupiedCells.add(
        `${propPlacements.bankCounter.col},${propPlacements.bankCounter.row}`,
      );
      if (propPlacements.bankCounter.secondCell) {
        occupiedCells.add(
          `${propPlacements.bankCounter.secondCell.col},${propPlacements.bankCounter.secondCell.row}`,
        );
      }
    }
    if (propPlacements.forge) {
      occupiedCells.add(
        `${propPlacements.forge.col},${propPlacements.forge.row}`,
      );
    }

    // Determine which rooms have existing props (for furniture config)
    const propRoomIds = new Set<number>();
    if (propPlacements.innBar) propRoomIds.add(propPlacements.innBar.roomId);
    if (propPlacements.bankCounter)
      propRoomIds.add(propPlacements.bankCounter.roomId);
    // Forge doesn't have roomId, mark the room containing the forge cell
    if (propPlacements.forge) {
      const groundFloor = layout.floorPlans[0];
      if (groundFloor) {
        const forgeRoomId =
          groundFloor.roomMap[propPlacements.forge.row]?.[
            propPlacements.forge.col
          ];
        if (forgeRoomId !== undefined) propRoomIds.add(forgeRoomId);
      }
    }

    for (let floor = 0; floor < layout.floors; floor++) {
      const floorPlan = layout.floorPlans[floor];
      const floorY = floor * FLOOR_HEIGHT + this.currentFoundationHeight;

      for (const room of floorPlan.rooms) {
        const hasPropInRoom = floor === 0 && propRoomIds.has(room.id);
        const config = this.getRoomFurnitureConfig(
          typeKey,
          room,
          floorPlan,
          floor,
          hasPropInRoom,
        );

        // Available cells (not occupied by props/stairs)
        const availableCells = room.cells.filter(
          (c) => !occupiedCells.has(`${c.col},${c.row}`),
        );
        if (availableCells.length === 0) continue;

        // Track cells used by furniture within this room
        const roomOccupied = new Set<string>();

        // Place tables and chairs (center of room)
        if (config.tables > 0) {
          this.placeTablesInRoom(
            geometries,
            layout,
            availableCells,
            floorY,
            config.tables,
            config.chairsPerTable,
            roomOccupied,
            rng,
            stats,
            floorPlan,
          );
        }

        // Place bookshelves against walls
        if (config.bookshelves > 0) {
          this.placeBookshelvesInRoom(
            geometries,
            layout,
            floorPlan,
            room,
            availableCells,
            floorY,
            config.bookshelves,
            roomOccupied,
            rng,
            stats,
          );
        }

        // Place barrels/crates
        if (config.barrels > 0) {
          this.placeBarrelsInRoom(
            geometries,
            layout,
            floorPlan,
            room,
            availableCells,
            floorY,
            config.barrels,
            roomOccupied,
            rng,
            stats,
          );
        }

        // Place wall sconces (visible fixtures)
        if (config.sconces > 0) {
          this.placeSconcesInRoom(
            geometries,
            layout,
            floorPlan,
            room,
            floorY,
            config.sconces,
            rng,
            stats,
          );
        }
      }
    }
  }

  // ============================================================
  // TABLE + CHAIR PLACEMENT
  // ============================================================

  /**
   * Place tables with chairs in a room.
   * Tables go in center-most available cells, chairs surround each table.
   */
  private placeTablesInRoom(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    availableCells: Cell[],
    floorY: number,
    tableCount: number,
    chairsPerTable: number,
    roomOccupied: Set<string>,
    rng: RNG,
    stats: BuildingStats,
    floorPlan?: FloorPlan,
  ): void {
    // Filter out cells that would produce awkward placements:
    // - Cells with external doors (table would block the entrance)
    // - Cells adjacent to stairs (chairs would crowd the stairway)
    const validCells = availableCells.filter((c) => {
      if (roomOccupied.has(`${c.col},${c.row}`)) return false;
      // Skip cells with external doors/arches
      if (floorPlan && this.cellHasExternalDoor(floorPlan, c.col, c.row))
        return false;
      // Skip cells adjacent to stairs (1-cell buffer)
      if (this.isCellAdjacentToStairs(layout, c.col, c.row)) return false;
      return true;
    });

    // Sort cells by how "central" they are
    const cellScores = validCells
      .map((c) => {
        const { x, z } = getCellCenter(
          c.col,
          c.row,
          CELL_SIZE,
          layout.width,
          layout.depth,
        );
        // Prefer cells closer to the center of the building footprint
        const distFromCenter = Math.sqrt(x * x + z * z);
        return { cell: c, score: -distFromCenter + rng.next() * 0.5 };
      })
      .sort((a, b) => b.score - a.score);

    let placed = 0;
    for (const { cell } of cellScores) {
      if (placed >= tableCount) break;
      if (roomOccupied.has(`${cell.col},${cell.row}`)) continue;

      const { x, z } = getCellCenter(
        cell.col,
        cell.row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );

      // Slight random offset within cell for natural variation
      const offsetX = (rng.next() - 0.5) * 0.4;
      const offsetZ = (rng.next() - 0.5) * 0.4;

      this.createTableGeometry(
        geometries,
        x + offsetX,
        floorY,
        z + offsetZ,
        stats,
      );

      // Place chairs around the table
      if (chairsPerTable > 0) {
        this.createChairsAroundTable(
          geometries,
          x + offsetX,
          floorY,
          z + offsetZ,
          chairsPerTable,
          rng,
          stats,
        );
      }

      roomOccupied.add(`${cell.col},${cell.row}`);
      placed++;
    }
  }

  /**
   * Create table geometry: a top slab on 4 legs.
   */
  private createTableGeometry(
    geometries: THREE.BufferGeometry[],
    x: number,
    floorY: number,
    z: number,
    stats: BuildingStats,
  ): void {
    // Table top
    const topGeo = new THREE.BoxGeometry(
      TABLE_WIDTH,
      TABLE_TOP_THICKNESS,
      TABLE_DEPTH,
    );
    topGeo.translate(x, floorY + TABLE_HEIGHT - TABLE_TOP_THICKNESS / 2, z);
    applyGeometryAttributes(topGeo, palette.table, "generic", {
      uvScale: UV_SCALE_PRESETS.woodPlank,
    });
    geometries.push(topGeo);

    // 4 legs at corners
    const legHeight = TABLE_HEIGHT - TABLE_TOP_THICKNESS;
    const legInsetX = TABLE_WIDTH / 2 - TABLE_LEG_SIZE;
    const legInsetZ = TABLE_DEPTH / 2 - TABLE_LEG_SIZE;

    for (const [dx, dz] of [
      [-legInsetX, -legInsetZ],
      [legInsetX, -legInsetZ],
      [-legInsetX, legInsetZ],
      [legInsetX, legInsetZ],
    ] as [number, number][]) {
      const legGeo = new THREE.BoxGeometry(
        TABLE_LEG_SIZE,
        legHeight,
        TABLE_LEG_SIZE,
      );
      legGeo.translate(x + dx, floorY + legHeight / 2, z + dz);
      applyGeometryAttributes(legGeo, palette.table, "generic", {
        uvScale: UV_SCALE_PRESETS.woodPlank,
      });
      geometries.push(legGeo);
    }

    stats.props += 1;
  }

  /**
   * Place chairs around a table at cardinal positions.
   * Chairs face toward the table center.
   */
  private createChairsAroundTable(
    geometries: THREE.BufferGeometry[],
    tableX: number,
    floorY: number,
    tableZ: number,
    count: number,
    rng: RNG,
    stats: BuildingStats,
  ): void {
    // Chair positions: N, S, E, W of the table
    const chairPositions: Array<{
      dx: number;
      dz: number;
      backDx: number;
      backDz: number;
    }> = [
      {
        // North side of table
        dx: 0,
        dz: -(TABLE_DEPTH / 2 + CHAIR_TABLE_GAP + CHAIR_DEPTH / 2),
        backDx: 0,
        backDz: -CHAIR_DEPTH / 2 + CHAIR_BACK_THICKNESS / 2,
      },
      {
        // South side
        dx: 0,
        dz: TABLE_DEPTH / 2 + CHAIR_TABLE_GAP + CHAIR_DEPTH / 2,
        backDx: 0,
        backDz: CHAIR_DEPTH / 2 - CHAIR_BACK_THICKNESS / 2,
      },
      {
        // East side
        dx: TABLE_WIDTH / 2 + CHAIR_TABLE_GAP + CHAIR_DEPTH / 2,
        dz: 0,
        backDx: CHAIR_DEPTH / 2 - CHAIR_BACK_THICKNESS / 2,
        backDz: 0,
      },
      {
        // West side
        dx: -(TABLE_WIDTH / 2 + CHAIR_TABLE_GAP + CHAIR_DEPTH / 2),
        dz: 0,
        backDx: -(CHAIR_DEPTH / 2 - CHAIR_BACK_THICKNESS / 2),
        backDz: 0,
      },
    ];

    // Shuffle and take requested count
    const shuffled = [...chairPositions];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (let i = 0; i < Math.min(count, shuffled.length); i++) {
      const pos = shuffled[i];
      const cx = tableX + pos.dx;
      const cz = tableZ + pos.dz;

      // Chair seat (box representing the seat structure)
      const seatGeo = new THREE.BoxGeometry(
        CHAIR_WIDTH,
        CHAIR_SEAT_HEIGHT,
        CHAIR_DEPTH,
      );
      seatGeo.translate(cx, floorY + CHAIR_SEAT_HEIGHT / 2, cz);
      applyGeometryAttributes(seatGeo, palette.chair, "generic", {
        uvScale: UV_SCALE_PRESETS.woodPlank,
      });
      geometries.push(seatGeo);

      // Chair back
      const isNS = Math.abs(pos.dz) > Math.abs(pos.dx);
      const backGeo = new THREE.BoxGeometry(
        isNS ? CHAIR_WIDTH : CHAIR_BACK_THICKNESS,
        CHAIR_BACK_HEIGHT,
        isNS ? CHAIR_BACK_THICKNESS : CHAIR_WIDTH,
      );
      backGeo.translate(
        cx + pos.backDx,
        floorY + CHAIR_SEAT_HEIGHT + CHAIR_BACK_HEIGHT / 2,
        cz + pos.backDz,
      );
      applyGeometryAttributes(backGeo, palette.chair, "generic", {
        uvScale: UV_SCALE_PRESETS.woodPlank,
      });
      geometries.push(backGeo);

      stats.props += 1;
    }
  }

  // ============================================================
  // BOOKSHELF PLACEMENT
  // ============================================================

  /**
   * Place bookshelves against available walls in a room.
   * Bookshelves go against solid external walls without openings.
   */
  private placeBookshelvesInRoom(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    floorPlan: FloorPlan,
    room: Room,
    availableCells: Cell[],
    floorY: number,
    count: number,
    roomOccupied: Set<string>,
    rng: RNG,
    stats: BuildingStats,
  ): void {
    // Find wall positions suitable for bookshelves
    const wallPositions = this.findFurnitureWallPositions(
      floorPlan,
      room,
      availableCells,
      roomOccupied,
      layout,
    );

    // Shuffle for variety
    for (let i = wallPositions.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [wallPositions[i], wallPositions[j]] = [
        wallPositions[j],
        wallPositions[i],
      ];
    }

    let placed = 0;
    for (const wp of wallPositions) {
      if (placed >= count) break;

      const { x, z } = getCellCenter(
        wp.col,
        wp.row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );

      // Position bookshelf against the wall
      const vec = getSideVector(wp.side);
      const wallDist =
        CELL_SIZE / 2 - WALL_THICKNESS / 2 - BOOKSHELF_DEPTH / 2 - 0.02;
      const bx = x + vec.x * wallDist;
      const bz = z + vec.z * wallDist;

      // Bookshelf oriented along the wall
      const isNS = wp.side === "north" || wp.side === "south";
      const geo = new THREE.BoxGeometry(
        isNS ? BOOKSHELF_WIDTH : BOOKSHELF_DEPTH,
        BOOKSHELF_HEIGHT,
        isNS ? BOOKSHELF_DEPTH : BOOKSHELF_WIDTH,
      );
      geo.translate(bx, floorY + BOOKSHELF_HEIGHT / 2, bz);
      applyGeometryAttributes(geo, palette.bookshelf, "generic", {
        uvScale: UV_SCALE_PRESETS.woodPlank,
      });
      geometries.push(geo);

      // Add shelf lines (thin slabs) for visual detail - 3 shelves
      for (let s = 1; s <= 3; s++) {
        const shelfY =
          floorY + (s / 4) * BOOKSHELF_HEIGHT + BOOKSHELF_SHELF_THICKNESS;
        const shelfGeo = new THREE.BoxGeometry(
          isNS
            ? BOOKSHELF_WIDTH + 0.02
            : BOOKSHELF_DEPTH + BOOKSHELF_SHELF_THICKNESS,
          BOOKSHELF_SHELF_THICKNESS,
          isNS
            ? BOOKSHELF_DEPTH + BOOKSHELF_SHELF_THICKNESS
            : BOOKSHELF_WIDTH + 0.02,
        );
        shelfGeo.translate(bx, shelfY, bz);
        applyGeometryAttributes(shelfGeo, palette.table, "generic", {
          uvScale: UV_SCALE_PRESETS.woodPlank,
        });
        geometries.push(shelfGeo);
      }

      stats.props += 1;
      placed++;

      // Mark cell as partially occupied (bookshelf doesn't fill the whole cell)
      roomOccupied.add(`${wp.col},${wp.row},${wp.side}`);
    }
  }

  // ============================================================
  // BARREL / CRATE PLACEMENT
  // ============================================================

  /**
   * Place barrels and crates in corners or near walls.
   */
  private placeBarrelsInRoom(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    floorPlan: FloorPlan,
    _room: Room,
    availableCells: Cell[],
    floorY: number,
    count: number,
    roomOccupied: Set<string>,
    rng: RNG,
    stats: BuildingStats,
  ): void {
    // Filter out cells with external doors or adjacent to stairs
    const validCells = availableCells.filter((c) => {
      if (roomOccupied.has(`${c.col},${c.row}`)) return false;
      if (this.cellHasExternalDoor(floorPlan, c.col, c.row)) return false;
      if (this.isCellAdjacentToStairs(layout, c.col, c.row)) return false;
      return true;
    });

    // Prefer corner cells (cells with 2+ external edges)
    const cornerCells = validCells
      .map((c) => ({
        cell: c,
        externalEdges: this.countExternalEdges(
          floorPlan.footprint,
          c.col,
          c.row,
        ),
      }))
      .sort((a, b) => b.externalEdges - a.externalEdges);

    let placed = 0;
    for (const { cell } of cornerCells) {
      if (placed >= count) break;
      if (roomOccupied.has(`${cell.col},${cell.row}`)) continue;

      const { x, z } = getCellCenter(
        cell.col,
        cell.row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );

      // Place barrel cluster offset toward corner, clamped to stay well within cell
      // Max offset ensures barrel + crate stays within safe interior zone
      const maxOffset = CELL_SIZE / 4 - BARREL_DIAMETER / 2; // ~0.725m
      const ox = (rng.next() - 0.5) * maxOffset;
      const oz = (rng.next() - 0.5) * maxOffset;

      // Main barrel
      const barrelGeo = new THREE.BoxGeometry(
        BARREL_DIAMETER,
        BARREL_HEIGHT,
        BARREL_DIAMETER,
      );
      barrelGeo.translate(x + ox, floorY + BARREL_HEIGHT / 2, z + oz);
      applyGeometryAttributes(barrelGeo, palette.barrel, "generic", {
        uvScale: UV_SCALE_PRESETS.woodPlank,
      });
      geometries.push(barrelGeo);
      stats.props += 1;

      // 50% chance of a crate next to the barrel
      // Place crate in the perpendicular direction to avoid extending past barrel
      // toward walls. Crate stays close to barrel, not extending further out.
      if (rng.next() > 0.5) {
        const crateOffset = BARREL_DIAMETER / 2 + CRATE_SIZE / 2 + 0.05;
        const crateDir = rng.next() > 0.5 ? 1 : -1;
        // Place crate perpendicular to the barrel's offset direction
        // If barrel is offset primarily in X, place crate offset in Z and vice versa
        const crateAlongX = Math.abs(oz) > Math.abs(ox);
        const crateX = crateAlongX ? x + ox + crateDir * crateOffset : x + ox;
        const crateZ = crateAlongX ? z + oz : z + oz + crateDir * crateOffset;
        // Clamp to ensure crate stays within safe zone (1.2m from center max)
        const safeRadius =
          CELL_SIZE / 2 - WALL_THICKNESS - CRATE_SIZE / 2 - 0.1;
        const clampedCrateX = Math.max(
          x - safeRadius,
          Math.min(x + safeRadius, crateX),
        );
        const clampedCrateZ = Math.max(
          z - safeRadius,
          Math.min(z + safeRadius, crateZ),
        );

        const crateGeo = new THREE.BoxGeometry(
          CRATE_SIZE,
          CRATE_SIZE,
          CRATE_SIZE,
        );
        crateGeo.translate(
          clampedCrateX,
          floorY + CRATE_SIZE / 2,
          clampedCrateZ,
        );
        applyGeometryAttributes(crateGeo, palette.crate, "generic", {
          uvScale: UV_SCALE_PRESETS.woodPlank,
        });
        geometries.push(crateGeo);
        stats.props += 1;
      }

      // 30% chance of stacked barrel on top
      if (rng.next() > 0.7) {
        const stackGeo = new THREE.BoxGeometry(
          BARREL_DIAMETER * 0.9,
          BARREL_HEIGHT * 0.85,
          BARREL_DIAMETER * 0.9,
        );
        stackGeo.translate(
          x + ox + (rng.next() - 0.5) * 0.1,
          floorY + BARREL_HEIGHT + (BARREL_HEIGHT * 0.85) / 2,
          z + oz + (rng.next() - 0.5) * 0.1,
        );
        applyGeometryAttributes(stackGeo, palette.barrel, "generic", {
          uvScale: UV_SCALE_PRESETS.woodPlank,
        });
        geometries.push(stackGeo);
        stats.props += 1;
      }

      roomOccupied.add(`${cell.col},${cell.row}`);
      placed++;
    }
  }

  // ============================================================
  // WALL SCONCE PLACEMENT (Visible Fixtures)
  // ============================================================

  /**
   * Place visible wall sconce fixtures on room walls.
   * These complement the baked vertex lighting with actual geometry.
   */
  private placeSconcesInRoom(
    geometries: THREE.BufferGeometry[],
    layout: BuildingLayout,
    floorPlan: FloorPlan,
    room: Room,
    floorY: number,
    count: number,
    rng: RNG,
    stats: BuildingStats,
  ): void {
    // Find all wall positions in this room
    const allWalls: Array<{
      col: number;
      row: number;
      side: string;
      isExternal: boolean;
    }> = [];

    for (const cell of room.cells) {
      for (const side of ["north", "south", "east", "west"] as const) {
        const key = `${cell.col},${cell.row},${side}`;

        // Check for external wall
        const { dc, dr } = this.getSideOffset(side);
        const neighborCol = cell.col + dc;
        const neighborRow = cell.row + dr;

        if (
          !this.isCellOccupied(floorPlan.footprint, neighborCol, neighborRow)
        ) {
          // External wall - skip if it has an opening
          if (!floorPlan.externalOpenings.has(key)) {
            allWalls.push({
              col: cell.col,
              row: cell.row,
              side,
              isExternal: true,
            });
          }
        } else {
          // Check if neighbor is in a different room (internal wall)
          const neighborRoom = floorPlan.roomMap[neighborRow]?.[neighborCol];
          const cellRoom = floorPlan.roomMap[cell.row]?.[cell.col];
          if (
            neighborRoom !== undefined &&
            cellRoom !== undefined &&
            neighborRoom !== cellRoom
          ) {
            // Internal wall between rooms - check for openings
            // Internal openings use sorted cell ID edge keys
            const cellId1 = cell.row * layout.width + cell.col;
            const cellId2 = neighborRow * layout.width + neighborCol;
            const edgeKey =
              cellId1 < cellId2
                ? `${cellId1}:${cellId2}`
                : `${cellId2}:${cellId1}`;
            if (!floorPlan.internalOpenings.has(edgeKey)) {
              allWalls.push({
                col: cell.col,
                row: cell.row,
                side,
                isExternal: false,
              });
            }
          }
        }
      }
    }

    // Shuffle and space them out (minimum 1 cell apart)
    for (let i = allWalls.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [allWalls[i], allWalls[j]] = [allWalls[j], allWalls[i]];
    }

    const placedPositions: Array<{ x: number; z: number }> = [];
    let placed = 0;

    for (const wall of allWalls) {
      if (placed >= count) break;

      const { x, z } = getCellCenter(
        wall.col,
        wall.row,
        CELL_SIZE,
        layout.width,
        layout.depth,
      );

      // Check minimum spacing from other sconces (at least 2m)
      const tooClose = placedPositions.some(
        (p) => Math.abs(p.x - x) + Math.abs(p.z - z) < 2.0,
      );
      if (tooClose) continue;

      const vec = getSideVector(wall.side);
      const wallDist = CELL_SIZE / 2 - WALL_THICKNESS / 2 - 0.02;
      const sx = x + vec.x * wallDist;
      const sz = z + vec.z * wallDist;
      const mountY = floorY + SCONCE_MOUNT_HEIGHT;

      // Bracket (mounted on wall)
      const isNS = wall.side === "north" || wall.side === "south";
      const bracketGeo = new THREE.BoxGeometry(
        isNS ? SCONCE_BRACKET_WIDTH : SCONCE_BRACKET_DEPTH,
        SCONCE_BRACKET_HEIGHT,
        isNS ? SCONCE_BRACKET_DEPTH : SCONCE_BRACKET_WIDTH,
      );
      bracketGeo.translate(sx, mountY, sz);
      applyGeometryAttributes(bracketGeo, palette.sconceBracket, "generic", {
        uvScale: 0.5,
      });
      geometries.push(bracketGeo);

      // Candle (on top of bracket)
      const candleGeo = new THREE.BoxGeometry(
        SCONCE_CANDLE_SIZE,
        SCONCE_CANDLE_HEIGHT,
        SCONCE_CANDLE_SIZE,
      );
      candleGeo.translate(
        sx,
        mountY + SCONCE_BRACKET_HEIGHT / 2 + SCONCE_CANDLE_HEIGHT / 2,
        sz,
      );
      applyGeometryAttributes(candleGeo, palette.sconceCandle, "generic", {
        uvScale: 0.5,
      });
      geometries.push(candleGeo);

      stats.props += 1;
      placedPositions.push({ x, z });
      placed++;
    }
  }

  // ============================================================
  // FURNITURE PLACEMENT HELPERS
  // ============================================================

  /**
   * Check if a cell has an external door/arch opening on any side.
   * Used to prevent placing floor furniture (tables, barrels) in cells
   * where a doorway entrance would be blocked.
   */
  private cellHasExternalDoor(
    floorPlan: FloorPlan,
    col: number,
    row: number,
  ): boolean {
    for (const side of ["north", "south", "east", "west"]) {
      const key = `${col},${row},${side}`;
      const opening = floorPlan.externalOpenings.get(key);
      if (opening === "door" || opening === "arch") {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a cell is adjacent to a stair cell or landing cell.
   * Used to create a buffer zone around stairs where furniture isn't placed.
   */
  private isCellAdjacentToStairs(
    layout: BuildingLayout,
    col: number,
    row: number,
  ): boolean {
    if (!layout.stairs) return false;
    const stairDist =
      Math.abs(col - layout.stairs.col) + Math.abs(row - layout.stairs.row);
    const landingDist =
      Math.abs(col - layout.stairs.landing.col) +
      Math.abs(row - layout.stairs.landing.row);
    return stairDist <= 1 || landingDist <= 1;
  }

  /**
   * Find wall positions within a room suitable for placing wall-adjacent furniture.
   * Returns positions on external walls without openings (doors/windows/arches).
   */
  private findFurnitureWallPositions(
    floorPlan: FloorPlan,
    _room: Room,
    availableCells: Cell[],
    roomOccupied: Set<string>,
    layout?: BuildingLayout,
  ): Array<{ col: number; row: number; side: string }> {
    const positions: Array<{ col: number; row: number; side: string }> = [];

    for (const cell of availableCells) {
      if (roomOccupied.has(`${cell.col},${cell.row}`)) continue;
      // Skip cells adjacent to stairs (bookshelf would crowd the stairway)
      if (layout && this.isCellAdjacentToStairs(layout, cell.col, cell.row))
        continue;

      for (const side of ["north", "south", "east", "west"] as const) {
        const key = `${cell.col},${cell.row},${side}`;
        // Check this is an external wall without opening
        const { dc, dr } = this.getSideOffset(side);
        const neighborCol = cell.col + dc;
        const neighborRow = cell.row + dr;
        if (
          !this.isCellOccupied(floorPlan.footprint, neighborCol, neighborRow)
        ) {
          // External wall
          if (!floorPlan.externalOpenings.has(key)) {
            // Also skip walls already used by bookshelf on same side
            if (!roomOccupied.has(`${cell.col},${cell.row},${side}`)) {
              positions.push({ col: cell.col, row: cell.row, side });
            }
          }
        }
      }
    }

    return positions;
  }
}

// Default instance for quick use
export const defaultGenerator = new BuildingGenerator();
