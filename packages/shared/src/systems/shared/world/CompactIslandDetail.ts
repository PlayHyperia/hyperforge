import type { WorldArea } from "../../../types/world/world-types";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";
import type { TerrainDetailRegion } from "./TerrainQuadTree";

/**
 * The broadcast's coarse terrain cannot describe a 15 m pond with 6.67 m cells.
 * Retain gameplay density at the hub and a finer grid at the irregular pond
 * bank, not every ocean/root chunk. The two intersecting pond leaves cost
 * 49,664 more triangles and 2,000,896 more geometry bytes than their 64 grid.
 * This changes visual sampling, not authoritative height or collision rules.
 */
export function createCompactPreparationDetailRegions(
  profile: WorldTerrainProfile,
  areas: Readonly<Record<string, WorldArea>>,
  gameplayResolution: number,
): readonly TerrainDetailRegion[] {
  if (profile.algorithm !== "compact-island-sculpt-v1") return [];
  if (
    !Number.isInteger(gameplayResolution) ||
    gameplayResolution < 2 ||
    gameplayResolution > 128
  ) {
    throw new Error("Invalid compact preparation terrain resolution");
  }
  return ["central_haven", "haven_pond"].map((id) => {
    const area = areas[id];
    if (!area) throw new Error(`Missing compact preparation area: ${id}`);
    return {
      ...area.bounds,
      resolution: id === "haven_pond" ? 128 : gameplayResolution,
    };
  });
}
