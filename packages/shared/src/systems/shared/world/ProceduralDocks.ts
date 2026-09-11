/**
 * ProceduralDocks.ts - Dock Generation & Collision System
 *
 * Generates procedural docks on water bodies.
 * Follows the BridgeSystem pattern for collision registration:
 * - Walkable tiles: remove WATER flag, add DOCK flag
 * - Edge blocking: classic MMORPG dual-tile wall flags on dock perimeter
 * - Deck height tracking: per-tile Y override for player positioning
 *
 * Works on both client (mesh + collision) and server (collision only).
 *
 * @module ProceduralDocks
 */

import type { Node } from "three/webgpu";
import * as THREE from "three";
import { System } from "../infrastructure/System";
import type { World } from "../../../types";
import { TERRAIN_CONSTANTS } from "../../../constants/GameConstants";
import type {
  ShorelinePoint,
  WaterBody,
  ItemCollisionData,
} from "@hyperforge/procgen/items";
import {
  DockGenerator,
  DEFAULT_DOCK_PARAMS,
  type GeneratedDock,
  type DockRecipe,
} from "@hyperforge/procgen/items/dock";
import { ISLAND_DOCKS, type DockDefinition } from "./DockDefinition";
import { CollisionFlag, getOppositeWallFlag } from "../movement/CollisionFlags";

// TSL imports for dock material (client-only, same pattern as BridgeSystem)
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  Fn,
  vec2,
  vec3,
  vec4,
  float,
  positionWorld,
  normalWorld,
  sin,
  abs,
  fract,
  floor as tslFloor,
  dot,
  mix,
  smoothstep,
  min as tslMin,
} from "three/tsl";

// Constants — single source of truth from GameConstants
const WATER_THRESHOLD = TERRAIN_CONSTANTS.WATER_THRESHOLD;
const WATER_LEVEL = TERRAIN_CONSTANTS.WATER_THRESHOLD;

// ── Dock geometry constants (matching BridgeSystem visual quality) ──
const DOCK_POST_CAP_OVERHANG = 0.05;
const DOCK_POST_CAP_HEIGHT = 0.06;
const DOCK_STRINGER_WIDTH = 0.16;
const DOCK_STRINGER_HEIGHT = 0.2;
const DOCK_JOIST_SPACING = 0.8;
const DOCK_JOIST_WIDTH = 0.1;
const DOCK_JOIST_HEIGHT = 0.14;
const DOCK_FENCE_POST_SIZE = 0.16;
const DOCK_FENCE_HEIGHT = 1.2;
const DOCK_FENCE_CAP_OVERHANG = 0.05;
const DOCK_FENCE_CAP_HEIGHT = 0.05;
const DOCK_FENCE_RAIL_HEIGHTS = [0.25, 0.6, 1.0];
const DOCK_FENCE_RAIL_SIZE = 0.06;
const DOCK_FENCE_POST_SPACING = 1.5;

// ============================================================================
// TSL Procedural Wood Functions (matching BridgeSystem quality)
// ============================================================================

const tslHash = Fn(([p]: [Node<"vec2">]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123));
});

const tslNoise2D = Fn(([p]: [Node<"vec2">]) => {
  const i = tslFloor(p);
  const f = fract(p);
  const smoothF = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = tslHash(i);
  const b = tslHash(i.add(vec2(1.0, 0.0)));
  const c = tslHash(i.add(vec2(0.0, 1.0)));
  const d = tslHash(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, smoothF.x), mix(c, d, smoothF.x), smoothF.y);
});

/**
 * Wood plank pattern — horizontal planks with thin gaps.
 * Returns vec4(isPlank, plankIndex, 0, bevel).
 */
const dockPlankPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const plankWidth = float(0.4);
  const gapWidth = float(0.01);

  const plankIndex = tslFloor(uvIn.y.div(plankWidth));
  const localV = fract(uvIn.y.div(plankWidth));

  const gapFrac = gapWidth.div(plankWidth);
  const isPlank = smoothstep(gapFrac, gapFrac.add(float(0.01)), localV).mul(
    smoothstep(gapFrac, gapFrac.add(float(0.01)), float(1.0).sub(localV)),
  );

  const bevel = smoothstep(
    float(0.0),
    float(0.1),
    tslMin(localV, float(1.0).sub(localV)),
  );

  return vec4(isPlank, plankIndex, float(0.0), bevel);
});

/**
 * Orientation-aware UV for wood — uses XZ on horizontal surfaces (deck)
 * and XZ+Y on vertical surfaces (posts, rails).
 */
