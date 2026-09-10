import type { WorldTerrainProfile } from "./WorldTerrainProfile";

/**
 * Art-directed compact island, independent of biome noise height functions.
 * The factory is also embedded in actual workers: keep it self-contained.
 * Broad navigable meadow, western ridge and low headlands share a continuous
 * seabed. This is authored shaping plus detail, not an erosion simulation.
 */
export function createCompactIslandLandform() {
  const helpers = {
    smooth(value: number): number {
      const t = Math.max(0, Math.min(1, value));
      return t * t * (3 - 2 * t);
    },

    hill(
      x: number,
      z: number,
      cx: number,
      cz: number,
      rx: number,
      rz: number,
    ): number {
      const dx = (x - cx) / rx;
      const dz = (z - cz) / rz;
      return this.smooth(1 - Math.sqrt(dx * dx + dz * dz));
    },
  };

  return {
    mask(
      worldX: number,
      worldZ: number,
      noise: { simplex2D(x: number, z: number): number },
      profile: WorldTerrainProfile,
    ): number {
      const island = profile.island;
      const x = worldX - island.centerX;
      const z = worldZ - island.centerZ;
      const angle = Math.atan2(z, x);
      // Periodic angular terms avoid a seam at +/-pi. The same coast controls
      // geometry and water classification, not a separate visual-only mask.
      const variation = Math.max(
        -island.maxCoastVariation,
        Math.min(
          island.maxCoastVariation,
          0.065 * Math.sin(3 * angle + 0.4) +
            0.035 * Math.cos(5 * angle - 1.1) +
            0.018 * noise.simplex2D(Math.cos(angle) * 4, Math.sin(angle) * 4),
        ),
      );
      const coast = island.radius * (1 + variation);
      const t = Math.max(
        0,
        Math.min(
          1,
          (Math.hypot(x, z) - coast + island.falloff) / island.falloff,
        ),
      );
      return 1 - helpers.smooth(Math.pow(t, island.beachProfilePower / 3));
    },

    height(
      worldX: number,
      worldZ: number,
      noise: { simplex2D(x: number, z: number): number },
      profile: WorldTerrainProfile,
    ): number {
      const mask = this.mask(worldX, worldZ, noise, profile);
      if (mask === 0) return profile.water.oceanFloorHeight;
      const dx = worldX - profile.island.centerX;
      const dz = worldZ - profile.island.centerZ;
      const x = dx / profile.island.radius;
      const z = dz / profile.island.radius;
      // Put the highest relief beside, not beneath, the existing work/duel
      // campus. Its explicit functional grades remain authoritative overlays.
      const ridge = helpers.hill(x, z, -0.59, 0.02, 0.31, 0.69);
      const northernKnoll = helpers.hill(x, z, 0.3, -0.66, 0.3, 0.27);
      const easternGrove = helpers.hill(x, z, 0.56, -0.13, 0.24, 0.38);
      const southernHeadland = helpers.hill(x, z, -0.21, 0.62, 0.44, 0.32);
      const detailScale = profile.height.featureScale;
      const detail =
        0.55 *
          noise.simplex2D(dx * 0.025 * detailScale, dz * 0.025 * detailScale) +
        0.18 *
          noise.simplex2D(dx * 0.065 * detailScale, dz * 0.065 * detailScale);
      const interior =
        profile.height.baseOffset +
        profile.height.terrainScale *
          (ridge +
            northernKnoll * 0.38 +
            easternGrove * 0.27 +
            southernHeadland * 0.32) +
        detail;
      // Unlike multiplication around zero, interpolation reaches the seabed
      // continuously, with zero coast-end slope and no height discontinuity.
      return (
        profile.water.oceanFloorHeight +
        (interior - profile.water.oceanFloorHeight) * mask
      );
    },
  };
}
