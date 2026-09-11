import type { WorldArea } from "../../../types/world/world-types";
import {
  isCompactSculptProfile,
  type WorldTerrainProfile,
} from "./WorldTerrainProfile";
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
  if (!isCompactSculptProfile(profile)) return [];
  if (
    !Number.isInteger(gameplayResolution) ||
    gameplayResolution < 2 ||
    gameplayResolution > 128
  ) {
    throw new Error("Invalid compact preparation terrain resolution");
  }
  const preparation = ["central_haven", "haven_pond"].map((id) => {
    const area = areas[id];
    if (!area) throw new Error(`Missing compact preparation area: ${id}`);
    return {
      ...area.bounds,
      resolution: id === "haven_pond" ? 128 : gameplayResolution,
    };
  });
  if (
    profile.algorithm !== "compact-island-sculpt-v2" &&
    profile.algorithm !== "compact-island-sculpt-v3"
  )
    return preparation;
  const shape = profile.landform;
  if (!shape)
    throw new Error("Authored sculpt detail requires admitted landform");
  const { centerX, centerZ, radius, maxCoastVariation } = profile.island;
  const scale = radius / 165;
  const c = Math.cos(shape.inletBearing),
    s = Math.sin(shape.inletBearing);
  const corners = [
    shape.inletTipDistance,
    165 * (1 + maxCoastVariation),
  ].flatMap((along) =>
    [-shape.inletHalfWidth, shape.inletHalfWidth].map((across) => ({
      x: centerX + (along * c - across * s) * scale,
      z: centerZ + (along * s + across * c) * scale,
    })),
  );
  // Actual v3 support: four western headland/ridge leaves and six bounding
  // the rotated southeast bay. The shallow eastern ridge tail remains coarse.
  // Ten64 leaves add 78,720 triangles / 3,202,560 geometry bytes over16;
  // this is a declared local geometry cost, not a frame-time qualification.
  return [
    ...preparation,
    {
      minX: centerX - radius * (1 + maxCoastVariation),
      maxX: centerX + (shape.ridgeBaseX + shape.ridgeEastWidth / 2) * scale,
      minZ: centerZ + shape.ridgeStartZ * scale,
      maxZ: centerZ + shape.ridgeEndZ * scale,
      resolution: 64,
      keepMinSize: true,
    },
    {
      minX: Math.min(...corners.map((p) => p.x)),
      maxX: Math.max(...corners.map((p) => p.x)),
      minZ: Math.min(...corners.map((p) => p.z)),
      maxZ: Math.max(...corners.map((p) => p.z)),
      resolution: 64,
      keepMinSize: true,
    },
  ];
}
