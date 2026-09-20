/**
 * ZoneDetectionSystem
 *
 * Single source of truth for zone type detection.
 * Determines if a position is in safe area, wilderness, or PvP zone.
 * Caches results for performance.
 */

import { SystemBase } from "../infrastructure/SystemBase";
import type { World } from "../../../core/World";
import {
  getZoneByPosition,
  type ZoneData,
} from "../../../data/world-structure";
import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import { getDuelArenaProtectionBounds } from "../../../data/duel-manifest";
import type { ZoneType, ZoneProperties } from "../../../types/death";
import { ZoneType as ZoneTypeEnum } from "../../../types/death";
import type { WorldArea } from "../../../types/core/core";
import type { TownSystem } from "../world/TownSystem";

export class ZoneDetectionSystem extends SystemBase {
  // Cache zone lookups (key: "x,z", value: ZoneProperties)
  private zoneCache = new Map<string, ZoneProperties>();
  // Reduced from 10 to 2 to prevent boundary misclassification
  // Smaller grid = more cache misses but correct results near boundaries
  private readonly CACHE_GRID_SIZE = 2;
  // Track zone boundaries for cache invalidation near edges
  private zoneBoundaries: Array<{
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  }> = [];
  // Reference to procedural town system
  private townSystem?: TownSystem;

