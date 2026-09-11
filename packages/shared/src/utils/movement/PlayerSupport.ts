import { getDuelArenaSolidSurfaceHeight } from "../../data/arena-grading";
import { PLAYER_ROOT_CLEARANCE } from "./PlayerSupportConstants";

export { PLAYER_ROOT_CLEARANCE } from "./PlayerSupportConstants";

export interface PlayerTerrainSupport {
  /** Includes any authoritative bridge deck; not raw procedural height. */
  getHeightAt(x: number, z: number): number | null;
}

export interface PlayerBuildingSupport {
  getBuildingAt(tileX: number, tileZ: number): string | null;
  getFloor(
    buildingId: string,
    floorIndex: number,
  ):
    | {
        elevation: number;
        walkableTiles: ReadonlySet<string>;
      }
    | undefined;
  getStairElevation?(x: number, z: number, floorIndex: number): number | null;
  getStepHeightAtWorld(x: number, z: number): number | null;
}

/**
 * Actual support surface, without changing terrain grading, physics or assets.
 * Building queries use integer tiles and the requested floor only: a missing
 * upper floor never promotes an unrelated ground floor or whole bounding box.
 * Missing/non-finite support remains null for the caller's admission policy.
 */
export function resolvePlayerSupportHeight(
  x: number,
  z: number,
  terrain: PlayerTerrainSupport | null | undefined,
  buildings?: PlayerBuildingSupport | null,
  floorIndex = 0,
): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  if (!Number.isSafeInteger(floorIndex) || floorIndex < 0) return null;
  if (buildings) {
    const tileX = Math.floor(x),
      tileZ = Math.floor(z);
    const buildingId = buildings.getBuildingAt(tileX, tileZ);
    if (buildingId !== null) {
      const floor = buildings.getFloor(buildingId, floorIndex);
      // Navigation occupancy (such as furniture) does not remove the floor.
      if (floor?.walkableTiles.has(`${tileX},${tileZ}`)) {
        if (!Number.isFinite(floor.elevation)) return null;
        const stair = buildings.getStairElevation?.(x, z, floorIndex);
        if (stair !== null && stair !== undefined)
          return Number.isFinite(stair) ? stair : null;
        return floor.elevation;
      }
    }
    // Entrance steps are a ground-level surface, not an upper-floor fallback.
    if (floorIndex === 0) {
      const step = buildings.getStepHeightAtWorld(x, z);
      if (step !== null) return Number.isFinite(step) ? step : null;
    }
  }
  const platform = getDuelArenaSolidSurfaceHeight(x, z);
  if (platform !== null) return platform;
  const height = terrain?.getHeightAt(x, z);
  return height !== null && height !== undefined && Number.isFinite(height)
    ? height
    : null;
}

/** Apply the same player-only clearance on spawn, movement and return. */
export function resolvePlayerRootHeight(
  x: number,
  z: number,
  terrain: PlayerTerrainSupport | null | undefined,
  buildings?: PlayerBuildingSupport | null,
  floorIndex = 0,
): number | null {
  const support = resolvePlayerSupportHeight(
    x,
    z,
    terrain,
    buildings,
    floorIndex,
  );
  return support === null ? null : support + PLAYER_ROOT_CLEARANCE;
}
