/**
 * Shore Discovery Utilities
 *
 * Provides functions for detecting valid shore positions where fishing spots
 * can spawn. Two approaches are available:
 *
 * 1. findFishingSpotTiles (PREFERRED) — Uses collision WATER flags as the
 *    single source of truth. These flags are computed by bakeWalkabilityFlags
 *    using the same grid (64×64 per 100m tile) and same logic as the water
 *    mesh generator. A tile NOT flagged WATER is guaranteed to have no water
 *    mesh geometry over it. This eliminates all grid-alignment edge cases.
 *
 * 2. findShorePoints (LEGACY) — Independently samples terrain heights.
 *    Kept for non-fishing uses and as fallback when collision data is unavailable.
 *
 */

import { TERRAIN_CONSTANTS } from "../constants/GameConstants";
import { CollisionFlag } from "../systems/shared/movement/CollisionFlags";
import type { ICollisionMatrix } from "../systems/shared/movement/CollisionMatrix";

/**
 * Represents a valid shore point where a fishing spot can spawn
 */
export interface ShorePoint {
  x: number;
  y: number; // Actual ground height
  z: number;
  waterDirection: "N" | "S" | "E" | "W" | "NE" | "NW" | "SE" | "SW";
}

/** Cardinal directions only — fishing interaction requires cardinal adjacency */
const CARDINAL_DIRS: ReadonlyArray<{
  dx: number;
  dz: number;
  name: ShorePoint["waterDirection"];
}> = [
  { dx: 0, dz: -1, name: "N" },
  { dx: 0, dz: 1, name: "S" },
  { dx: 1, dz: 0, name: "E" },
  { dx: -1, dz: 0, name: "W" },
];

/**
 * Find valid fishing spot positions at the visible water's edge.
 *
 * The water mesh is a flat plane at waterSurface Y. It extends UNDER
 * terrain on the land side — the visible shore edge is where terrain
 * height crosses the water surface, NOT at the WATER flag tile boundary
 * (which is wider due to conservative any-corner flagging).
 *
 * Algorithm:
 *   1. Find walkable land tiles with a cardinal WATER neighbor
 *   2. From the land tile boundary, walk into the water direction
 *      sampling terrain every 0.25m
 *   3. Find where terrain drops below water surface (visible shore edge)
 *   4. Place the spot 0.3m past that crossing — just inside visible water
 *   5. Y = waterSurface so the entity sits on the water plane
 *
 * @param collision - The collision matrix with baked WATER/STEEP_SLOPE flags
 * @param bounds - Rectangle to search within (world coordinates)
 * @param getHeightAt - Function to sample terrain height at (x, z)
 * @param getWaterSurfaceAt - Returns the water surface Y at (x, z).
 *        For ocean this is WATER_THRESHOLD; for elevated bodies it's body.surfaceY.
 * @param minSpacing - Minimum distance between returned points (default: 6m)
 * @returns Array of shore-edge water points where fishing spots can spawn
 */