const dockWoodUV = Fn(() => {
  const wp = positionWorld;
  const nw = normalWorld;
  const horiz = abs(nw.y);
  const deckUV = vec2(wp.x, wp.z);
  const vertUV = vec2(wp.x.add(wp.z), wp.y);
  return mix(vertUV, deckUV, horiz);
});

/** Pre-allocated test points for isTerrainReady(). */
const TERRAIN_READY_TEST_POINTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: 0, z: 0 },
  { x: 50, z: 50 },
  { x: -50, z: -50 },
];

function dockTileKey(tx: number, tz: number): number {
  return ((tx + 32768) << 16) | (tz + 32768);
}

interface DockInstance {
  id: string;
  waterBodyId: string;
  dock: GeneratedDock;
  mesh: THREE.Object3D | null;
}

interface TerrainSystemInterface {
  getHeightAt(x: number, z: number): number;
}

interface StageSystemInterface {
  scene: THREE.Scene;
}

/** Manages procedural dock generation and collision for water bodies */
export class ProceduralDocks extends System {
  private docks: Map<string, DockInstance> = new Map();
  private generator: DockGenerator;
  private terrainSystem: TerrainSystemInterface | null = null;
  private scene: THREE.Scene | null = null;
  private docksGenerated = false;

  /** Per-tile deck height for Y override (matches BridgeSystem pattern). */
  private dockDeckHeights: Map<number, number> = new Map();

  /** Shared TSL wood material for all docks (created lazily on client). */
  private dockMaterial: MeshStandardNodeMaterial | null = null;

  /** World-space meshes added to scene (for cleanup). */
  private dockMeshes: THREE.Mesh[] = [];

  /** Pending dock generation queue — processed one per tick to avoid spikes. */
  private pendingDockQueue: DockDefinition[] = [];

  constructor(world: World) {
    super(world);
    this.generator = new DockGenerator();
  }

  getDependencies() {
    return { required: ["terrain"], optional: ["stage"] };
  }

  async init(): Promise<void> {
    const terrain = this.world.getSystem("terrain");
    if (terrain && "getHeightAt" in terrain) {
      this.terrainSystem = terrain as unknown as TerrainSystemInterface;
    }

    const stage = this.world.getSystem("stage");
    if (stage && "scene" in stage) {
      this.scene = (stage as unknown as StageSystemInterface).scene;
    }
  }

