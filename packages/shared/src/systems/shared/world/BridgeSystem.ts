/**
 * BridgeSystem — shared system for bridge collision and geometry.
 *
 * Server: computes walkable bridge tiles, overrides WATER flags, sets deck heights.
 * Client: also creates procedural bridge geometry with TSL materials.
 *
 * Bridge deck height follows a parabolic arch curve between the two endpoints.
 * Each bridge tile stores its deck height for player Y override in tile-movement.
 *
 * Visual: wooden deck with fence posts + horizontal rails on both sides,
 * matching the duel arena fencing style but with a warm wood plank material.
 */

import type { Node } from "three/webgpu";
import type { World } from "../../../types";
import { SystemBase } from "../infrastructure/SystemBase";
import { ISLAND_BRIDGES, type BridgeDefinition } from "./BridgeDefinition";
import { CollisionFlag } from "../movement/CollisionFlags";
import type { TerrainSystem } from "./TerrainSystem";
import THREE from "../../../extras/three/three";
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
  cos,
  abs,
  fract,
  floor as tslFloor,
  dot,
  mix,
  smoothstep,
  min as tslMin,
  max as tslMax,
  mod,
  pow,
} from "three/tsl";

// ── Fence constants (matching duel arena dimensions) ──
const FENCE_POST_SPACING = 2.0; // Distance between posts (meters)
const FENCE_POST_SIZE = 0.2; // Post cross-section (square) — matches arena 0.2m
const FENCE_HEIGHT = 1.5; // Height above deck — matches arena 1.5m
const FENCE_CAP_OVERHANG = 0.06; // Cap extends beyond post — matches arena
const FENCE_CAP_HEIGHT = 0.06; // Cap thickness — matches arena
const FENCE_RAIL_HEIGHTS = [0.3, 0.75, 1.2]; // Three rails — matches arena
const FENCE_RAIL_HEIGHT = 0.08; // Rail cross-section height — matches arena
const FENCE_RAIL_DEPTH = 0.08; // Rail cross-section depth — matches arena
const DECK_THICKNESS = 0.3; // Bridge deck slab thickness

// ── Support pillar constants (stone, 3-part: base + shaft + capital) ──
const PILLAR_SPACING = 4.5; // Distance between support pillars (meters)
const PILLAR_SIZE = 0.45; // Shaft cross-section
const PILLAR_BASE_SIZE = 0.6; // Wider base
const PILLAR_BASE_HEIGHT = 0.15; // Base block height
const PILLAR_CAP_SIZE = 0.55; // Slightly wider capital
const PILLAR_CAP_HEIGHT = 0.1; // Capital block height

// ── Side stringer constants (structural beam under deck edge) ──
const STRINGER_WIDTH = 0.18; // Beam width (across bridge)
const STRINGER_HEIGHT = 0.22; // Beam depth (below deck)

// ── Cross joist constants (transverse beams under deck) ──
const JOIST_SPACING = 1.0; // Distance between cross joists (meters)
const JOIST_WIDTH = 0.12; // Joist width (along bridge)
const JOIST_HEIGHT = 0.16; // Joist depth (below deck)

// ── X-brace constants (diagonal cross-bracing between fence posts) ──
const XBRACE_SIZE = 0.05; // Cross-section of diagonal braces

/** Packed tile key for bridge deck height lookup. */
function bridgeTileKey(tileX: number, tileZ: number): number {
  return ((tileX + 32768) << 16) | (tileZ + 32768);
}

// ============================================================================
// TSL Procedural Wood Functions (matching DuelArenaVisualsSystem quality)
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
 * Wood plank pattern — simple horizontal planks spanning full bridge width.
 * Returns vec4(isPlank, plankIndex, 0, bevel).
 */
const woodPlankPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const plankWidth = float(0.45); // Wide planks — 45cm each
  const gapWidth = float(0.008); // Thin gap between planks

  // Simple horizontal planks — no stagger, full width
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
 * Running-bond stone block pattern for bridge support pillars.
 * Returns vec4(isStone, blockId.x, blockId.y, bevel).
 */
const stoneBlockPattern = Fn(([uvIn]: [Node<"vec2">]) => {
  const blockWidth = float(0.5);
  const blockHeight = float(0.25);
  const mortarWidth = float(0.012);

  const scaled = uvIn.div(vec2(blockWidth, blockHeight));
  const row = tslFloor(scaled.y);
  // Vary course height per row — alternating thick/thin courses
  const courseVar = tslHash(vec2(row, float(13.0))).mul(0.08);
  const adjustedY = scaled.y.add(courseVar.mul(row));
  const rowForOffset = tslFloor(adjustedY);
  const rowOffset = mod(rowForOffset, float(2.0))
    .mul(0.5)
    .add(tslHash(vec2(rowForOffset, float(7.0))).mul(0.2));
  const offsetUV = vec2(scaled.x.add(rowOffset), adjustedY);

  const blockId = tslFloor(offsetUV);
  const localUV = fract(offsetUV);

  const mortarU = mortarWidth.div(blockWidth);
  const mortarV = mortarWidth.div(blockHeight);

  const edgeDistX = tslMin(localUV.x, float(1.0).sub(localUV.x));
  const edgeDistY = tslMin(localUV.y, float(1.0).sub(localUV.y));
  const bevel = smoothstep(
    float(0.0),
    float(0.05),
    tslMin(edgeDistX, edgeDistY),
  );

  const isStone = smoothstep(mortarU, mortarU.add(float(0.005)), localUV.x)
    .mul(
      smoothstep(mortarU, mortarU.add(float(0.005)), float(1.0).sub(localUV.x)),
    )
    .mul(smoothstep(mortarV, mortarV.add(float(0.005)), localUV.y))
    .mul(
      smoothstep(mortarV, mortarV.add(float(0.005)), float(1.0).sub(localUV.y)),
    );

  return vec4(isStone, blockId.x, blockId.y, bevel);
});

/**
 * Orientation-aware UV for wood — uses XZ on horizontal surfaces (deck planks)
 * and XZ+Y on vertical surfaces (posts, rails) so the arch doesn't distort planks.
 */
const woodUV = Fn(() => {
  const wp = positionWorld;
  const nw = normalWorld;
  const horiz = abs(nw.y); // 1 for deck (horizontal), 0 for posts (vertical)
  const deckUV = vec2(wp.x, wp.z);
  const vertUV = vec2(wp.x.add(wp.z), wp.y);
  return mix(vertUV, deckUV, horiz);
});

/** Approach distance on each bank beyond the water edge (meters). */
const BRIDGE_BANK_APPROACH = 3;

