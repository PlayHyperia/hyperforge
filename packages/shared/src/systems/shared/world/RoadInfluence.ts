/**
 * Shared road-mask arithmetic for terrain, grass workers and CPU textures.
 * The factory has no imported closures; method syntax also survives minified
 * worker-source serialization without compiler-generated naming helpers.
 */
export function createRoadInfluenceOperations() {
  return {
    /** Matches the existing GPU texture kernel; callers union segments with max. */
    sampleSegment(
      x: number,
      z: number,
      ax: number,
      az: number,
      bx: number,
      bz: number,
      width: number,
      blend: number,
    ): number {
      const radius = width / 2 + blend;
      if (
        x < Math.min(ax, bx) - radius ||
        x > Math.max(ax, bx) + radius ||
        z < Math.min(az, bz) - radius ||
        z > Math.max(az, bz) + radius
      )
        return 0;
      const dx = bx - ax,
        dz = bz - az,
        lengthSquared = dx * dx + dz * dz;
      const t =
        lengthSquared < 0.001
          ? 0
          : Math.max(
              0,
              Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared),
            );
      const distance = Math.hypot(x - ax - t * dx, z - az - t * dz);
      if (distance >= radius) return 0;
      if (distance <= width / 2) return 1;
      const edge = 1 - (distance - width / 2) / blend;
      return edge * edge * (3 - 2 * edge);
    },
  };
}

export const roadInfluenceOperations = createRoadInfluenceOperations();
