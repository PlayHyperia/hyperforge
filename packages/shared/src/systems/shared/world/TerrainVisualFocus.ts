import { CAMERA_CONSTANTS } from "../../../constants/GameConstants";
import type THREE from "../../../extras/three/three";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";

/** Conservative normal follow-camera clearance, not a camera or movement clamp. */
export const COMPACT_TERRAIN_CAMERA_MARGIN = CAMERA_CONSTANTS.MAX_ZOOM;

export type TerrainFocusCenter = { id: string; position: THREE.Vector3 };

/**
 * Admission for an authored compact island, not arbitrary offshore exploration.
 * The tree still follows its actual player focus and can change roots normally.
 * Strict interior bounds avoid Math.round's asymmetric half-root boundary ties.
 */
export function getCompactSingleRootCoverage(
  profile: WorldTerrainProfile,
  minSize: number,
  maxDepth: number,
) {
  if (
    profile.kind !== "compact-candidate" ||
    !Number.isFinite(minSize) ||
    minSize <= 0 ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > 20
  )
    return null;
  const size = minSize * 2 ** maxDepth;
  const { bounds, island } = profile;
  if (
    !Number.isSafeInteger(size) ||
    ![
      ...Object.values(bounds),
      island.centerX,
      island.centerZ,
      island.radius,
      island.maxCoastVariation,
      island.deepOceanBuffer,
    ].every(Number.isFinite) ||
    bounds.minX >= bounds.maxX ||
    bounds.minZ >= bounds.maxZ ||
    island.radius <= 0 ||
    island.maxCoastVariation < 0 ||
    island.maxCoastVariation >= 1 ||
    island.deepOceanBuffer < 0
  )
    return null;
  const extent =
    island.radius * (1 + island.maxCoastVariation) + island.deepOceanBuffer;
  if (
    island.centerX - extent < bounds.minX ||
    island.centerX + extent > bounds.maxX ||
    island.centerZ - extent < bounds.minZ ||
    island.centerZ + extent > bounds.maxZ
  )
    return null;
  const centerX = Math.round(island.centerX / size) * size;
  const centerZ = Math.round(island.centerZ / size) * size;
  const minX = centerX - size / 2,
    maxX = centerX + size / 2;
  const minZ = centerZ - size / 2,
    maxZ = centerZ + size / 2;
  const margin = COMPACT_TERRAIN_CAMERA_MARGIN;
  if (
    bounds.minX - margin <= minX ||
    bounds.maxX + margin >= maxX ||
    bounds.minZ - margin <= minZ ||
    bounds.maxZ + margin >= maxZ
  )
    return null;
  return Object.freeze({
    id: "compact-single-root-v1" as const,
    rootSize: size,
    centerX,
    centerZ,
    rootBounds: Object.freeze({ minX, maxX, minZ, maxZ }),
    cameraMargin: margin,
  });
}

export function resolveTerrainVisualRootRadius(
  profile: WorldTerrainProfile,
  minSize: number,
  maxDepth: number,
  streamingViewport: boolean,
): 0 | 1 {
  // Preserve the existing stream contract; only normal compact play is new.
  return streamingViewport ||
    getCompactSingleRootCoverage(profile, minSize, maxDepth)
    ? 0
    : 1;
}

/** Preserve all remote centers/order while making the actual local owner first. */
export function prioritizeLocalTerrainCenter(
  centers: TerrainFocusCenter[],
  local: TerrainFocusCenter | null,
): void {
  if (
    !local ||
    ![local.position.x, local.position.y, local.position.z].every(
      Number.isFinite,
    )
  )
    return;
  const index = centers.findIndex((center) => center.id === local.id);
  if (index === 0) {
    centers[0] = local;
    return;
  }
  if (index > 0) centers.splice(index, 1);
  centers.unshift(local);
}