export class BridgeSystem extends SystemBase {
  /** Map from packed tile key → bridge deck Y height */
  private deckHeights: Map<number, number> = new Map();
  private bridgeMeshes: THREE.Object3D[] = [];
  private bridgesRegistered = false;
  private adjustedBridges: BridgeDefinition[] | null = null;
  /**
   * Cached endpoint heights per bridge (startY, endY, waterY).
   * Computed during init (before deckHeights is populated), so getHeightAt()
   * returns raw terrain height — not bridge deck height. All subsequent code
   * (registerSingleBridge, createSingleBridgeGroup) reuses these cached values
   * to avoid the recursion where getHeightAt() → getDeckHeightAtSmooth() → deckY
   * would inflate the endpoint heights.
   */
  private endpointCache = new Map<
    string,
    { startY: number; endY: number; waterY: number }
  >();

  /**
   * Map from bridge endpoint tile key → bridge direction vector.
   * Used by isBridgeTransitionBlocked() to enforce railing collision.
   * Only transitions aligned with the bridge direction are allowed at endpoints.
   * This prevents perpendicular entry through fence posts at bridge corners.
   */
  private bridgeEntryTiles = new Map<
    number,
    { normDirX: number; normDirZ: number }
  >();

  constructor(world: World) {
    super(world, {
      name: "bridges",
      dependencies: {
        required: ["terrain"],
        optional: ["stage"],
      },
      autoCleanup: true,
    });
  }

  /** World initialization must finish terrain before sampling deck endpoints. */
  getDependencies() {
    return { required: ["terrain"], optional: ["stage"] };
  }

  async init(): Promise<void> {
    // Pre-compute deck heights for ALL bridge tiles eagerly at init.
    // This ensures getDeckHeightAt() returns values immediately, before
    // any terrain tile has been generated — matching the BuildingCollisionService
    // pattern where tile lookups work from the start.
    const terrain = this.world.getSystem("terrain") as TerrainSystem | null;
    if (terrain) {
      this.precomputeAllDeckHeights(terrain);
    }
  }

