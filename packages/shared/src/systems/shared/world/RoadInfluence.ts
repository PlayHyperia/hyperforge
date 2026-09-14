/**
 * Shared road-mask arithmetic for terrain, grass workers and CPU textures.
 * The factory has no imported closures; method syntax also survives minified
 * worker-source serialization without compiler-generated naming helpers.
 */
export function createRoadInfluenceOperations() {
  return {
    /** Matches the GPU mask kernel; partial wear unions with max, never adds. */
    sampleSegment(
      x: number,
      z: number,
      ax: number,
      az: number,
      bx: number,
      bz: number,
      width: number,
      blend: number,
      maxInfluence = 1,
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
      if (distance <= width / 2) return maxInfluence;
      const edge = 1 - (distance - width / 2) / blend;
      return edge * edge * (3 - 2 * edge) * maxInfluence;
    },
    /**
     * The swept-blade clearance follows the same cubic's exclusion threshold.
     * Partial wear at/below that threshold never becomes a grass-free road.
     * Call once per validated profile, not per blade or terrain sample.
     */
    getExclusionFeather(
      blendWidth: number,
      maxInfluence: number,
      threshold = 0.8,
    ): number | null {
      if (maxInfluence <= threshold) return null;
      let low = 0,
        high = 1;
      const level = threshold / maxInfluence;
      for (let i = 0; i < 48; i++) {
        const midpoint = (low + high) / 2;
        if (midpoint * midpoint * (3 - 2 * midpoint) < level) low = midpoint;
        else high = midpoint;
      }
      return blendWidth * (1 - (low + high) / 2);
    },
  };
}

export const roadInfluenceOperations = createRoadInfluenceOperations();