  constructor(world: World) {
    super(world, {
      name: "zone-detection",
      dependencies: {
        required: [],
        optional: ["towns"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // Get town system reference for procedural safe zones
    this.townSystem = this.world.getSystem("towns") as TownSystem | undefined;

    // Build zone boundaries list for cache invalidation
    this.buildBoundariesList();
    // Pre-warm cache for known areas
    this.prewarmCache();
  }

  /**
   * Build list of zone boundaries for cache proximity checking
   */
  private buildBoundariesList(): void {
    this.zoneBoundaries = [];

    for (const area of Object.values(ALL_WORLD_AREAS) as WorldArea[]) {
      if (area.id === "duel_arena") {
        // Include every facility edge: the enclosing arena rectangle does not
        // describe the unprotected gaps between its individual floors.
        this.zoneBoundaries.push(...getDuelArenaProtectionBounds());
      } else if (area.bounds) {
        this.zoneBoundaries.push({
          minX: area.bounds.minX,
          maxX: area.bounds.maxX,
          minZ: area.bounds.minZ,
          maxZ: area.bounds.maxZ,
        });
      }
    }

    console.log(
      `[ZoneDetectionSystem] Loaded ${this.zoneBoundaries.length} zone boundaries`,
    );
  }

  /**
   * Check if position is near any zone boundary
   * If so, we should skip caching to avoid misclassification
   */
  private isNearBoundary(x: number, z: number): boolean {
    const margin = this.CACHE_GRID_SIZE + 1; // Extra margin for safety

    for (const bounds of this.zoneBoundaries) {
      // Check if within margin of any boundary edge
      const nearMinX = Math.abs(x - bounds.minX) <= margin;
      const nearMaxX = Math.abs(x - bounds.maxX) <= margin;
      const nearMinZ = Math.abs(z - bounds.minZ) <= margin;
      const nearMaxZ = Math.abs(z - bounds.maxZ) <= margin;

      // Only count as near if we're actually potentially inside or just outside the zone
      const inXRange = x >= bounds.minX - margin && x <= bounds.maxX + margin;
      const inZRange = z >= bounds.minZ - margin && z <= bounds.maxZ + margin;

      if (
        inXRange &&
        inZRange &&
        (nearMinX || nearMaxX || nearMinZ || nearMaxZ)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if position is in wilderness
   */
  isWilderness(position: { x: number; z: number }): boolean {
    const props = this.getZoneProperties(position);
    return props.isWilderness;
  }

  /**
   * Check if position is in safe zone
   */
  isSafeZone(position: { x: number; z: number }): boolean {
    const props = this.getZoneProperties(position);
    return props.isSafe;
  }

  /**
   * Check if PvP is enabled at position
   */
  isPvPEnabled(position: { x: number; z: number }): boolean {
    const props = this.getZoneProperties(position);
    return props.isPvPEnabled;
  }

  /**
   * Get zone type enum
   */
  getZoneType(position: { x: number; z: number }): ZoneType {
    const props = this.getZoneProperties(position);
    return props.type;
  }

  /**
   * Get complete zone properties (cached)
   * Skip caching near zone boundaries to prevent misclassification
   */
  getZoneProperties(position: { x: number; z: number }): ZoneProperties {
    // Don't cache near boundaries to prevent misclassification
    const nearBoundary = this.isNearBoundary(position.x, position.z);

    if (!nearBoundary) {
      // Check cache first (safe to use cache away from boundaries)
      const cacheKey = this.getCacheKey(position.x, position.z);
      const cached = this.zoneCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // Lookup zone
      const props = this.lookupZoneProperties(position);

      // Cache result (only if not near boundary)
      this.zoneCache.set(cacheKey, props);

      return props;
    }

    // Near boundary: always do fresh lookup, don't cache
    return this.lookupZoneProperties(position);
  }

  /**
   * Actual zone lookup logic
   * Finds the SMALLEST matching zone to handle overlapping zones correctly
   * (e.g., duel_arena inside central_haven)
   */
  private lookupZoneProperties(position: {
    x: number;
    z: number;
  }): ZoneProperties {
    // Find all matching zones and select the smallest one (most specific)
    let bestMatch: { area: WorldArea; size: number } | null = null;
    const allAreas = Object.values(ALL_WORLD_AREAS) as WorldArea[];

    // Debug: log all available zones
    console.log(
      `[ZoneDetection] Checking ${allAreas.length} zones for position (${position.x.toFixed(1)}, ${position.z.toFixed(1)})`,
    );
    console.log(
      `[ZoneDetection] Available zones: ${allAreas.map((a) => a.id).join(", ")}`,
    );

    for (const area of allAreas) {
      const isDuelArena = area.id === "duel_arena";
      const boundsList = isDuelArena
        ? getDuelArenaProtectionBounds()
        : area.bounds
          ? [area.bounds]
          : [];
      // Only the explicitly selected facility policy includes its lower edges.
      // Historical arena and non-arena zones keep their exclusive minima.
      const inclusiveMinima =
        isDuelArena && area.duelProtection === "facility-floors-v1";
      for (const { minX, maxX, minZ, maxZ } of boundsList) {
        const inBounds =
          (inclusiveMinima ? position.x >= minX : position.x > minX) &&
          position.x <= maxX &&
          (inclusiveMinima ? position.z >= minZ : position.z > minZ) &&
          position.z <= maxZ;

        if (inBounds) {
          // Compare the actual matching component, not its enclosing rectangle.
          const zoneSize = (maxX - minX) * (maxZ - minZ);
          console.log(`[ZoneDetection] MATCH: ${area.id} (size: ${zoneSize})`);

          // Keep the smallest matching zone
          if (!bestMatch || zoneSize < bestMatch.size) {
            bestMatch = { area, size: zoneSize };
          }
        }
      }
    }

    if (bestMatch) {
      console.log(
        `[ZoneDetection] Selected: ${bestMatch.area.id} (smallest match)`,
      );
    }

    // Return the smallest matching zone
    if (bestMatch) {
      const area = bestMatch.area;
      const isSafe = area.safeZone === true;
      const isPvP = area.pvpEnabled === true;
      const isWild = !isSafe || isPvP;

      let type: ZoneType;
      if (isPvP) {
        type = ZoneTypeEnum.PVP_ZONE;
      } else if (isSafe) {
        type = ZoneTypeEnum.SAFE_AREA;
      } else {
        type = ZoneTypeEnum.WILDERNESS;
      }

      return {
        type,
        isSafe,
        isPvPEnabled: isPvP,
        isWilderness: isWild,
        name: area.name,
        difficultyLevel: area.difficultyLevel,
        id: area.id,
      };
    }

    // Check zones (from data/world-structure.ts)
    const zone = getZoneByPosition(position);
    if (zone) {
      interface ZoneWithProperties extends ZoneData {
        safeZone?: boolean;
        pvpEnabled?: boolean;
      }
      const zoneWithProps = zone as ZoneWithProperties;
      const isSafe = zoneWithProps.safeZone === true || zone.isTown === true;
      const isPvP = zoneWithProps.pvpEnabled === true;
      const isWild = !isSafe || isPvP;

      let type: ZoneType;
      if (isPvP) {
        type = ZoneTypeEnum.PVP_ZONE;
      } else if (isSafe) {
        type = ZoneTypeEnum.SAFE_AREA;
      } else {
        type = ZoneTypeEnum.WILDERNESS;
      }

      return {
        type,
        isSafe,
        isPvPEnabled: isPvP,
        isWilderness: isWild,
        name: zone.name || "Unknown Zone",
        difficultyLevel: zone.difficultyLevel || 0,
        id: zone.id,
      };
    }

    // Check procedurally generated towns from TownSystem
    // These are safe zones where players cannot be attacked
    if (this.townSystem) {
      const town = this.townSystem.getTownAtPosition(position.x, position.z);
      if (town) {
        return {
          type: ZoneTypeEnum.SAFE_AREA,
          isSafe: true,
          isPvPEnabled: false,
          isWilderness: false,
          name: town.name,
          difficultyLevel: 0,
          id: town.id,
        };
      }
    }

    // Default unknown areas to UNKNOWN type (treated as wilderness for death mechanics)
    // This is the conservative approach for death system - prevents exploits in undefined areas
    // Items will drop on death, incentivizing proper zone definition
    return {
      type: ZoneTypeEnum.UNKNOWN,
      isSafe: false, // Unknown areas are NOT safe
      isPvPEnabled: false, // But PvP is still disabled
      isWilderness: true, // Treat as wilderness for item drops
      name: "Unknown",
      difficultyLevel: 1, // Low difficulty but not 0
    };
  }

  /**
   * Generate cache key for position (quantized to grid)
   */
  private getCacheKey(x: number, z: number): string {
    const gridX = Math.floor(x / this.CACHE_GRID_SIZE);
    const gridZ = Math.floor(z / this.CACHE_GRID_SIZE);
    return `${gridX},${gridZ}`;
  }

  /**
   * Pre-warm cache for known safe zones
   */
  private prewarmCache(): void {
    // Cache starter area and known towns
    for (const area of Object.values(ALL_WORLD_AREAS) as WorldArea[]) {
      if (area.safeZone && area.bounds) {
        const centerX = (area.bounds.minX + area.bounds.maxX) / 2;
        const centerZ = (area.bounds.minZ + area.bounds.maxZ) / 2;
        this.getZoneProperties({ x: centerX, z: centerZ });
      }
    }
  }

  /**
   * Clear zone cache (for testing or dynamic zone changes)
   */
  clearCache(): void {
    this.zoneCache.clear();
  }

  // Required System lifecycle methods
  preTick(): void {}
  preFixedUpdate(): void {}
  fixedUpdate(_dt: number): void {}
  postFixedUpdate(): void {}
  preUpdate(): void {}
  update(_dt: number): void {}
  postUpdate(): void {}
  lateUpdate(): void {}
  postLateUpdate(): void {}
  commit(): void {}
  postTick(): void {}
}
