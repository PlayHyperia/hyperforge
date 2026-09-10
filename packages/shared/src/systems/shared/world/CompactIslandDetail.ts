import type { WorldArea } from "../../../types/world/world-types";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";
import type { TerrainDetailRegion } from "./TerrainQuadTree";

/**
 * The broadcast's coarse terrain cannot describe a 15 m pond with 6.67 m cells.
 * Use the admitted gameplay grid density for its banks and the preparation hub,
 * not for every ocean/root chunk. No authoritative height or collision changes.
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
    return { ...area.bounds, resolution: gameplayResolution };
  });
}