  /**
   * Pre-compute deck Y heights for every walkable tile on every bridge.
   * Called once at init — no dependency on terrain tile generation.
   */
  private precomputeAllDeckHeights(terrain: TerrainSystem): void {
    const collision = this.world?.collision as {
      addFlags?(x: number, z: number, f: number): void;
      removeFlags?(x: number, z: number, f: number): void;
    } | null;

    for (const bridge of this.getBridges()) {
      const dirX = bridge.endX - bridge.startX;
      const dirZ = bridge.endZ - bridge.startZ;
      const bridgeLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
      if (bridgeLen < 1) continue;

      const perpX = -(dirZ / bridgeLen);
      const perpZ = dirX / bridgeLen;

      const waterY = this.getRiverSurfaceYAtX(bridge.startX);
      // NOTE: At init time, deckHeights is empty so getHeightAt() returns raw
      // terrain height here — not bridge deck height. Cache these values so
      // registerSingleBridge and createSingleBridgeGroup don't re-query
      // getHeightAt() after the deckHeights map is populated (which would
      // return bridge height and inflate the endpoint Y).
      // Endpoints match terrain exactly for flush transition — the arch
      // handles clearance over the river in the middle.
      const startY = terrain.getHeightAt(bridge.startX, bridge.startZ);
      const endY = terrain.getHeightAt(bridge.endX, bridge.endZ);
      this.endpointCache.set(bridge.id, { startY, endY, waterY });
      const halfWidth = bridge.width / 2;

      const steps = Math.ceil(bridgeLen);
      const registeredTiles: Array<{ x: number; z: number; s: number }> = [];

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = bridge.startX + dirX * t;
        const cz = bridge.startZ + dirZ * t;
        const arch = 4 * bridge.archHeight * t * (1 - t);
        const baseY = startY + (endY - startY) * t;
        const deckY = baseY + arch;

        const leftX = cx + perpX * -halfWidth;
        const rightX = cx + perpX * halfWidth;
        const leftZ = cz + perpZ * -halfWidth;
        const rightZ = cz + perpZ * halfWidth;
        const minTX = Math.floor(Math.min(leftX, rightX));
        const maxTX = Math.floor(Math.max(leftX, rightX));
        const minTZ = Math.floor(Math.min(leftZ, rightZ));
        const maxTZ = Math.floor(Math.max(leftZ, rightZ));
        for (let tx = minTX; tx <= maxTX; tx++) {
          for (let tz = minTZ; tz <= maxTZ; tz++) {
            const tileCX = tx + 0.5;
            const tileCZ = tz + 0.5;
            const dx = tileCX - cx;
            const dz = tileCZ - cz;
            const perpDist = Math.abs(dx * perpX + dz * perpZ);
            if (perpDist > halfWidth) continue;
            this.deckHeights.set(bridgeTileKey(tx, tz), deckY);
            registeredTiles.push({ x: tx, z: tz, s });
          }
        }
      }

      // Deduplicate tiles and determine endpoint status (same logic as registerSingleBridge)
      const tileMap = new Map<
        number,
        { x: number; z: number; minS: number; maxS: number }
      >();
      for (const tile of registeredTiles) {
        const key = bridgeTileKey(tile.x, tile.z);
        const existing = tileMap.get(key);
        if (existing) {
          existing.minS = Math.min(existing.minS, tile.s);
          existing.maxS = Math.max(existing.maxS, tile.s);
        } else {
          tileMap.set(key, {
            x: tile.x,
            z: tile.z,
            minS: tile.s,
            maxS: tile.s,
          });
        }
      }

      // Register wall flags + entry tiles eagerly at init (before terrain bakes).
      // This ensures isBridgeTransitionBlocked() works immediately and wall flags
      // are in place even if the terrain tile hasn't been generated yet.
      // registerSingleBridge() re-applies these idempotently when terrain bakes.
      const normDirX = dirX / bridgeLen;
      const normDirZ = dirZ / bridgeLen;
      let entryCount = 0;

      for (const tile of tileMap.values()) {
        const isEndpoint = tile.minS === 0 || tile.maxS === steps;

        // Set collision flags if collision matrix is available
        if (collision?.addFlags && collision?.removeFlags) {
          collision.removeFlags(
            tile.x,
            tile.z,
            CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE,
          );
          collision.addFlags(tile.x, tile.z, CollisionFlag.BRIDGE);

          // Cardinal wall flags — at endpoints, skip walls aligned with bridge direction
          if (this.getDeckHeightAt(tile.x + 1, tile.z) === null) {
            if (!isEndpoint || Math.abs(normDirX) < 0.5) {
              collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_EAST);
              collision.addFlags(tile.x + 1, tile.z, CollisionFlag.WALL_WEST);
            }
          }
          if (this.getDeckHeightAt(tile.x - 1, tile.z) === null) {
            if (!isEndpoint || Math.abs(normDirX) < 0.5) {
              collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_WEST);
              collision.addFlags(tile.x - 1, tile.z, CollisionFlag.WALL_EAST);
            }
          }
          if (this.getDeckHeightAt(tile.x, tile.z + 1) === null) {
            if (!isEndpoint || Math.abs(normDirZ) < 0.5) {
              collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_SOUTH);
              collision.addFlags(tile.x, tile.z + 1, CollisionFlag.WALL_NORTH);
            }
          }
          if (this.getDeckHeightAt(tile.x, tile.z - 1) === null) {
            if (!isEndpoint || Math.abs(normDirZ) < 0.5) {
              collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_NORTH);
              collision.addFlags(tile.x, tile.z - 1, CollisionFlag.WALL_SOUTH);
            }
          }

          // Diagonal wall flags — always added (including endpoints)
          if (this.getDeckHeightAt(tile.x + 1, tile.z - 1) === null) {
            collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_NORTH_EAST);
            collision.addFlags(
              tile.x + 1,
              tile.z - 1,
              CollisionFlag.WALL_SOUTH_WEST,
            );
          }
          if (this.getDeckHeightAt(tile.x - 1, tile.z - 1) === null) {
            collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_NORTH_WEST);
            collision.addFlags(
              tile.x - 1,
              tile.z - 1,
              CollisionFlag.WALL_SOUTH_EAST,
            );
          }
          if (this.getDeckHeightAt(tile.x + 1, tile.z + 1) === null) {
            collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_SOUTH_EAST);
            collision.addFlags(
              tile.x + 1,
              tile.z + 1,
              CollisionFlag.WALL_NORTH_WEST,
            );
          }
          if (this.getDeckHeightAt(tile.x - 1, tile.z + 1) === null) {
            collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_SOUTH_WEST);
            collision.addFlags(
              tile.x - 1,
              tile.z + 1,
              CollisionFlag.WALL_NORTH_EAST,
            );
          }
        }

        // Track entry tiles with bridge direction (used by isBridgeTransitionBlocked)
        if (isEndpoint) {
          this.bridgeEntryTiles.set(bridgeTileKey(tile.x, tile.z), {
            normDirX,
            normDirZ,
          });
          entryCount++;
        }
      }
    }
  }

  /** Get bridge definitions — uses positions as defined in BridgeDefinition. */
  private getBridges(): BridgeDefinition[] {
    if (!this.adjustedBridges) {
      this.adjustedBridges = [...ISLAND_BRIDGES];
    }
    return this.adjustedBridges;
  }

  /** Get water surface Y at a bridge position. Returns water threshold from terrain. */
  private getRiverSurfaceYAtX(_x: number): number {
    const terrain = this.world.getSystem("terrain") as TerrainSystem | null;
    return terrain?.getWaterBodyRegistry()?.getOceanLevel() ?? 0;
  }

  async start(): Promise<void> {
    // Create visual bridge meshes on client only
    if (this.world.isServer) return;

    const terrain = this.world.getSystem("terrain") as TerrainSystem | null;
    if (!terrain) return;

    const stage = this.world.getSystem("stage") as {
      scene?: THREE.Scene;
    } | null;
    const scene = stage?.scene;
    if (!scene) return;

    this.createBridgeMeshes(terrain, scene);
  }

  /**
   * Register bridge collision for a terrain tile.
   * Called by TerrainSystem after bakeWalkabilityFlags().
   */
  registerBridgeCollision(
    terrainTileX: number,
    terrainTileZ: number,
    tileSize: number,
    terrain: TerrainSystem,
  ): void {
    const collision = this.world?.collision;
    if (!collision) {
      console.warn(
        "[BridgeSystem] registerBridgeCollision skipped — collision matrix not available",
      );
      return;
    }

    // Terrain meshes are centered on tileIndex * tileSize, so their covered
    // world-space region begins half a tile before that center.
    const originX = terrainTileX * tileSize - tileSize * 0.5;
    const originZ = terrainTileZ * tileSize - tileSize * 0.5;

    for (const bridge of this.getBridges()) {
      // Check if bridge overlaps this terrain tile
      const bMinX = Math.min(bridge.startX, bridge.endX) - bridge.width;
      const bMaxX = Math.max(bridge.startX, bridge.endX) + bridge.width;
      const bMinZ = Math.min(bridge.startZ, bridge.endZ) - bridge.width;
      const bMaxZ = Math.max(bridge.startZ, bridge.endZ) + bridge.width;

      if (bMaxX < originX || bMinX > originX + tileSize) continue;
      if (bMaxZ < originZ || bMinZ > originZ + tileSize) continue;

      this.registerSingleBridge(
        bridge,
        originX,
        originZ,
        tileSize,
        terrain,
        collision,
      );
    }
  }

  private registerSingleBridge(
    bridge: BridgeDefinition,
    originX: number,
    originZ: number,
    tileSize: number,
    terrain: TerrainSystem,
    collision: {
      addFlags(x: number, z: number, f: number): void;
      removeFlags(x: number, z: number, f: number): void;
    },
  ): void {
    const dirX = bridge.endX - bridge.startX;
    const dirZ = bridge.endZ - bridge.startZ;
    const bridgeLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (bridgeLen < 1) return;

    const perpX = -(dirZ / bridgeLen);
    const perpZ = dirX / bridgeLen;

    // Use cached endpoint heights (computed at init from raw terrain, not bridge-aware getHeightAt).
    // If endpointCache is missing (init ran before terrain was ready), compute it now from raw
    // terrain — deckHeights may already have values from precompute, so bypass bridge-aware
    // getHeightAt by sampling terrain directly.
    let cached = this.endpointCache.get(bridge.id);
    if (!cached) {
      const startY = terrain.getHeightAt(bridge.startX, bridge.startZ);
      const endY = terrain.getHeightAt(bridge.endX, bridge.endZ);
      const waterY = this.getRiverSurfaceYAtX(bridge.startX);
      cached = { startY, endY, waterY };
      this.endpointCache.set(bridge.id, cached);
    }
    const { startY, endY, waterY } = cached;
    const halfWidth = bridge.width / 2;

    // Walk along bridge centerline at 1m steps
    const steps = Math.ceil(bridgeLen);
    const registeredTiles: Array<{ x: number; z: number; s: number }> = [];

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = bridge.startX + dirX * t;
      const cz = bridge.startZ + dirZ * t;

      const arch = 4 * bridge.archHeight * t * (1 - t);
      const baseY = startY + (endY - startY) * t;
      const deckY = baseY + arch;

      const leftX = cx + perpX * -halfWidth;
      const rightX = cx + perpX * halfWidth;
      const leftZ = cz + perpZ * -halfWidth;
      const rightZ = cz + perpZ * halfWidth;
      const minTX = Math.floor(Math.min(leftX, rightX));
      const maxTX = Math.floor(Math.max(leftX, rightX));
      const minTZ = Math.floor(Math.min(leftZ, rightZ));
      const maxTZ = Math.floor(Math.max(leftZ, rightZ));
      for (let tx = minTX; tx <= maxTX; tx++) {
        for (let tz = minTZ; tz <= maxTZ; tz++) {
          if (tx < originX || tx >= originX + tileSize) continue;
          if (tz < originZ || tz >= originZ + tileSize) continue;

          const tileCX = tx + 0.5;
          const tileCZ = tz + 0.5;
          const dx = tileCX - cx;
          const dz = tileCZ - cz;
          const perpDist = Math.abs(dx * perpX + dz * perpZ);
          if (perpDist > halfWidth) continue;

          collision.removeFlags(
            tx,
            tz,
            CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE,
          );
          collision.addFlags(tx, tz, CollisionFlag.BRIDGE);

          const key = bridgeTileKey(tx, tz);
          this.deckHeights.set(key, deckY);
          registeredTiles.push({ x: tx, z: tz, s });
        }
      }
    }

    // Second pass: deduplicate tiles and determine endpoint status.
    // A tile appearing at multiple steps uses its min/max s to decide
    // endpoint status — prevents non-endpoint passes from over-walling
    // entry tiles that also appear at s=0 or s=steps.
    const tileMap = new Map<
      number,
      { x: number; z: number; minS: number; maxS: number }
    >();
    for (const tile of registeredTiles) {
      const key = bridgeTileKey(tile.x, tile.z);
      const existing = tileMap.get(key);
      if (existing) {
        existing.minS = Math.min(existing.minS, tile.s);
        existing.maxS = Math.max(existing.maxS, tile.s);
      } else {
        tileMap.set(key, { x: tile.x, z: tile.z, minS: tile.s, maxS: tile.s });
      }
    }

    // Third pass: railing wall flags on exposed bridge edges.
    // Check all 8 neighbors (cardinal + diagonal) — if the neighbor is NOT
    // a bridge tile, add the corresponding wall flag to block movement through
    // the railing. Diagonal walls prevent players from bypassing cardinal walls
    // via diagonal movement.
    // At endpoints: only skip cardinal walls aligned with the bridge direction
    // (entry/exit). Perpendicular cardinal walls and ALL diagonal walls are
    // always added to keep the railing sealed.
    const normDirX = dirX / bridgeLen;
    const normDirZ = dirZ / bridgeLen;

    for (const tile of tileMap.values()) {
      const isEndpoint = tile.minS === 0 || tile.maxS === steps;

      // Cardinal walls — at endpoints, skip walls in bridge direction.
      // classic MMORPG dual-tile pattern: set wall on bridge tile AND opposite wall on neighbor.
      // This ensures both isBlocked() check directions catch the wall.
      if (this.getDeckHeightAt(tile.x + 1, tile.z) === null) {
        if (!isEndpoint || Math.abs(normDirX) < 0.5) {
          collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_EAST);
          collision.addFlags(tile.x + 1, tile.z, CollisionFlag.WALL_WEST); // neighbor gets opposite wall
        }
      }
      if (this.getDeckHeightAt(tile.x - 1, tile.z) === null) {
        if (!isEndpoint || Math.abs(normDirX) < 0.5) {
          collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_WEST);
          collision.addFlags(tile.x - 1, tile.z, CollisionFlag.WALL_EAST); // neighbor gets opposite wall
        }
      }
      if (this.getDeckHeightAt(tile.x, tile.z + 1) === null) {
        if (!isEndpoint || Math.abs(normDirZ) < 0.5) {
          collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_SOUTH);
          collision.addFlags(tile.x, tile.z + 1, CollisionFlag.WALL_NORTH); // neighbor gets opposite wall
        }
      }
      if (this.getDeckHeightAt(tile.x, tile.z - 1) === null) {
        if (!isEndpoint || Math.abs(normDirZ) < 0.5) {
          collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_NORTH);
          collision.addFlags(tile.x, tile.z - 1, CollisionFlag.WALL_SOUTH); // neighbor gets opposite wall
        }
      }

      // Diagonal walls — always added (including endpoints) to seal corners.
      // Also set opposite diagonal wall on neighbor tile.
      if (this.getDeckHeightAt(tile.x + 1, tile.z - 1) === null) {
        collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_NORTH_EAST);
        collision.addFlags(
          tile.x + 1,
          tile.z - 1,
          CollisionFlag.WALL_SOUTH_WEST,
        );
      }
      if (this.getDeckHeightAt(tile.x - 1, tile.z - 1) === null) {
        collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_NORTH_WEST);
        collision.addFlags(
          tile.x - 1,
          tile.z - 1,
          CollisionFlag.WALL_SOUTH_EAST,
        );
      }
      if (this.getDeckHeightAt(tile.x + 1, tile.z + 1) === null) {
        collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_SOUTH_EAST);
        collision.addFlags(
          tile.x + 1,
          tile.z + 1,
          CollisionFlag.WALL_NORTH_WEST,
        );
      }
      if (this.getDeckHeightAt(tile.x - 1, tile.z + 1) === null) {
        collision.addFlags(tile.x, tile.z, CollisionFlag.WALL_SOUTH_WEST);
        collision.addFlags(
          tile.x - 1,
          tile.z + 1,
          CollisionFlag.WALL_NORTH_EAST,
        );
      }

      // Track endpoint tiles with bridge direction for isBridgeTransitionBlocked()
      if (isEndpoint) {
        this.bridgeEntryTiles.set(bridgeTileKey(tile.x, tile.z), {
          normDirX,
          normDirZ,
        });
      }
    }
  }

  /**
   * Get the bridge deck height at a tile, or null if not a bridge tile.
   */
  getDeckHeightAt(tileX: number, tileZ: number): number | null {
    const key = bridgeTileKey(tileX, tileZ);
    const h = this.deckHeights.get(key);
    return h !== undefined ? h : null;
  }

  /**
   * Get bridge deck height at a continuous world position with bilinear
   * interpolation of pre-computed deck heights. Uses only the deckHeights Map
   * (O(1) lookups) — no recursion back into TerrainSystem.getHeightAt().
   *
   * This is the method TerrainSystem.getHeightAt() calls to make terrain
   * height bridge-aware (single source of truth pattern).
   */
  getDeckHeightAtSmooth(worldX: number, worldZ: number): number | null {
    const tileX = Math.floor(worldX);
    const tileZ = Math.floor(worldZ);

    // Fast reject: if this tile isn't a bridge tile, skip interpolation
    const h00 = this.getDeckHeightAt(tileX, tileZ);
    if (h00 === null) return null;

    // Bilinear interpolation for smooth sub-tile height (no tile-boundary jitter)
    const h10 = this.getDeckHeightAt(tileX + 1, tileZ) ?? h00;
    const h01 = this.getDeckHeightAt(tileX, tileZ + 1) ?? h00;
    const h11 = this.getDeckHeightAt(tileX + 1, tileZ + 1) ?? h00;

    const fx = worldX - tileX;
    const fz = worldZ - tileZ;

    return (
      h00 * (1 - fx) * (1 - fz) +
      h10 * fx * (1 - fz) +
      h01 * (1 - fx) * fz +
      h11 * fx * fz
    );
  }

  /**
   * Get bridge deck height at a continuous world position.
   * Projects the point onto each bridge centerline and computes the
   * arch-interpolated deck Y. Handles sub-tile positions smoothly
   * without tile-boundary jitter.
   */
  getDeckHeightAtWorld(worldX: number, worldZ: number): number | null {
    for (const bridge of this.getBridges()) {
      const dirX = bridge.endX - bridge.startX;
      const dirZ = bridge.endZ - bridge.startZ;
      const lenSq = dirX * dirX + dirZ * dirZ;
      if (lenSq < 1) continue;
      const bridgeLen = Math.sqrt(lenSq);

      // Project point onto bridge centerline
      const dx = worldX - bridge.startX;
      const dz = worldZ - bridge.startZ;
      let t = (dx * dirX + dz * dirZ) / lenSq;
      if (t < 0 || t > 1) continue; // outside bridge length

      // Perpendicular distance
      const projX = bridge.startX + dirX * t;
      const projZ = bridge.startZ + dirZ * t;
      const perpDist = Math.sqrt(
        (worldX - projX) * (worldX - projX) +
          (worldZ - projZ) * (worldZ - projZ),
      );
      const halfWidth = bridge.width / 2;
      if (perpDist > halfWidth) continue; // outside bridge width

      // Use cached endpoint heights (avoids recursion with bridge-aware getHeightAt)
      const cached = this.endpointCache.get(bridge.id);
      if (!cached) continue;

      const arch = 4 * bridge.archHeight * t * (1 - t);
      return cached.startY + (cached.endY - cached.startY) * t + arch;
    }
    return null;
  }

  /**
   * Check if movement between two tiles is blocked by a bridge railing.
   * Returns true if one tile is a bridge tile and the other is not, AND
   * the bridge tile is NOT an endpoint (entry/exit) tile.
   *
   * This enforces: players can ONLY enter/exit bridges at their endpoints.
   * All bridge↔non-bridge transitions at interior (railing) tiles are blocked.
   */

  isBridgeTransitionBlocked(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
  ): boolean {
    const fromIsBridge = this.getDeckHeightAt(fromX, fromZ) !== null;
    const toIsBridge = this.getDeckHeightAt(toX, toZ) !== null;

    // Both on bridge or both off bridge — no railing transition
    if (fromIsBridge === toIsBridge) return false;

    // One is bridge, other is not — only allow at endpoint tiles
    const bridgeTileX = fromIsBridge ? fromX : toX;
    const bridgeTileZ = fromIsBridge ? fromZ : toZ;
    const key = bridgeTileKey(bridgeTileX, bridgeTileZ);

    const entryDir = this.bridgeEntryTiles.get(key);

    if (!entryDir) {
      return true; // Not an endpoint tile — block
    }

    // Endpoint tile — only allow transitions aligned with bridge direction.
    // This prevents perpendicular entry through fence posts at bridge corners.
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const dot = Math.abs(dx * entryDir.normDirX + dz * entryDir.normDirZ);
    if (dot < 0.5) {
      return true; // Perpendicular to bridge direction — block
    }

    return false; // Direction aligned with bridge — allow
  }

  /**
   * Create visual bridge meshes (client-only).
   */
  createBridgeMeshes(terrain: TerrainSystem, scene: THREE.Scene): void {
    if (this.bridgesRegistered) return;
    this.bridgesRegistered = true;

    const woodMaterial = this.createWoodMaterial();
    const stoneMaterial = this.createStoneMaterial();

    for (const bridge of this.getBridges()) {
      const group = this.createSingleBridgeGroup(
        bridge,
        terrain,
        woodMaterial,
        stoneMaterial,
      );
      if (group) {
        scene.add(group);
        this.bridgeMeshes.push(group);
      }
    }
  }

  /**
   * Build a complete bridge: deck + fence posts + caps + rails, merged into
   * a single draw call.
   */
  private createSingleBridgeGroup(
    bridge: BridgeDefinition,
    terrain: TerrainSystem,
    woodMaterial: MeshStandardNodeMaterial,
    stoneMaterial: MeshStandardNodeMaterial,
  ): THREE.Group | null {
    const dirX = bridge.endX - bridge.startX;
    const dirZ = bridge.endZ - bridge.startZ;
    const bridgeLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (bridgeLen < 1) return null;

    const perpX = -(dirZ / bridgeLen);
    const perpZ = dirX / bridgeLen;

    // Use cached endpoint heights (computed at init from raw terrain height)
    const cached = this.endpointCache.get(bridge.id);
    if (!cached) return null;
    const { startY, endY, waterY } = cached;
    const halfWidth = bridge.width / 2;

    const woodGeometries: THREE.BufferGeometry[] = [];
    const stoneGeometries: THREE.BufferGeometry[] = [];

    // ── 1. Deck slab ──
    const deckGeo = this.buildDeckGeometry(
      bridge,
      bridgeLen,
      dirX,
      dirZ,
      perpX,
      perpZ,
      startY,
      endY,
      halfWidth,
    );
    if (deckGeo) woodGeometries.push(deckGeo);

    // ── 2. Fence posts + caps (both sides) ──
    const postCount = Math.max(
      2,
      Math.floor(bridgeLen / FENCE_POST_SPACING) + 1,
    );

    for (let p = 0; p < postCount; p++) {
      const t = p / (postCount - 1);
      const cx = bridge.startX + dirX * t;
      const cz = bridge.startZ + dirZ * t;
      const arch = 4 * bridge.archHeight * t * (1 - t);
      const deckY = startY + (endY - startY) * t + arch;

      for (const side of [-1, 1]) {
        const px = cx + perpX * halfWidth * side;
        const pz = cz + perpZ * halfWidth * side;

        // Post body — starts at deck surface, extends up
        const postGeo = new THREE.BoxGeometry(
          FENCE_POST_SIZE,
          FENCE_HEIGHT,
          FENCE_POST_SIZE,
        );
        postGeo.translate(px, deckY + FENCE_HEIGHT / 2, pz);
        woodGeometries.push(postGeo);

        // Post cap (wider)
        const capSize = FENCE_POST_SIZE + FENCE_CAP_OVERHANG * 2;
        const capGeo = new THREE.BoxGeometry(
          capSize,
          FENCE_CAP_HEIGHT,
          capSize,
        );
        capGeo.translate(px, deckY + FENCE_HEIGHT + FENCE_CAP_HEIGHT / 2, pz);
        woodGeometries.push(capGeo);
      }
    }

    // ── 3. Horizontal rails (both sides, three heights, connecting posts) ──
    for (let p = 0; p < postCount - 1; p++) {
      const t0 = p / (postCount - 1);
      const t1 = (p + 1) / (postCount - 1);
      const cx0 = bridge.startX + dirX * t0;
      const cz0 = bridge.startZ + dirZ * t0;
      const cx1 = bridge.startX + dirX * t1;
      const cz1 = bridge.startZ + dirZ * t1;
      const arch0 = 4 * bridge.archHeight * t0 * (1 - t0);
      const arch1 = 4 * bridge.archHeight * t1 * (1 - t1);
      const deckY0 = startY + (endY - startY) * t0 + arch0;
      const deckY1 = startY + (endY - startY) * t1 + arch1;

      for (const side of [-1, 1]) {
        for (const railH of FENCE_RAIL_HEIGHTS) {
          const rg = this.buildOrientedRail(
            cx0 + perpX * halfWidth * side,
            cz0 + perpZ * halfWidth * side,
            deckY0 + railH,
            cx1 + perpX * halfWidth * side,
            cz1 + perpZ * halfWidth * side,
            deckY1 + railH,
            FENCE_RAIL_DEPTH,
            FENCE_RAIL_HEIGHT,
            perpX,
            perpZ,
          );
          woodGeometries.push(rg);
        }
      }
    }

    // ── 4. Side stringers (structural beams under deck edges) ──
    for (let p = 0; p < postCount - 1; p++) {
      const t0 = p / (postCount - 1);
      const t1 = (p + 1) / (postCount - 1);
      const cx0 = bridge.startX + dirX * t0;
      const cz0 = bridge.startZ + dirZ * t0;
      const cx1 = bridge.startX + dirX * t1;
      const cz1 = bridge.startZ + dirZ * t1;
      const arch0 = 4 * bridge.archHeight * t0 * (1 - t0);
      const arch1 = 4 * bridge.archHeight * t1 * (1 - t1);
      const deckY0 = startY + (endY - startY) * t0 + arch0;
      const deckY1 = startY + (endY - startY) * t1 + arch1;

      for (const side of [-1, 1]) {
        const sg = this.buildOrientedRail(
          cx0 + perpX * halfWidth * side,
          cz0 + perpZ * halfWidth * side,
          deckY0 - STRINGER_HEIGHT / 2 - 0.03,
          cx1 + perpX * halfWidth * side,
          cz1 + perpZ * halfWidth * side,
          deckY1 - STRINGER_HEIGHT / 2 - 0.03,
          STRINGER_WIDTH,
          STRINGER_HEIGHT,
          perpX,
          perpZ,
        );
        woodGeometries.push(sg);
      }
    }

    // ── 5. Cross joists (transverse beams under deck, between stringers) ──
    const joistCount = Math.max(2, Math.floor(bridgeLen / JOIST_SPACING) + 1);
    for (let j = 0; j < joistCount; j++) {
      const t = j / (joistCount - 1);
      const cx = bridge.startX + dirX * t;
      const cz = bridge.startZ + dirZ * t;
      const arch = 4 * bridge.archHeight * t * (1 - t);
      const deckY = startY + (endY - startY) * t + arch;
      const joistY = deckY - JOIST_HEIGHT / 2 - 0.03;

      // Joist spans between the two stringers (inset slightly from deck edge)
      const inset = STRINGER_WIDTH / 2;
      const jg = this.buildOrientedRail(
        cx + perpX * (halfWidth - inset),
        cz + perpZ * (halfWidth - inset),
        joistY,
        cx - perpX * (halfWidth - inset),
        cz - perpZ * (halfWidth - inset),
        joistY,
        JOIST_WIDTH,
        JOIST_HEIGHT,
        dirX / bridgeLen,
        dirZ / bridgeLen,
      );
      woodGeometries.push(jg);
    }

    // ── 6. X-bracing between fence posts (diagonal cross-braces) ──
    for (let p = 0; p < postCount - 1; p++) {
      const t0 = p / (postCount - 1);
      const t1 = (p + 1) / (postCount - 1);
      const cx0 = bridge.startX + dirX * t0;
      const cz0 = bridge.startZ + dirZ * t0;
      const cx1 = bridge.startX + dirX * t1;
      const cz1 = bridge.startZ + dirZ * t1;
      const arch0 = 4 * bridge.archHeight * t0 * (1 - t0);
      const arch1 = 4 * bridge.archHeight * t1 * (1 - t1);
      const deckY0 = startY + (endY - startY) * t0 + arch0;
      const deckY1 = startY + (endY - startY) * t1 + arch1;

      for (const side of [-1, 1]) {
        const px0 = cx0 + perpX * halfWidth * side;
        const pz0 = cz0 + perpZ * halfWidth * side;
        const px1 = cx1 + perpX * halfWidth * side;
        const pz1 = cz1 + perpZ * halfWidth * side;

        // Diagonal 1: bottom-left to top-right
        const d1 = this.buildOrientedRail(
          px0,
          pz0,
          deckY0 + FENCE_RAIL_HEIGHTS[0],
          px1,
          pz1,
          deckY1 + FENCE_RAIL_HEIGHTS[2],
          XBRACE_SIZE,
          XBRACE_SIZE,
          perpX,
          perpZ,
        );
        woodGeometries.push(d1);

        // Diagonal 2: top-left to bottom-right
        const d2 = this.buildOrientedRail(
          px0,
          pz0,
          deckY0 + FENCE_RAIL_HEIGHTS[2],
          px1,
          pz1,
          deckY1 + FENCE_RAIL_HEIGHTS[0],
          XBRACE_SIZE,
          XBRACE_SIZE,
          perpX,
          perpZ,
        );
        woodGeometries.push(d2);
      }
    }

    // ── 7. Stone support pillars (3-part: base + shaft + capital) ──
    const pillarCount = Math.max(2, Math.floor(bridgeLen / PILLAR_SPACING) + 1);
    for (let p = 0; p < pillarCount; p++) {
      const t = p / (pillarCount - 1);
      // Inset pillars slightly from bridge ends
      const tClamped = 0.1 + t * 0.8;
      const cx = bridge.startX + dirX * tClamped;
      const cz = bridge.startZ + dirZ * tClamped;
      const arch = 4 * bridge.archHeight * tClamped * (1 - tClamped);
      const deckY = startY + (endY - startY) * tClamped + arch;

      const pillarTop = deckY - STRINGER_HEIGHT;
      const pillarBottom = waterY - 1.5; // extend well below water
      const pillarHeight = pillarTop - pillarBottom;
      if (pillarHeight < 0.5) continue;

      // Base (wider, at bottom)
      const baseGeo = new THREE.BoxGeometry(
        PILLAR_BASE_SIZE,
        PILLAR_BASE_HEIGHT,
        PILLAR_BASE_SIZE,
      );
      baseGeo.translate(cx, pillarBottom + PILLAR_BASE_HEIGHT / 2, cz);
      stoneGeometries.push(baseGeo);

      // Shaft (main column)
      const shaftHeight = pillarHeight - PILLAR_BASE_HEIGHT - PILLAR_CAP_HEIGHT;
      const shaftGeo = new THREE.BoxGeometry(
        PILLAR_SIZE,
        shaftHeight,
        PILLAR_SIZE,
      );
      shaftGeo.translate(
        cx,
        pillarBottom + PILLAR_BASE_HEIGHT + shaftHeight / 2,
        cz,
      );
      stoneGeometries.push(shaftGeo);

      // Capital (wider top, just under deck)
      const capGeo = new THREE.BoxGeometry(
        PILLAR_CAP_SIZE,
        PILLAR_CAP_HEIGHT,
        PILLAR_CAP_SIZE,
      );
      capGeo.translate(cx, pillarTop - PILLAR_CAP_HEIGHT / 2, cz);
      stoneGeometries.push(capGeo);
    }

    const group = new THREE.Group();
    group.name = `${bridge.id}_group`;

    // ── Wood mesh (deck + fence + stringers) ──
    if (woodGeometries.length > 0) {
      const mergedWood = this.mergeGeometries(woodGeometries);
      for (const g of woodGeometries) g.dispose();
      if (mergedWood) {
        const woodMesh = new THREE.Mesh(mergedWood, woodMaterial);
        woodMesh.name = `${bridge.id}_wood`;
        woodMesh.castShadow = true;
        woodMesh.receiveShadow = true;
        woodMesh.frustumCulled = true;
        woodMesh.userData = {
          type: "terrain",
          walkable: true,
          clickable: true,
        };
        group.add(woodMesh);
      }
    }

    // ── Stone mesh (support pillars) ──
    if (stoneGeometries.length > 0) {
      const mergedStone = this.mergeGeometries(stoneGeometries);
      for (const g of stoneGeometries) g.dispose();
      if (mergedStone) {
        const stoneMesh = new THREE.Mesh(mergedStone, stoneMaterial);
        stoneMesh.name = `${bridge.id}_stone`;
        stoneMesh.castShadow = true;
        stoneMesh.receiveShadow = true;
        stoneMesh.frustumCulled = true;
        group.add(stoneMesh);
      }
    }

    return group.children.length > 0 ? group : null;
  }

  /**
   * Build an oriented rail box between two 3D endpoints.
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

    // 8 corners of the rail box
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
   * Build deck geometry with top, bottom, and side faces.
   */
  private buildDeckGeometry(
    bridge: BridgeDefinition,
    bridgeLen: number,
    dirX: number,
    dirZ: number,
    perpX: number,
    perpZ: number,
    startY: number,
    endY: number,
    halfWidth: number,
  ): THREE.BufferGeometry | null {
    const lengthSteps = Math.max(8, Math.ceil(bridgeLen / 0.5));
    const widthSteps = Math.max(4, Math.ceil(bridge.width));
    const stride = widthSteps + 1;

    const vertices: number[] = [];
    const norms: number[] = [];
    const indices: number[] = [];

    // Helper: deck Y at parameter t
    const deckYAt = (t: number) =>
      startY + (endY - startY) * t + 4 * bridge.archHeight * t * (1 - t);

    // === TOP SURFACE (flat upward normals) ===
    const topStart = vertices.length / 3;
    for (let s = 0; s <= lengthSteps; s++) {
      const t = s / lengthSteps;
      const cx = bridge.startX + dirX * t;
      const cz = bridge.startZ + dirZ * t;
      const y = deckYAt(t);
      for (let w = 0; w <= widthSteps; w++) {
        const wt = (w / widthSteps - 0.5) * bridge.width;
        vertices.push(cx + perpX * wt, y, cz + perpZ * wt);
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

    // No bottom surface, sides, or end caps — just the top plank surface.
    // Stringers and cross joists provide the visible understructure.

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
   * Merge multiple geometries into one.
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

      // Copy normals if available
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
   * Procedural wood plank material with grain, per-plank variation, and gaps.
   * Matches the DuelArenaVisualsSystem quality level.
   */
  private createWoodMaterial(): MeshStandardNodeMaterial {
    const mat = new MeshStandardNodeMaterial();

    mat.colorNode = Fn(() => {
      const uvCoord = woodUV();

      const pattern = woodPlankPattern(uvCoord);
      const isPlank = pattern.x;
      const plankIndex = pattern.y;
      const bevel = pattern.w;

      // Per-plank color variation — warm brown, each board slightly different
      const plankId = vec2(plankIndex, float(0.0));
      const h1 = tslHash(plankId);
      const h2 = tslHash(plankId.add(vec2(3.0, 7.0)));

      // Rich weathered wood — medium brown, not too light or dark
      const baseR = float(0.42).add(h1.mul(0.08)).sub(0.04);
      const baseG = float(0.28).add(h1.mul(0.06)).sub(0.03);
      const baseB = float(0.14).add(h2.mul(0.04)).sub(0.02);
      const woodColor = vec3(baseR, baseG, baseB);

      // Subtle edge darkening only
      const edgeDark = mix(float(0.92), float(1.0), bevel);

      // Dark gap between planks
      const gapColor = vec3(0.08, 0.05, 0.03);
      return vec4(mix(gapColor, woodColor.mul(edgeDark), isPlank), 1.0);
    })();

    mat.roughnessNode = Fn(() => {
      const uvCoord = woodUV();
      const pattern = woodPlankPattern(uvCoord);
      const isPlank = pattern.x;
      const plankIndex = pattern.y;

      const plankId = vec2(plankIndex, float(0.0));
      const woodRough = float(0.78).add(
        tslHash(plankId.add(vec2(7.0, 3.0))).mul(0.1),
      );
      return mix(float(0.95), woodRough, isPlank);
    })();

    return mat;
  }

  /**
   * Procedural stone block material for bridge support pillars.
   * Running-bond block pattern with per-block color variation and mortar grooves.
   */
  private createStoneMaterial(): MeshStandardNodeMaterial {
    const mat = new MeshStandardNodeMaterial();

    mat.colorNode = Fn(() => {
      const wp = positionWorld;
      const nw = normalWorld;
      const uvCoord = vec2(wp.x.add(wp.z), wp.y).mul(2.0);

      const pattern = stoneBlockPattern(uvCoord);
      const isStone = pattern.x;
      const blockId = vec2(pattern.y, pattern.z);
      const bevel = pattern.w;

      const hashVal = tslHash(blockId);

      // Gray-brown bridge stone — cooler than arena sandstone
      const r = float(0.52).add(hashVal.mul(0.1)).sub(0.05);
      const g = float(0.48).add(hashVal.mul(0.08)).sub(0.04);
      const b = float(0.42).add(hashVal.mul(0.08)).sub(0.04);
      const stoneColor = vec3(r, g, b);

      // Multi-scale surface grain — coarse pitting + fine texture
      const grain = tslNoise2D(uvCoord.mul(15.0)).mul(0.06);
      const fineGrain = tslNoise2D(uvCoord.mul(40.0)).mul(0.02);
      const grainedStone = stoneColor.add(
        vec3(grain.add(fineGrain), grain.add(fineGrain), grain.add(fineGrain)),
      );

      // Top-edge highlight per block — rain washes the top surface cleaner
      const localUV = fract(uvCoord.div(vec2(0.5, 0.25)));
      const topClean = smoothstep(float(0.85), float(0.98), localUV.y).mul(
        0.04,
      );
      const cleanedStone = grainedStone.add(vec3(topClean, topClean, topClean));

      // Moss/lichen accumulation — upward-facing surfaces + lower height (near water)
      const mossMask = smoothstep(float(0.4), float(0.85), nw.y) // upward faces
        .mul(smoothstep(float(14.0), float(10.0), wp.y)) // lower = more moss
        .mul(tslNoise2D(vec2(wp.x, wp.z).mul(1.5)).mul(0.6).add(0.4)); // patchy distribution
      const mossColor = vec3(0.14, 0.3, 0.08);
      const mossyStone = mix(cleanedStone, mossColor, mossMask.mul(0.5));

      // Water stain band — dark mineral deposit line at waterline
      const waterDist = abs(wp.y.sub(float(9.0))); // approximate water surface
      const stainBand = smoothstep(float(1.5), float(0.0), waterDist).mul(0.15);
      const stainedStone = mossyStone.mul(float(1.0).sub(stainBand));

      // Edge erosion — blocks are slightly chipped at mortar edges
      const erosionNoise = tslNoise2D(uvCoord.mul(30.0)).mul(0.03);
      const edgeDark = float(1.0).sub(float(1.0).sub(bevel)).mul(erosionNoise);

      // Mortar color (darker between blocks, with moisture)
      const mortarColor = vec3(0.25, 0.22, 0.18);
      const baseColor = mix(
        mortarColor,
        stainedStone.mul(bevel).add(vec3(edgeDark, edgeDark, edgeDark)),
        isStone,
      );

      return vec4(baseColor, 1.0);
    })();

    mat.roughnessNode = Fn(() => {
      const wp = positionWorld;
      const nw = normalWorld;
      const uvCoord = vec2(wp.x.add(wp.z), wp.y).mul(2.0);

      const pattern = stoneBlockPattern(uvCoord);
      const isStone = pattern.x;
      const blockId = vec2(pattern.y, pattern.z);

      const stoneRough = float(0.82).add(
        tslHash(blockId.add(vec2(5.0, 3.0))).mul(0.1),
      );
      const mortarRough = float(0.95);

      // Moss is rougher than stone
      const mossMask = smoothstep(float(0.4), float(0.85), nw.y)
        .mul(smoothstep(float(14.0), float(10.0), wp.y))
        .mul(tslNoise2D(vec2(wp.x, wp.z).mul(1.5)).mul(0.6).add(0.4));
      const mossRough = float(0.95);
      const surfaceRough = mix(stoneRough, mossRough, mossMask.mul(0.5));

      return mix(mortarRough, surfaceRough, isStone);
    })();

    // Normal perturbation for stone depth
    mat.normalNode = Fn(() => {
      const wp = positionWorld;
      const nw = normalWorld;
      const uvCoord = vec2(wp.x.add(wp.z), wp.y).mul(2.0);

      const pattern = stoneBlockPattern(uvCoord);
      const bevel = pattern.w;

      const eps = float(0.01);
      const bevelDx = stoneBlockPattern(uvCoord.add(vec2(eps, 0.0))).w.sub(
        bevel,
      );
      const bevelDy = stoneBlockPattern(uvCoord.add(vec2(0.0, eps))).w.sub(
        bevel,
      );

      // Stone chiseling — surface noise perturbation
      const chiselDx = tslNoise2D(uvCoord.mul(20.0).add(vec2(eps, 0.0))).sub(
        tslNoise2D(uvCoord.mul(20.0)),
      );
      const chiselDy = tslNoise2D(uvCoord.mul(20.0).add(vec2(0.0, eps))).sub(
        tslNoise2D(uvCoord.mul(20.0)),
      );

      const bumpStrength = float(0.4);
      const chiselStrength = float(0.15);
      const perturbed = vec3(
        nw.x.sub(bevelDx.mul(bumpStrength)).sub(chiselDx.mul(chiselStrength)),
        nw.y,
        nw.z.sub(bevelDy.mul(bumpStrength)).sub(chiselDy.mul(chiselStrength)),
      ).normalize();

      return perturbed;
    })();

    return mat;
  }

  destroy(): void {
    for (const obj of this.bridgeMeshes) {
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (child.material instanceof MeshStandardNodeMaterial) {
            child.material.dispose();
          }
        }
      });
      obj.removeFromParent();
    }
    this.bridgeMeshes = [];
    this.deckHeights.clear();
    this.bridgesRegistered = false;
  }
}