  /**
   * Check if terrain system is ready and has valid height data.
   * Tests general island points rather than a specific pond.
   */
  private isTerrainReady(): boolean {
    if (!this.terrainSystem) return false;

    for (const point of TERRAIN_READY_TEST_POINTS) {
      const height = this.terrainSystem.getHeightAt(point.x, point.z);
      if (height === 0 || isNaN(height)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get the collision system from the world.
   */
  private getCollision(): {
    addFlags(x: number, z: number, f: number): void;
    removeFlags(x: number, z: number, f: number): void;
  } | null {
    const collision = (
      this.world as {
        collision?: {
          addFlags(x: number, z: number, f: number): void;
          removeFlags(x: number, z: number, f: number): void;
        };
      }
    ).collision;
    return collision ?? null;
  }

  /**
   * Enqueue docks from ISLAND_DOCKS definitions.
   * Builds a queue that update() drains one dock per tick to avoid spikes.
   */
  private enqueueDocks(): void {
    for (const def of ISLAND_DOCKS) {
      this.pendingDockQueue.push(def);
    }
  }

  /**
   * Generate a dock from a developer-assigned DockDefinition.
   * Works on both client (mesh + collision) and server (collision only).
   */
  generateDockFromDefinition(def: DockDefinition): GeneratedDock | null {
    if (!this.terrainSystem) return null;

    const waterLevel = WATER_LEVEL;

    // Convert compass bearing (degrees) to direction vector
    // 0° = north (−Z), 90° = east (+X), 180° = south (+Z), 270° = west (−X)
    const rad = (def.rotation * Math.PI) / 180;
    const waterwardDir = { x: Math.sin(rad), z: Math.cos(rad) };
    const landwardDir = { x: -waterwardDir.x, z: -waterwardDir.z };

    const snappedX = def.x;
    const snappedZ = def.z;

    const anchorY = this.terrainSystem.getHeightAt(def.x, def.z);

    const adjustedPoint: ShorelinePoint = {
      position: { x: snappedX, y: anchorY, z: snappedZ },
      waterwardNormal: waterwardDir,
      landwardNormal: landwardDir,
      height: anchorY,
      slope: 0,
      distanceFromCenter: 0,
    };

    const dockWidth = def.width ?? 3.0;
    const dockLength = def.length ?? 12;

    const recipe: DockRecipe = {
      ...DEFAULT_DOCK_PARAMS,
      label: def.label ?? "Dock",
      widthRange: [dockWidth, dockWidth],
      lengthRange: [dockLength, dockLength],
    };

    const waterFloorDepth = 3.0;
    const waterFloorY = waterLevel - waterFloorDepth;

    const isServer = !this.scene;
    const dock = this.generator.generate(recipe, adjustedPoint, {
      seed: def.id,
      waterLevel,
      waterFloorDepth,
      skipMesh: isServer,
    });

    dock.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
    });

    let worldMesh: THREE.Mesh | null = null;
    if (this.scene) {
      worldMesh = this.buildDockMeshWorldSpace(
        dock,
        recipe,
        waterLevel,
        waterFloorY,
      );
      if (worldMesh) {
        this.scene.add(worldMesh);
        this.dockMeshes.push(worldMesh);
      }
    }

    this.registerDockCollision(dock);

    const instance: DockInstance = {
      id: `dock-${def.id}`,
      waterBodyId: def.id,
      dock,
      mesh: worldMesh,
    };
    this.docks.set(instance.id, instance);

    return dock;
  }

  /**
   * Register collision flags for a dock following the BridgeSystem pattern:
   * 1. Remove WATER, add DOCK on walkable tiles + store deck height
   * 2. Cardinal wall flags from blockedEdges (dual-tile pattern)
   * 3. Diagonal wall flags for non-dock diagonal neighbors
   */
  private registerDockCollision(dock: GeneratedDock): void {
    const collision = this.getCollision();
    if (!collision) return;

    const deckY = dock.position.y;
    const tileSet = new Set<number>();

    // Pass 1: Register walkable tiles — remove water, add dock, store deck Y
    for (const tile of dock.collision.walkableTiles) {
      collision.removeFlags(
        tile.x,
        tile.z,
        CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE,
      );
      collision.addFlags(tile.x, tile.z, CollisionFlag.DOCK);
      const key = dockTileKey(tile.x, tile.z);
      this.dockDeckHeights.set(key, deckY);
      tileSet.add(key);
    }

    // Pass 2: Cardinal wall flags from blockedEdges (classic MMORPG dual-tile pattern)
    for (const edge of dock.collision.blockedEdges) {
      let wallFlag: number;
      let ndx: number;
      let ndz: number;
      switch (edge.direction) {
        case "north":
          wallFlag = CollisionFlag.WALL_NORTH;
          ndx = 0;
          ndz = -1;
          break;
        case "south":
          wallFlag = CollisionFlag.WALL_SOUTH;
          ndx = 0;
          ndz = 1;
          break;
        case "east":
          wallFlag = CollisionFlag.WALL_EAST;
          ndx = 1;
          ndz = 0;
          break;
        case "west":
          wallFlag = CollisionFlag.WALL_WEST;
          ndx = -1;
          ndz = 0;
          break;
      }
      // Wall on dock tile
      collision.addFlags(edge.tileX, edge.tileZ, wallFlag);
      // Opposite wall on neighbor (dual-tile ensures both directions catch it)
      collision.addFlags(
        edge.tileX + ndx,
        edge.tileZ + ndz,
        getOppositeWallFlag(wallFlag),
      );
    }

    // Pass 3: Diagonal walls — seal all non-dock diagonal neighbors
    const diags: ReadonlyArray<{ dx: number; dz: number; flag: number }> = [
      { dx: 1, dz: -1, flag: CollisionFlag.WALL_NORTH_EAST },
      { dx: -1, dz: -1, flag: CollisionFlag.WALL_NORTH_WEST },
      { dx: 1, dz: 1, flag: CollisionFlag.WALL_SOUTH_EAST },
      { dx: -1, dz: 1, flag: CollisionFlag.WALL_SOUTH_WEST },
    ];
    for (const tile of dock.collision.walkableTiles) {
      for (const d of diags) {
        const nkey = dockTileKey(tile.x + d.dx, tile.z + d.dz);
        if (!tileSet.has(nkey)) {
          collision.addFlags(tile.x, tile.z, d.flag);
          collision.addFlags(
            tile.x + d.dx,
            tile.z + d.dz,
            getOppositeWallFlag(d.flag),
          );
        }
      }
    }
  }

  /**
   * Re-apply dock collision flags for tiles within a terrain tile region.
   * Called by TerrainSystem after bakeWalkabilityFlags() to prevent
   * terrain baking from overwriting DOCK flags with WATER.
   * Same pattern as BridgeSystem.registerBridgeCollision().
   */
  reapplyCollisionForTile(
    originX: number,
    originZ: number,
    tileSize: number,
  ): void {
    const collision = this.getCollision();
    if (!collision) return;

    for (const instance of this.docks.values()) {
      const dock = instance.dock;
      const deckY = dock.position.y;

      for (const tile of dock.collision.walkableTiles) {
        // Only process tiles within this terrain tile region
        if (
          tile.x < originX ||
          tile.x >= originX + tileSize ||
          tile.z < originZ ||
          tile.z >= originZ + tileSize
        ) {
          continue;
        }

        collision.removeFlags(
          tile.x,
          tile.z,
          CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE,
        );
        collision.addFlags(tile.x, tile.z, CollisionFlag.DOCK);

        const key = dockTileKey(tile.x, tile.z);
        this.dockDeckHeights.set(key, deckY);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // World-Space Mesh Building (BridgeSystem pattern)
  // ---------------------------------------------------------------------------

  /**
   * Build a complete dock mesh in world space — deck + posts + stringers +
   * joists + optional fence. All geometry is merged into a single draw call
   * with a shared TSL procedural wood material.
   */
  private buildDockMeshWorldSpace(
    dock: GeneratedDock,
    recipe: DockRecipe,
    waterLevel: number,
    waterFloorY: number,
  ): THREE.Mesh | null {
    const { position, direction, length, width } = dock.layout;
    const perpX = -direction.z;
    const perpZ = direction.x;
    const halfWidth = width / 2;
    const deckY = position.y; // layout.position.y = waterLevel + deckHeight

    const woodGeometries: THREE.BufferGeometry[] = [];

    // Helper to build a dock section (main body, T-section, or L-section)
    const buildSection = (
      sx: number,
      sz: number,
      dx: number,
      dz: number,
      px: number,
      pz: number,
      sectionLen: number,
      sectionWidth: number,
      postSpacing: number,
      postRadius: number,
    ) => {
      const hw = sectionWidth / 2;

      // ── Deck surface (top face only, custom grid mesh) ──
      const deckGeo = this.buildDockDeckGeometry(
        sx,
        sz,
        deckY,
        dx,
        dz,
        px,
        pz,
        sectionLen,
        sectionWidth,
      );
      if (deckGeo) woodGeometries.push(deckGeo);

      // ── Side stringers (structural beams under deck edges) ──
      const stringerY = deckY - DOCK_STRINGER_HEIGHT / 2 - 0.03;
      for (const side of [-1, 1]) {
        woodGeometries.push(
          this.buildOrientedRail(
            sx + px * hw * side,
            sz + pz * hw * side,
            stringerY,
            sx + dx * sectionLen + px * hw * side,
            sz + dz * sectionLen + pz * hw * side,
            stringerY,
            DOCK_STRINGER_WIDTH,
            DOCK_STRINGER_HEIGHT,
            px,
            pz,
          ),
        );
      }

      // ── Cross joists (transverse beams between stringers) ──
      const joistCount = Math.max(
        2,
        Math.floor(sectionLen / DOCK_JOIST_SPACING) + 1,
      );
      const inset = DOCK_STRINGER_WIDTH / 2;
      for (let j = 0; j < joistCount; j++) {
        const t = j / (joistCount - 1);
        const cx = sx + dx * sectionLen * t;
        const cz = sz + dz * sectionLen * t;
        const joistY = deckY - DOCK_JOIST_HEIGHT / 2 - 0.03;
        woodGeometries.push(
          this.buildOrientedRail(
            cx + px * (hw - inset),
            cz + pz * (hw - inset),
            joistY,
            cx - px * (hw - inset),
            cz - pz * (hw - inset),
            joistY,
            DOCK_JOIST_WIDTH,
            DOCK_JOIST_HEIGHT,
            dx,
            dz,
          ),
        );
      }

      // ── Support posts (square, from water floor to deck underside) ──
      const postCount = Math.max(2, Math.ceil(sectionLen / postSpacing) + 1);
      const postSize = postRadius * 2;
      const postInset = hw - postRadius * 2;
      for (let p = 0; p < postCount; p++) {
        const t = p / (postCount - 1);
        const cx = sx + dx * sectionLen * t;
        const cz = sz + dz * sectionLen * t;

        for (const side of [-1, 1]) {
          const postX = cx + px * postInset * side;
          const postZ = cz + pz * postInset * side;
          const postHeight = deckY - waterFloorY;
          if (postHeight < 0.2) continue;

          // Post shaft
          const postGeo = new THREE.BoxGeometry(postSize, postHeight, postSize);
          postGeo.translate(postX, waterFloorY + postHeight / 2, postZ);
          woodGeometries.push(postGeo);

          // Post cap (wider, just under deck)
          const capSize = postSize + DOCK_POST_CAP_OVERHANG * 2;
          const capGeo = new THREE.BoxGeometry(
            capSize,
            DOCK_POST_CAP_HEIGHT,
            capSize,
          );
          capGeo.translate(postX, deckY - DOCK_POST_CAP_HEIGHT / 2, postZ);
          woodGeometries.push(capGeo);
        }
      }
    };

    // ── Build main dock section ──
    buildSection(
      position.x,
      position.z,
      direction.x,
      direction.z,
      perpX,
      perpZ,
      length,
      width,
      recipe.postSpacing,
      recipe.postRadius,
    );

    // ── Fence posts + rails (if hasRailing) ──
    if (recipe.hasRailing) {
      const hasTSection = dock.layout.tSection != null;
      const hasLSection = dock.layout.lSection != null;

      this.buildFenceForSection(
        woodGeometries,
        position.x,
        position.z,
        direction.x,
        direction.z,
        perpX,
        perpZ,
        length,
        width,
        deckY,
        true, // include start railing (shore end is open for entry)
        !(hasTSection || hasLSection), // skip end railing if T/L junction
      );
    }

    // ── T-section (perpendicular bar at dock end) ──
    if (dock.layout.tSection) {
      const tWidth = dock.layout.tSection.width;
      const halfTWidth = tWidth / 2;
      const endX = position.x + direction.x * length;
      const endZ = position.z + direction.z * length;

      // T-section: runs perpendicular, centered at dock end
      const tStartX = endX - perpX * halfTWidth;
      const tStartZ = endZ - perpZ * halfTWidth;

      buildSection(
        tStartX,
        tStartZ,
        perpX,
        perpZ,
        -direction.x,
        -direction.z,
        tWidth,
        width,
        recipe.postSpacing,
        recipe.postRadius,
      );

      // T-section fence (3 outer edges)
      if (recipe.hasRailing) {
        this.buildFenceForSection(
          woodGeometries,
          tStartX,
          tStartZ,
          perpX,
          perpZ,
          -direction.x,
          -direction.z,
          tWidth,
          width,
          deckY,
          true, // both ends
          true,
        );
        // Front edge (outer, along main dock direction)
        this.buildFenceSide(
          woodGeometries,
          endX + direction.x * (width / 2) - perpX * halfTWidth,
          endZ + direction.z * (width / 2) - perpZ * halfTWidth,
          endX + direction.x * (width / 2) + perpX * halfTWidth,
          endZ + direction.z * (width / 2) + perpZ * halfTWidth,
          deckY,
        );
      }
    }

    // ── L-section (90-degree turn at dock end) ──
    if (dock.layout.lSection) {
      const lLen = dock.layout.lSection.length;
      const lDir = dock.layout.lSection.direction;
      const lPerpX = -lDir.z;
      const lPerpZ = lDir.x;
      const lStartX = position.x + direction.x * length;
      const lStartZ = position.z + direction.z * length;

      buildSection(
        lStartX,
        lStartZ,
        lDir.x,
        lDir.z,
        lPerpX,
        lPerpZ,
        lLen,
        width,
        recipe.postSpacing,
        recipe.postRadius,
      );

      if (recipe.hasRailing) {
        this.buildFenceForSection(
          woodGeometries,
          lStartX,
          lStartZ,
          lDir.x,
          lDir.z,
          lPerpX,
          lPerpZ,
          lLen,
          width,
          deckY,
          false, // skip start (junction with main dock)
          true, // include end
        );
      }
    }

    // ── Merge all wood geometry into single mesh ──
    if (woodGeometries.length === 0) return null;

    const merged = this.mergeGeometries(woodGeometries);
    for (const g of woodGeometries) g.dispose();
    if (!merged) return null;

    const material = this.getOrCreateDockMaterial();
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = "Dock";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.userData = { type: "terrain", walkable: true, clickable: true };

    return mesh;
  }

  /**
   * Build fence posts + horizontal rails for one side of a dock section.
   */
  private buildFenceSide(
    woodGeometries: THREE.BufferGeometry[],
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
    deckY: number,
  ): void {
    const dx = endX - startX;
    const dz = endZ - startZ;
    const sideLen = Math.sqrt(dx * dx + dz * dz);
    if (sideLen < 0.5) return;

    const sdx = dx / sideLen;
    const sdz = dz / sideLen;
    const spx = -sdz;
    const spz = sdx;

    const postCount = Math.max(
      2,
      Math.floor(sideLen / DOCK_FENCE_POST_SPACING) + 1,
    );

    // Fence posts + caps
    for (let p = 0; p < postCount; p++) {
      const t = p / (postCount - 1);
      const px = startX + dx * t;
      const pz = startZ + dz * t;

      const postGeo = new THREE.BoxGeometry(
        DOCK_FENCE_POST_SIZE,
        DOCK_FENCE_HEIGHT,
        DOCK_FENCE_POST_SIZE,
      );
      postGeo.translate(px, deckY + DOCK_FENCE_HEIGHT / 2, pz);
      woodGeometries.push(postGeo);

      const capSize = DOCK_FENCE_POST_SIZE + DOCK_FENCE_CAP_OVERHANG * 2;
      const capGeo = new THREE.BoxGeometry(
        capSize,
        DOCK_FENCE_CAP_HEIGHT,
        capSize,
      );
      capGeo.translate(
        px,
        deckY + DOCK_FENCE_HEIGHT + DOCK_FENCE_CAP_HEIGHT / 2,
        pz,
      );
      woodGeometries.push(capGeo);
    }

    // Horizontal rails connecting posts
    for (let p = 0; p < postCount - 1; p++) {
      const t0 = p / (postCount - 1);
      const t1 = (p + 1) / (postCount - 1);
      const px0 = startX + dx * t0;
      const pz0 = startZ + dz * t0;
      const px1 = startX + dx * t1;
      const pz1 = startZ + dz * t1;

      for (const railH of DOCK_FENCE_RAIL_HEIGHTS) {
        woodGeometries.push(
          this.buildOrientedRail(
            px0,
            pz0,
            deckY + railH,
            px1,
            pz1,
            deckY + railH,
            DOCK_FENCE_RAIL_SIZE,
            DOCK_FENCE_RAIL_SIZE,
            spx,
            spz,
          ),
        );
      }
    }
  }

  /**
   * Build fence on both sides of a dock section, optionally including
   * start and end railings.
   */
  private buildFenceForSection(
    woodGeometries: THREE.BufferGeometry[],
    sx: number,
    sz: number,
    dx: number,
    dz: number,
    px: number,
    pz: number,
    sectionLen: number,
    sectionWidth: number,
    deckY: number,
    includeStartRailing: boolean,
    includeEndRailing: boolean,
  ): void {
    const hw = sectionWidth / 2;

    // Left side
    this.buildFenceSide(
      woodGeometries,
      sx + px * hw,
      sz + pz * hw,
      sx + dx * sectionLen + px * hw,
      sz + dz * sectionLen + pz * hw,
      deckY,
    );

    // Right side
    this.buildFenceSide(
      woodGeometries,
      sx - px * hw,
      sz - pz * hw,
      sx + dx * sectionLen - px * hw,
      sz + dz * sectionLen - pz * hw,
      deckY,
    );

    // End railing (at water end)
    if (includeEndRailing) {
      this.buildFenceSide(
        woodGeometries,
        sx + dx * sectionLen + px * hw,
        sz + dz * sectionLen + pz * hw,
        sx + dx * sectionLen - px * hw,
        sz + dz * sectionLen - pz * hw,
        deckY,
      );
    }

    // Start railing (shore end — usually open for entry, but some presets may want it)
    if (includeStartRailing) {
      // Shore end is typically open, skip for standard docks
    }
  }

  /**
   * Build deck geometry with a custom grid mesh — top face only.
   * Same approach as BridgeSystem.buildDeckGeometry but flat (no arch).
   */
  private buildDockDeckGeometry(
    startX: number,
    startZ: number,
    deckY: number,
    dirX: number,
    dirZ: number,
    perpX: number,
    perpZ: number,
    length: number,
    width: number,
  ): THREE.BufferGeometry | null {
    const lengthSteps = Math.max(4, Math.ceil(length / 0.5));
    const widthSteps = Math.max(2, Math.ceil(width));
    const stride = widthSteps + 1;

    const vertices: number[] = [];
    const norms: number[] = [];
    const indices: number[] = [];

    // Top surface — flat deck, all normals point up
    const topStart = vertices.length / 3;
    for (let s = 0; s <= lengthSteps; s++) {
      const t = s / lengthSteps;
      const cx = startX + dirX * length * t;
      const cz = startZ + dirZ * length * t;
      for (let w = 0; w <= widthSteps; w++) {
        const wt = (w / widthSteps - 0.5) * width;
        vertices.push(cx + perpX * wt, deckY, cz + perpZ * wt);
        norms.push(0, 1, 0);
      }
    }
    for (let s = 0; s < lengthSteps; s++) {
      for (let w = 0; w < widthSteps; w++) {
        const a = topStart + s * stride + w;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(norms, 3));
    geometry.setIndex(indices);
    return geometry;
  }

  /**
   * Build an oriented rail box between two 3D endpoints.
   * Identical to BridgeSystem.buildOrientedRail.
   */
  private buildOrientedRail(
    x0: number,
    z0: number,
    y0: number,
    x1: number,
    z1: number,
    y1: number,
    width: number,
    height: number,
    perpX: number,
    perpZ: number,
  ): THREE.BufferGeometry {
    const hw = width / 2;
    const hh = height / 2;

    const verts = new Float32Array([
      x0 + perpX * hw,
      y0 - hh,
      z0 + perpZ * hw,
      x0 - perpX * hw,
      y0 - hh,
      z0 - perpZ * hw,
      x0 + perpX * hw,
      y0 + hh,
      z0 + perpZ * hw,
      x0 - perpX * hw,
      y0 + hh,
      z0 - perpZ * hw,
      x1 + perpX * hw,
      y1 - hh,
      z1 + perpZ * hw,
      x1 - perpX * hw,
      y1 - hh,
      z1 - perpZ * hw,
      x1 + perpX * hw,
      y1 + hh,
      z1 + perpZ * hw,
      x1 - perpX * hw,
      y1 + hh,
      z1 - perpZ * hw,
    ]);

    const indices = new Uint16Array([
      2,
      6,
      3,
      3,
      6,
      7, // top
      0,
      1,
      4,
      1,
      5,
      4, // bottom
      0,
      4,
      2,
      2,
      4,
      6, // left
      1,
      3,
      5,
      3,
      7,
      5, // right
      0,
      2,
      1,
      1,
      2,
      3, // near
      4,
      5,
      6,
      5,
      7,
      6, // far
    ]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Merge multiple geometries into one (handles indexed geometry).
   * Same approach as BridgeSystem.mergeGeometries.
   */
  private mergeGeometries(
    geometries: THREE.BufferGeometry[],
  ): THREE.BufferGeometry | null {
    const allVerts: number[] = [];
    const allNormals: number[] = [];
    const allIndices: number[] = [];
    let vertexOffset = 0;

    for (const geo of geometries) {
      const posAttr = geo.getAttribute("position");
      if (!posAttr) continue;

      const posArray = posAttr.array;
      for (let i = 0; i < posArray.length; i++) {
        allVerts.push(posArray[i]);
      }

      const normAttr = geo.getAttribute("normal");
      if (normAttr) {
        const normArray = normAttr.array;
        for (let i = 0; i < normArray.length; i++) {
          allNormals.push(normArray[i]);
        }
      } else {
        for (let i = 0; i < posAttr.count; i++) {
          allNormals.push(0, 1, 0);
        }
      }

      const index = geo.getIndex();
      if (index) {
        for (let i = 0; i < index.count; i++) {
          allIndices.push(index.getX(i) + vertexOffset);
        }
      } else {
        // Non-indexed: treat each vertex as sequential
        for (let i = 0; i < posAttr.count; i++) {
          allIndices.push(i + vertexOffset);
        }
      }
      vertexOffset += posAttr.count;
    }

    if (allVerts.length === 0) return null;

    const merged = new THREE.BufferGeometry();
    merged.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(allVerts, 3),
    );
    merged.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(allNormals, 3),
    );
    merged.setIndex(allIndices);
    return merged;
  }

  /**
   * Get or create the shared TSL wood material for docks.
   */
  private getOrCreateDockMaterial(): MeshStandardNodeMaterial {
    if (!this.dockMaterial) {
      this.dockMaterial = this.createDockWoodMaterial();
    }
    return this.dockMaterial;
  }

  /**
   * Procedural wood plank material with grain and per-plank variation.
   * Matches BridgeSystem visual quality — weathered dock wood with
   * slightly grayer tones.
   */
  private createDockWoodMaterial(): MeshStandardNodeMaterial {
    const mat = new MeshStandardNodeMaterial();

    mat.colorNode = Fn(() => {
      const uvCoord = dockWoodUV();
      const pattern = dockPlankPattern(uvCoord);
      const isPlank = pattern.x;
      const plankIndex = pattern.y;
      const bevel = pattern.w;

      // Per-plank color variation — weathered dock wood (grayer than bridge)
      const plankId = vec2(plankIndex, float(0.0));
      const h1 = tslHash(plankId);
      const h2 = tslHash(plankId.add(vec2(3.0, 7.0)));

      // Weathered gray-brown dock wood
      const baseR = float(0.38).add(h1.mul(0.08)).sub(0.04);
      const baseG = float(0.3).add(h1.mul(0.06)).sub(0.03);
      const baseB = float(0.2).add(h2.mul(0.04)).sub(0.02);
      const woodColor = vec3(baseR, baseG, baseB);

      // Subtle edge darkening
      const edgeDark = mix(float(0.92), float(1.0), bevel);

      // Dark gap between planks
      const gapColor = vec3(0.06, 0.04, 0.02);
      return vec4(mix(gapColor, woodColor.mul(edgeDark), isPlank), 1.0);
    })();

    mat.roughnessNode = Fn(() => {
      const uvCoord = dockWoodUV();
      const pattern = dockPlankPattern(uvCoord);
      const isPlank = pattern.x;
      const plankIndex = pattern.y;

      const plankId = vec2(plankIndex, float(0.0));
      const woodRough = float(0.82).add(
        tslHash(plankId.add(vec2(7.0, 3.0))).mul(0.1),
      );
      return mix(float(0.95), woodRough, isPlank);
    })();

    return mat;
  }

  // ---------------------------------------------------------------------------
  // Deck height lookups (used by TerrainSystem.getHeightAt and tile-movement)
  // ---------------------------------------------------------------------------

  /**
   * Get the dock deck height at a tile, or null if not a dock tile.
   */
  getDeckHeightAt(tileX: number, tileZ: number): number | null {
    const key = dockTileKey(tileX, tileZ);
    const h = this.dockDeckHeights.get(key);
    return h !== undefined ? h : null;
  }

  /**
   * Get dock deck height at a world position.
   * Called by TerrainSystem.getHeightAt() for dock-aware terrain height.
   * Dock decks are flat (constant Y per dock), so no interpolation needed.
   */
  getDeckHeightAtSmooth(worldX: number, worldZ: number): number | null {
    const tileX = Math.floor(worldX);
    const tileZ = Math.floor(worldZ);
    return this.getDeckHeightAt(tileX, tileZ);
  }

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  /** Get collision data for all docks */
  getCollisionData(): ItemCollisionData[] {
    return Array.from(this.docks.values()).map(
      (instance) => instance.dock.collision,
    );
  }

  /** Check if a tile is on a dock */
  isDockTile(tileX: number, tileZ: number): boolean {
    return this.dockDeckHeights.has(dockTileKey(tileX, tileZ));
  }

  // getDockAtTile and isDockEdgeBlocked removed — unused, and collision
  // flags are the authoritative source for tile walkability and edge blocking.

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  dispose(): void {
    // Remove world-space meshes from scene
    for (const mesh of this.dockMeshes) {
      if (this.scene) this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.dockMeshes = [];

    // Dispose shared material
    if (this.dockMaterial) {
      this.dockMaterial.dispose();
      this.dockMaterial = null;
    }

    this.docks.clear();
    this.dockDeckHeights.clear();
  }

  update(_deltaTime: number): void {
    if (this.docksGenerated) return;

    // First ready tick: build the queue (cheap — just enqueues work items)
    if (this.pendingDockQueue.length === 0 && this.isTerrainReady()) {
      this.enqueueDocks();
      if (this.pendingDockQueue.length === 0) {
        this.docksGenerated = true;
        return;
      }
    }

    // Process one dock per tick to avoid synchronous spikes
    if (this.pendingDockQueue.length > 0) {
      const def = this.pendingDockQueue.shift()!;
      try {
        this.generateDockFromDefinition(def);
      } catch (err) {
        console.error("[ProceduralDocks] Error generating dock:", err);
      }

      if (this.pendingDockQueue.length === 0) {
        this.docksGenerated = true;
      }
    }
  }
}

export type { ShorelinePoint, WaterBody, ItemCollisionData };
export { WATER_THRESHOLD, WATER_LEVEL };
