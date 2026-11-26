import data from "../../../data/compact-rock-footprints-v1.json";
import type { CompactLandscapeRocksManifest } from "../../../types/world/world-types";
import { COMPACT_ROCK_SOURCE_SHA256 } from "./CompactRockGeometry";
import {
  createGrassTerrainSurfaceOperations,
  type GrassTerrainExclusionPolygon,
} from "../../../utils/workers/GrassTerrainSurfaceSnapshot";

/** Small all-LOD silhouette metadata is available before grass starts. Do not
 * wait for image/model loading or decode the 393KB triangle collision payload.
 */
export function createCompactLandscapeRockFootprints(
  descriptor: CompactLandscapeRocksManifest | undefined,
): GrassTerrainExclusionPolygon[] {
  if (!descriptor) return [];
  if (
    data.schemaVersion !== 1 ||
    data.sourceSha256 !== COMPACT_ROCK_SOURCE_SHA256 ||
    descriptor.sourceSha256 !== data.sourceSha256
  )
    throw new Error("Landscape rock footprint source mismatch");
  const exclusionPolygons = descriptor.rocks.map((p) => {
    const source = data.footprints.find((f) => f.variant === p.variant);
    if (!source) throw new Error("Missing landscape rock footprint");
    const c = Math.cos(p.yaw) * p.scale,
      s = Math.sin(p.yaw) * p.scale;
    const vertices = source.vertices.map((v) => ({
      x: p.x + c * v.x + s * v.z,
      z: p.z - s * v.x + c * v.z,
    }));
    return {
      id: p.id,
      vertices,
      minX: Math.min(...vertices.map((v) => v.x)),
      maxX: Math.max(...vertices.map((v) => v.x)),
      minZ: Math.min(...vertices.map((v) => v.z)),
      maxZ: Math.max(...vertices.map((v) => v.z)),
    };
  });
  return createGrassTerrainSurfaceOperations().cloneSnapshot({
    schemaVersion: 1,
    zones: [],
    arenaFloorIds: [],
    arenaGradeHeight: null,
    waterBodies: [],
    exclusionPolygons,
  }).exclusionPolygons!;
}
