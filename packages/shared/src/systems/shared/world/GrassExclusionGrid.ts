/**
 * GrassExclusionGrid - Grid-based grass exclusion system
 *
 * Queries CollisionMatrix and TerrainSystem to determine where grass should NOT grow,
 * then renders exclusion data to a texture for O(1) GPU lookup per blade.
 *
 * **Architecture:**
 * - Queries CollisionMatrix for non-walkable tiles (rocks, trees, buildings, water, slopes)
 * - Queries TerrainSystem for biome type (only grassy biomes get grass)
 * - Renders exclusion data to a streaming texture that follows the player
 * - GPU samples texture for O(1) per-blade exclusion check
 *
 * **Benefits:**
 * - Unified with game walkability logic (CollisionMatrix)
 * - Native biome support (TerrainSystem)
 * - Exact tile boundaries (no bleeding at building edges)
 * - O(1) GPU lookup (texture sample vs linear search)
 * - Streaming texture follows player (infinite world support)
 *
 * @module GrassExclusionGrid
 */

import * as THREE from "three";
import type { TextureNode } from "three/webgpu";
import { texture, uniform, Fn, float } from "three/tsl";
import type { World } from "../../../core/World";
import type { CollisionMatrix } from "../movement/CollisionMatrix";
import { CollisionFlag, CollisionMask } from "../movement/CollisionFlags";
import { BiomeType } from "./TerrainBiomeTypes";
import { BIOMES } from "../../../data/world-structure";
import { setGridExclusionTexture } from "./ProceduralGrass";
import type { TownSystem } from "./TownSystem";

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Grid configuration for grass exclusion.
 */
const GRID_CONFIG = {
  /** Texture resolution (power of 2) - each texel = 1 tile */
  TEXTURE_SIZE: 256,
  /** World size covered by texture (meters) - matches texture size for 1:1 mapping */
  WORLD_SIZE: 256,
  /** Distance player must move before re-centering texture */
  RECENTER_THRESHOLD: 64, // Re-center when player moves 64m from texture center
  /** Biomes where grass never grows - matched from biomes.json terrain types */
  NON_GRASSY_TERRAINS: new Set<string>([
    BiomeType.Canyon,
    BiomeType.Tundra,
    "mountains",
    "lake",
    "frozen",
    "corrupted",
  ]),
} as const;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Exclusion reason for debugging.
 */
type ExclusionReason =
  | "collision" // CollisionMatrix blocked (rock, tree, building, etc.)
  | "biome" // Non-grassy biome (canyon, tundra, etc.)
  | "water" // Below water level
  | "slope"; // Too steep

// ============================================================================
// GRASS EXCLUSION GRID CLASS
// ============================================================================

/**
 * Grid-based grass exclusion manager.
 *
 * Renders exclusion data from CollisionMatrix/TerrainSystem to a streaming
 * texture that follows the player. GPU samples texture for O(1) exclusion check.
 */
export class GrassExclusionGrid {
  private world: World;
  private initialized = false;

  // Current texture center (follows player)
  private centerX = 0;
  private centerZ = 0;

  // Exclusion texture (R8: 0=grass ok, 1=excluded)
  private exclusionTexture: THREE.DataTexture | null = null;
  private exclusionTextureNode: TextureNode<"vec4"> | null = null;
  private textureData: Uint8Array | null = null;

  // Uniforms for shader coordinate conversion
  private uTextureCenterX = uniform(0);
  private uTextureCenterZ = uniform(0);
  private uTextureWorldSize = uniform(GRID_CONFIG.WORLD_SIZE);

  // Statistics
  private lastUpdateTime = 0;
  private excludedTileCount = 0;
  private biomesAvailable = false;

  // Cached system references for performance
  private townSystem: TownSystem | null = null;

