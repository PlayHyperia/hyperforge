import { CollisionMask } from "@hyperforge/shared";

export type PreparationReadyTile = Readonly<{
  x: number;
  z: number;
}>;

export type PreparationReadyStagingBounds = Readonly<{
  centerX: number;
  centerZ: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;

export type PreparationReadyStagingPair = Readonly<{
  tiles: readonly [PreparationReadyTile, PreparationReadyTile];
  separation: number;
  score: number;
  tieBreak: string;
}>;

const MIN_READABLE_SEPARATION = 2.75;
const MAX_READABLE_SEPARATION = 3.75;
const IDEAL_READABLE_SEPARATION = 3.25;
const MAX_SEARCH_RADIUS = 6;

/**
 * Selects one stable preparation-ready pair from authoritative static
 * collision. Entity occupancy is deliberately excluded: separate agent hosts
 * can observe different transient players or mobs, but they must still derive
 * the same two slots before each host waits for its assigned slot to clear.
 */
export function selectReadablePreparationStagingPair(
  bounds: PreparationReadyStagingBounds,
  getCollisionFlags: (tileX: number, tileZ: number) => number,
): PreparationReadyStagingPair | null {
  const candidates: PreparationReadyTile[] = [];
  const seen = new Set<string>();

  for (let radius = 1; radius <= MAX_SEARCH_RADIUS; radius += 1) {
    for (let x = bounds.minX - radius; x <= bounds.maxX + radius; x += 1) {
      for (const z of [bounds.minZ - radius, bounds.maxZ + radius]) {
        const key = `${x},${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if ((getCollisionFlags(x, z) & CollisionMask.BLOCKS_WALK) === 0) {
          candidates.push({ x, z });
        }
      }
    }
    for (let z = bounds.minZ - radius + 1; z < bounds.maxZ + radius; z += 1) {
      for (const x of [bounds.minX - radius, bounds.maxX + radius]) {
        const key = `${x},${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if ((getCollisionFlags(x, z) & CollisionMask.BLOCKS_WALK) === 0) {
          candidates.push({ x, z });
        }
      }
    }
  }

  let selected: PreparationReadyStagingPair | null = null;
  for (let firstIndex = 0; firstIndex < candidates.length; firstIndex += 1) {
    const first = candidates[firstIndex];
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < candidates.length;
      secondIndex += 1
    ) {
      const second = candidates[secondIndex];
      const separation = Math.hypot(first.x - second.x, first.z - second.z);
      if (
        separation < MIN_READABLE_SEPARATION ||
        separation > MAX_READABLE_SEPARATION
      ) {
        continue;
      }
      const firstDistance = Math.hypot(
        first.x - bounds.centerX,
        first.z - bounds.centerZ,
      );
      const secondDistance = Math.hypot(
        second.x - bounds.centerX,
        second.z - bounds.centerZ,
      );
      const score =
        Math.abs(separation - IDEAL_READABLE_SEPARATION) * 100 +
        Math.abs(firstDistance - secondDistance) * 10 +
        firstDistance +
        secondDistance;
      const tieBreak = `${first.x},${first.z}|${second.x},${second.z}`;
      if (
        !selected ||
        score < selected.score ||
        (score === selected.score && tieBreak < selected.tieBreak)
      ) {
        selected = {
          tiles: [first, second],
          separation,
          score,
          tieBreak,
        };
      }
    }
  }

  return selected;
}