export function findFishingSpotTiles(
  collision: ICollisionMatrix,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  getHeightAt: (x: number, z: number) => number,
  getWaterSurfaceAt: (x: number, z: number) => number,
  minSpacing = 6,
): ShorePoint[] {
  const results: ShorePoint[] = [];

  const startX = Math.floor(bounds.minX);
  const startZ = Math.floor(bounds.minZ);
  const endX = Math.floor(bounds.maxX);
  const endZ = Math.floor(bounds.maxZ);

  for (let tx = startX; tx <= endX; tx++) {
    for (let tz = startZ; tz <= endZ; tz++) {
      // Start from walkable LAND tiles
      if (
        collision.hasFlags(
          tx,
          tz,
          CollisionFlag.WATER |
            CollisionFlag.STEEP_SLOPE |
            CollisionFlag.BLOCKED,
        )
      )
        continue;

      // Must have a cardinal neighbor that IS water
      let waterDx = 0;
      let waterDz = 0;
      let waterDir: ShorePoint["waterDirection"] | null = null;
      for (const dir of CARDINAL_DIRS) {
        if (collision.hasFlags(tx + dir.dx, tz + dir.dz, CollisionFlag.WATER)) {
          waterDx = dir.dx;
          waterDz = dir.dz;
          waterDir = dir.name;
          break;
        }
      }
      if (!waterDir) continue;

      // Walk from land tile center into the water direction to find the
      // visible shore edge (where terrain drops below water surface).
      // The water mesh is flat at waterSurface — terrain above it hides the mesh.
      const landCX = tx + 0.5;
      const landCZ = tz + 0.5;
      let spotX = 0;
      let spotZ = 0;
      let waterSurface = 0;
      let found = false;

      // Search from 0.5m (tile boundary) to 3m into water, stepping 0.25m.
      // Once terrain drops below water, push 0.75m further in so the spot
      // is clearly in the water, not straddling the shore edge.
      const WATER_INSET = 0.75;
      for (let d = 0.5; d <= 3.0; d += 0.25) {
        const sx = landCX + waterDx * d;
        const sz = landCZ + waterDz * d;
        // Resolve the surface at each probe. Conservative WATER flags may
        // extend just outside a circular elevated body; sampling only the
        // neighbor center can incorrectly return the ocean level and hide an
        // otherwise valid pond shore.
        const sampledSurface = getWaterSurfaceAt(sx, sz);
        if (getHeightAt(sx, sz) < sampledSurface) {
          spotX = landCX + waterDx * (d + WATER_INSET);
          spotZ = landCZ + waterDz * (d + WATER_INSET);
          waterSurface = getWaterSurfaceAt(spotX, spotZ);
          found = true;
          break;
        }
      }
      if (!found) continue;

      // Check minimum spacing from existing points
      let tooClose = false;
      for (let i = 0; i < results.length; i++) {
        const dx = results[i].x - spotX;
        const dz = results[i].z - spotZ;
        if (dx * dx + dz * dz < minSpacing * minSpacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      results.push({
        x: spotX,
        y: waterSurface, // Spot sits on the water surface plane
        z: spotZ,
        waterDirection: waterDir,
      });
    }
  }

  return results;
}

export interface FindShorePointsOptions {
  /** Grid sampling distance in meters (default: 1m to match tile size) */
  sampleInterval?: number;
  /** Height below which is considered water (default: TERRAIN_CONSTANTS.WATER_THRESHOLD = 8.0m) */
  waterThreshold?: number;
  /** Maximum height for valid shore positions (default: 20.0m for elevated terrain) */
  shoreMaxHeight?: number;
  /** Minimum distance between shore points in meters (default: 6m) */
  minSpacing?: number;
  /** Maximum slope (tan of angle) for adjacent land to be considered walkable.
   *  Fishing spots won't spawn next to steep cliffs players can't reach.
   *  (default: TERRAIN_CONSTANTS.MAX_WALKABLE_SLOPE = 1.5) */
  maxSlope?: number;
}

/**
 * Direction offsets for checking adjacent tiles.
 * Uses 1m offset (1 tile) for tile-accurate adjacency checks.
 * This ensures fishing spots are exactly 1 tile from walkable land,
 * matching the cardinal adjacency requirement for interaction.
 */
const DIRECTIONS = [
  { dx: 0, dz: -1, name: "N" as const },
  { dx: 0, dz: 1, name: "S" as const },
  { dx: 1, dz: 0, name: "E" as const },
  { dx: -1, dz: 0, name: "W" as const },
  { dx: 1, dz: -1, name: "NE" as const },
  { dx: -1, dz: -1, name: "NW" as const },
  { dx: 1, dz: 1, name: "SE" as const },
  { dx: -1, dz: 1, name: "SW" as const },
];

/**
 * Calculate the maximum LAND slope at a position using 8-direction sampling.
 * Matches TerrainSystem.calculateSlope but skips samples that land in water,
 * since shore positions are by definition next to water — the underwater
 * terrain drop-off would otherwise register as an unwalkable cliff.
 */
function calculateLandSlopeAt(
  x: number,
  z: number,
  getHeightAt: (x: number, z: number) => number,
  waterThreshold: number,
): number {
  const d = TERRAIN_CONSTANTS.SLOPE_CHECK_DISTANCE;
  const c = getHeightAt(x, z);
  const invD = 1 / d;
  const invDiag = 1 / (d * Math.SQRT2);

  let maxSlope = 0;
  let h: number;
  let s: number;

  // Cardinal directions
  h = getHeightAt(x, z + d);
  if (h >= waterThreshold) {
    s = Math.abs(h - c) * invD;
    if (s > maxSlope) maxSlope = s;
  }
  h = getHeightAt(x, z - d);
  if (h >= waterThreshold) {
    s = Math.abs(h - c) * invD;
    if (s > maxSlope) maxSlope = s;
  }
  h = getHeightAt(x + d, z);
  if (h >= waterThreshold) {
    s = Math.abs(h - c) * invD;
    if (s > maxSlope) maxSlope = s;
  }
  h = getHeightAt(x - d, z);
  if (h >= waterThreshold) {
    s = Math.abs(h - c) * invD;
    if (s > maxSlope) maxSlope = s;
  }

  // Diagonal directions
  h = getHeightAt(x + d, z + d);
  if (h >= waterThreshold) {
    s = Math.abs(h - c) * invDiag;
    if (s > maxSlope) maxSlope = s;
  }
  h = getHeightAt(x - d, z + d);
  if (h >= waterThreshold) {
    s = Math.abs(h - c) * invDiag;
    if (s > maxSlope) maxSlope = s;
  }
  h = getHeightAt(x + d, z - d);
  if (h >= waterThreshold) {
    s = Math.abs(h - c) * invDiag;
    if (s > maxSlope) maxSlope = s;
  }
  h = getHeightAt(x - d, z - d);
  if (h >= waterThreshold) {
    s = Math.abs(h - c) * invDiag;
    if (s > maxSlope) maxSlope = s;
  }

  return maxSlope;
}

/**
 * Scans an area and returns valid shore points where fishing spots can spawn.
 *
 * Shore = on land, adjacent to water. The algorithm:
 * 1. Samples terrain in a grid pattern within bounds
 * 2. For each point, checks if it's on land (above water threshold)
 * 3. Checks if it's near water level (below shore max height)
 * 4. Checks if any adjacent tile is underwater
 * 5. Ensures minimum spacing between returned points
 *
 * @param bounds - Rectangle to search within (world coordinates)
 * @param getHeightAt - Function to sample terrain height at (x, z)
 * @param options - Configuration options
 * @returns Array of valid shore points, not guaranteed to be in any order
 */
export function findShorePoints(
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  getHeightAt: (x: number, z: number) => number,
  options: FindShorePointsOptions = {},
): ShorePoint[] {
  const {
    sampleInterval = 1, // 1m = 1 tile for tile-accurate sampling
    waterThreshold = TERRAIN_CONSTANTS.WATER_THRESHOLD,
    shoreMaxHeight = 20.0,
    minSpacing = 6,
    maxSlope = TERRAIN_CONSTANTS.MAX_WALKABLE_SLOPE,
  } = options;

  const results: ShorePoint[] = [];

  // Sample directly at tile centers (x.5, z.5) so the height check
  // position exactly matches where the entity will be placed. The old
  // approach sampled at integer positions then snapped to tile centers,
  // creating a 0.5m offset that caused spots to land in shallow water
  // on steep shorelines.
  const startX = Math.floor(bounds.minX) + 0.5;
  const startZ = Math.floor(bounds.minZ) + 0.5;
  const endX = bounds.maxX;
  const endZ = bounds.maxZ;

  for (let x = startX; x <= endX; x += sampleInterval) {
    for (let z = startZ; z <= endZ; z += sampleInterval) {
      const height = getHeightAt(x, z);

      // Must be on land (not underwater)
      if (height < waterThreshold) continue;

      // Must be near water level (shore zone)
      if (height > shoreMaxHeight) continue;

      // Verify all 4 tile corners are above water threshold.
      // This guarantees the entire 1m tile is dry. On steep shores
      // this provides an implicit ~0.5m height buffer since the
      // downhill corner must also clear the threshold.
      if (
        getHeightAt(x - 0.5, z - 0.5) < waterThreshold ||
        getHeightAt(x + 0.5, z - 0.5) < waterThreshold ||
        getHeightAt(x - 0.5, z + 0.5) < waterThreshold ||
        getHeightAt(x + 0.5, z + 0.5) < waterThreshold
      )
        continue;

      // Shore point must be walkable (not on a steep slope)
      if (calculateLandSlopeAt(x, z, getHeightAt, waterThreshold) > maxSlope)
        continue;

      // Must have adjacent water - check all 8 directions at 1 tile distance
      let waterDir: ShorePoint["waterDirection"] | null = null;
      for (const dir of DIRECTIONS) {
        const neighborHeight = getHeightAt(x + dir.dx, z + dir.dz);
        if (neighborHeight < waterThreshold) {
          waterDir = dir.name;
          break;
        }
      }
      if (!waterDir) continue;

      // Check minimum spacing from existing points (squared distance avoids sqrt)
      const minSpacingSq = minSpacing * minSpacing;
      const tooClose = results.some((p) => {
        const distSq = (p.x - x) ** 2 + (p.z - z) ** 2;
        return distSq < minSpacingSq;
      });
      if (tooClose) continue;

      results.push({
        x,
        y: height,
        z,
        waterDirection: waterDir,
      });
    }
  }

  return results;
}

/**
 * Finds points IN the water that are adjacent to walkable land.
 * This is the rules-accurate placement - fishing spots appear as ripples
 * in the water near the shore where players can reach them.
 *
 * @param bounds - Rectangle to search within (world coordinates)
 * @param getHeightAt - Function to sample terrain height at (x, z)
 * @param options - Configuration options
 * @returns Array of valid water edge points
 */
export function findWaterEdgePoints(
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  getHeightAt: (x: number, z: number) => number,
  options: FindShorePointsOptions = {},
): ShorePoint[] {
  const {
    sampleInterval = 1, // 1m = 1 tile for tile-accurate sampling
    waterThreshold = TERRAIN_CONSTANTS.WATER_THRESHOLD,
    shoreMaxHeight = 20.0,
    minSpacing = 6,
    maxSlope = TERRAIN_CONSTANTS.MAX_WALKABLE_SLOPE,
  } = options;

  const results: ShorePoint[] = [];

  // Sample at tile centers for consistency with entity placement
  const startX = Math.floor(bounds.minX) + 0.5;
  const startZ = Math.floor(bounds.minZ) + 0.5;
  const endX = bounds.maxX;
  const endZ = bounds.maxZ;

  for (let x = startX; x <= endX; x += sampleInterval) {
    for (let z = startZ; z <= endZ; z += sampleInterval) {
      const height = getHeightAt(x, z);

      // Must be visibly submerged (at least MIN_VISIBLE_WATER_DEPTH below surface).
      // Terrain barely below threshold looks like beach, not water.
      if (height >= waterThreshold - TERRAIN_CONSTANTS.MIN_VISIBLE_WATER_DEPTH)
        continue;

      // Must not be too deep (within 2m of water surface for visibility)
      if (height < waterThreshold - 2) continue;

      // Must have adjacent LAND that is walkable - check all directions
      let landDir: ShorePoint["waterDirection"] | null = null;
      for (const dir of DIRECTIONS) {
        const nx = x + dir.dx;
        const nz = z + dir.dz;
        const neighborHeight = getHeightAt(nx, nz);
        // Adjacent land must be above water, below max height, AND not too steep
        if (
          neighborHeight >= waterThreshold &&
          neighborHeight <= shoreMaxHeight &&
          calculateLandSlopeAt(nx, nz, getHeightAt, waterThreshold) <= maxSlope
        ) {
          landDir = dir.name;
          break;
        }
      }
      if (!landDir) continue;

      // Check all 4 corners of the tile — reject if any is too deep
      // (prevents spots floating on cliff faces into water)
      const cornerMinH = Math.min(
        getHeightAt(x - 0.5, z - 0.5),
        getHeightAt(x + 0.5, z - 0.5),
        getHeightAt(x - 0.5, z + 0.5),
        getHeightAt(x + 0.5, z + 0.5),
      );
      if (cornerMinH < waterThreshold - 2) continue;

      // Check minimum spacing from existing points (squared distance avoids sqrt)
      const minSpacingSq = minSpacing * minSpacing;
      const tooClose = results.some((p) => {
        const distSq = (p.x - x) ** 2 + (p.z - z) ** 2;
        return distSq < minSpacingSq;
      });
      if (tooClose) continue;

      results.push({
        x,
        y: waterThreshold, // Water surface level — spots sit on top of the water
        z,
        waterDirection: landDir,
      });
    }
  }

  return results;
}

/**
 * Shuffle array in place using Fisher-Yates algorithm.
 * Used to randomize shore point selection for variety.
 *
 * @param array - Array to shuffle (modified in place)
 * @returns The same array, now shuffled
 */
export function shuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * Find water edge points scoped to an elevated water body.
 * Convenience wrapper around findWaterEdgePoints that uses the body's
 * surfaceY as the water threshold and limits the search to the body's bounds.
 *
 * shoreMaxHeight is set relative to the body's surface (surfaceY + 12m)
 * so that land adjacent to elevated ponds passes the height check.
 * The ocean default of 20.0m is absolute (8.0 + 12 = 20), so this
 * preserves the same 12m band above water for all bodies.
 */
export function findWaterEdgePointsForBody(
  body: { centerX: number; centerZ: number; radius: number; surfaceY: number },
  getHeightAt: (x: number, z: number) => number,
  options?: Omit<FindShorePointsOptions, "waterThreshold" | "shoreMaxHeight">,
): ShorePoint[] {
  const margin = 5;
  return findWaterEdgePoints(
    {
      minX: body.centerX - body.radius - margin,
      maxX: body.centerX + body.radius + margin,
      minZ: body.centerZ - body.radius - margin,
      maxZ: body.centerZ + body.radius + margin,
    },
    getHeightAt,
    {
      ...options,
      waterThreshold: body.surfaceY,
      shoreMaxHeight: body.surfaceY + 12,
    },
  );
}

/**
 * Find shore points (ON LAND) scoped to an elevated water body.
 * Convenience wrapper around findShorePoints that uses the body's
 * surfaceY as the water threshold and limits the search to the body's bounds.
 */
export function findShorePointsForBody(
  body: { centerX: number; centerZ: number; radius: number; surfaceY: number },
  getHeightAt: (x: number, z: number) => number,
  options?: Omit<FindShorePointsOptions, "waterThreshold" | "shoreMaxHeight">,
): ShorePoint[] {
  const margin = 5;
  return findShorePoints(
    {
      minX: body.centerX - body.radius - margin,
      maxX: body.centerX + body.radius + margin,
      minZ: body.centerZ - body.radius - margin,
      maxZ: body.centerZ + body.radius + margin,
    },
    getHeightAt,
    {
      ...options,
      waterThreshold: body.surfaceY,
      shoreMaxHeight: body.surfaceY + 12,
    },
  );
}