  constructor(world: World) {
    this.world = world;
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  /**
   * Initialize the exclusion texture.
   * Call after world systems are ready.
   */
  initialize(): void {
    if (this.initialized) return;

    const size = GRID_CONFIG.TEXTURE_SIZE;

    // Create texture data (R8 format: one byte per texel)
    this.textureData = new Uint8Array(size * size);

    // Create THREE.js DataTexture
    this.exclusionTexture = new THREE.DataTexture(
      this.textureData,
      size,
      size,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.exclusionTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.exclusionTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.exclusionTexture.minFilter = THREE.NearestFilter; // No interpolation - exact tile boundaries
    this.exclusionTexture.magFilter = THREE.NearestFilter;
    this.exclusionTexture.needsUpdate = true;

    // Create TSL texture node for shader
    this.exclusionTextureNode = texture(this.exclusionTexture);

    // Check if BIOMES data is available
    this.biomesAvailable = Object.keys(BIOMES).length > 0;
    if (!this.biomesAvailable) {
      console.warn(
        "[GrassExclusionGrid] BIOMES data not yet loaded - biome checks will be skipped until refresh",
      );
    }

    this.initialized = true;
    console.log(
      `[GrassExclusionGrid] Initialized ${size}x${size} texture covering ${GRID_CONFIG.WORLD_SIZE}m`,
    );

    // IMPORTANT: Generate initial texture immediately so gridExclusionTextureNode is set
    // before ProceduralGrass creates its SSBO (shader build time)
    this.regenerateTexture();
  }

  /**
   * Update the exclusion texture based on player position.
   * Call every frame from ProceduralGrass update loop.
   *
   * @param playerX - Player world X position
   * @param playerZ - Player world Z position
   * @returns True if texture was updated, false if no update needed
   */
  update(playerX: number, playerZ: number): boolean {
    if (!this.initialized || !this.textureData || !this.exclusionTexture) {
      return false;
    }

    // Check if we need to re-center
    const dx = playerX - this.centerX;
    const dz = playerZ - this.centerZ;
    const distSq = dx * dx + dz * dz;
    const thresholdSq =
      GRID_CONFIG.RECENTER_THRESHOLD * GRID_CONFIG.RECENTER_THRESHOLD;

    // Also refresh if BIOMES became available since last update
    const biomesNowAvailable = Object.keys(BIOMES).length > 0;
    const biomesJustLoaded = !this.biomesAvailable && biomesNowAvailable;

    if (distSq < thresholdSq && !biomesJustLoaded) {
      return false; // Player hasn't moved enough
    }

    this.biomesAvailable = biomesNowAvailable;

    // Re-center and regenerate texture
    this.centerX = Math.floor(playerX);
    this.centerZ = Math.floor(playerZ);
    this.regenerateTexture();

    return true;
  }

  /**
   * Force a full texture regeneration.
   * Call when terrain or objects change significantly.
   */
  forceRefresh(): void {
    if (!this.initialized) return;
    this.biomesAvailable = Object.keys(BIOMES).length > 0;
    this.regenerateTexture();
  }

  /**
   * Get the exclusion texture node for shader integration.
   */
  getTextureNode(): TextureNode<"vec4"> | null {
    return this.exclusionTextureNode;
  }

  /**
   * Get uniforms for shader coordinate conversion.
   */
  getUniforms(): {
    textureCenterX: ReturnType<typeof uniform>;
    textureCenterZ: ReturnType<typeof uniform>;
    textureWorldSize: ReturnType<typeof uniform>;
  } {
    return {
      textureCenterX: this.uTextureCenterX,
      textureCenterZ: this.uTextureCenterZ,
      textureWorldSize: this.uTextureWorldSize,
    };
  }

  /**
   * Create TSL function to check if a world position is excluded.
   * Returns 1.0 if excluded (no grass), 0.0 if not excluded (grass ok).
   *
   * NOTE: This method is kept for API compatibility. The actual exclusion
   * is now handled directly in ProceduralGrass's compute shader via
   * setGridExclusionTexture(). Use getTextureNode() + getUniforms() if
   * you need to integrate into a custom shader.
   */
  createExclusionCheckFn(): any {
    // Return a placeholder - actual integration is via setGridExclusionTexture
    return Fn(() => float(0));
  }

  /**
   * Get statistics for debugging.
   */
  getStats(): {
    excludedTileCount: number;
    centerX: number;
    centerZ: number;
    worldSize: number;
    lastUpdateTimeMs: number;
    biomesAvailable: boolean;
  } {
    return {
      excludedTileCount: this.excludedTileCount,
      centerX: this.centerX,
      centerZ: this.centerZ,
      worldSize: GRID_CONFIG.WORLD_SIZE,
      lastUpdateTimeMs: this.lastUpdateTime,
      biomesAvailable: this.biomesAvailable,
    };
  }

  /**
   * Dispose of GPU resources.
   */
  dispose(): void {
    this.exclusionTexture?.dispose();
    this.exclusionTexture = null;
    this.exclusionTextureNode = null;
    this.textureData = null;
    this.initialized = false;
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Regenerate the entire exclusion texture.
   */
  private regenerateTexture(): void {
    if (!this.textureData || !this.exclusionTexture) return;

    const startTime = performance.now();
    const size = GRID_CONFIG.TEXTURE_SIZE;
    const worldSize = GRID_CONFIG.WORLD_SIZE;
    const halfWorld = worldSize / 2;

    // Get systems
    const collision = this.world.collision as CollisionMatrix | undefined;
    const terrain = this.world.getSystem("terrain");

    // Get TownSystem for building footprint checks (lazy init, cached)
    if (!this.townSystem) {
      this.townSystem = this.world.getSystem("towns") as TownSystem | null;
    }

    // Log warning once if collision is not available
    if (!collision) {
      console.warn(
        "[GrassExclusionGrid] CollisionMatrix not available - collision checks skipped",
      );
    }

    let excludedCount = 0;
    let buildingTileCount = 0;

    // Iterate over all texels
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        // Convert texel to world position (1:1 mapping)
        const worldX = this.centerX - halfWorld + tx;
        const worldZ = this.centerZ - halfWorld + ty;

        // Convert to tile coordinates (floor for integer tiles)
        const tileX = Math.floor(worldX);
        const tileZ = Math.floor(worldZ);

        // Check if tile should be excluded (including building footprint check)
        const { excluded, isBuilding } = this.isTileExcluded(
          tileX,
          tileZ,
          collision,
          terrain,
        );

        // Write to texture (0 = grass ok, 255 = excluded)
        const texelIndex = ty * size + tx;
        this.textureData[texelIndex] = excluded ? 255 : 0;

        if (excluded) excludedCount++;
        if (isBuilding) buildingTileCount++;
      }
    }

    // Update THREE.js texture
    this.exclusionTexture.needsUpdate = true;

    // Update local uniforms
    this.uTextureCenterX.value = this.centerX;
    this.uTextureCenterZ.value = this.centerZ;

    // Update ProceduralGrass module-level shader data
    setGridExclusionTexture(
      this.exclusionTextureNode,
      this.centerX,
      this.centerZ,
      GRID_CONFIG.WORLD_SIZE,
    );

    this.excludedTileCount = excludedCount;
    this.lastUpdateTime = performance.now() - startTime;

    console.log(
      `[GrassExclusionGrid] Regenerated texture: ${excludedCount}/${size * size} tiles excluded ` +
        `(${buildingTileCount} building tiles) at (${this.centerX}, ${this.centerZ}) in ${this.lastUpdateTime.toFixed(1)}ms`,
    );
  }

  /**
   * Check if a tile should be excluded from grass rendering.
   * Returns both the exclusion status and whether it's a building tile.
   */
  private isTileExcluded(
    tileX: number,
    tileZ: number,
    collision: CollisionMatrix | undefined,
    terrain: ReturnType<typeof this.world.getSystem> | undefined,
  ): { excluded: boolean; isBuilding: boolean } {
    // 1. Check building coverage (footprint + bounding box for foundation overhang)
    // Uses both exact footprint AND bounding box to ensure grass doesn't poke
    // through the ~0.15m foundation overhang beyond the walkable tiles.
    if (this.townSystem) {
      const collisionService = this.townSystem.getCollisionService();
      if (collisionService) {
        // Check walkable footprint (any floor) - covers all interior tiles
        const buildingResult = collisionService.isTileInBuildingAnyFloor(
          tileX,
          tileZ,
        );
        if (buildingResult !== null) {
          return { excluded: true, isBuilding: true };
        }
        // Check bounding box - covers foundation overhang beyond footprint
        const bboxResult = collisionService.isTileInBuildingBoundingBox(
          tileX,
          tileZ,
        );
        if (bboxResult !== null) {
          return { excluded: true, isBuilding: true };
        }
      }
    }

    // 2. Check CollisionMatrix for blocked tiles (rocks, trees, etc.)
    if (collision) {
      const flags = collision.getFlags(tileX, tileZ);

      // Check for any blocking flags (BLOCKED includes rocks, trees, etc.)
      if (flags & CollisionMask.BLOCKS_WALK) {
        return { excluded: true, isBuilding: false };
      }

      // Check for water
      if (flags & CollisionFlag.WATER) {
        return { excluded: true, isBuilding: false };
      }

      // Check for steep slopes
      if (flags & CollisionFlag.STEEP_SLOPE) {
        return { excluded: true, isBuilding: false };
      }
    }

    // 3. Check biome for grass support (only if BIOMES data is loaded)
    if (this.biomesAvailable) {
      const terrainWithBiome = terrain as unknown as
        | {
            getBiomeAtPosition?: (x: number, z: number) => string;
            getBiomeData?: (
              biomeId: string,
            ) => { grass?: { enabled: boolean }; terrain?: string } | null;
          }
        | undefined;

      if (terrainWithBiome?.getBiomeAtPosition) {
        // Get biome at tile center
        const worldX = tileX + 0.5;
        const worldZ = tileZ + 0.5;
        const biomeId = terrainWithBiome.getBiomeAtPosition(worldX, worldZ);

        // First try to get biome data from TerrainSystem (authoritative)
        const biomeData =
          terrainWithBiome.getBiomeData?.(biomeId) ?? BIOMES[biomeId];

        if (biomeData) {
          // Check explicit grass config first
          if (biomeData.grass !== undefined && !biomeData.grass.enabled) {
            return { excluded: true, isBuilding: false }; // Grass explicitly disabled
          }

          // Fall back to terrain type check
          const terrainType = (biomeData as { terrain?: string }).terrain;
          if (terrainType && GRID_CONFIG.NON_GRASSY_TERRAINS.has(terrainType)) {
            return { excluded: true, isBuilding: false };
          }
        }
      }
    }

    return { excluded: false, isBuilding: false }; // Tile is not excluded - grass can grow
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let grassExclusionGridInstance: GrassExclusionGrid | null = null;

/**
 * Get or create the grass exclusion grid singleton.
 */
export function getGrassExclusionGrid(world: World): GrassExclusionGrid {
  if (!grassExclusionGridInstance) {
    grassExclusionGridInstance = new GrassExclusionGrid(world);
  }
  return grassExclusionGridInstance;
}

/**
 * Dispose of the grass exclusion grid singleton.
 */
export function disposeGrassExclusionGrid(): void {
  if (grassExclusionGridInstance) {
    grassExclusionGridInstance.dispose();
    grassExclusionGridInstance = null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export { GRID_CONFIG as GRASS_EXCLUSION_GRID_CONFIG };
export type { ExclusionReason };
