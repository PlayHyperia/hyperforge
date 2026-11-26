import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { TerrainSystem } from "../TerrainSystem";
import {
  bakeCoastalBathymetry,
  sampleCoastalBathymetry,
} from "../CoastalBathymetry";

describe("complete field from actual authored compact terrain", () => {
  it("bakes every signed texel from a real lease and checks independent coast samples", async () => {
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    try {
      await terrain.init();
      terrain["loadWaterBodiesFromManifest"]();
      terrain["loadFlatZonesFromManifest"]();
      const source = terrain.captureCanonicalGroundLease();
      expect(source.supportBounds).toHaveLength(19);
      const field = await bakeCoastalBathymetry(
        source,
        new AbortController().signal,
      );
      expect(field).not.toBeNull();
      const f = field!;
      expect(f.statistics).toMatchObject({
        samples: 644_809,
        texelBytes: 1_289_618,
        gutterSamples: 3_208,
        gutterMin: 13.5,
      });
      expect(f.statistics.signedMin).toBeLessThan(-30);
      expect(f.statistics.signedMax).toBe(13.5);
      expect(f.statistics.slices).toBeGreaterThan(1);
      expect(f.statistics.yieldCount).toBe(f.statistics.slices - 1);
      expect(["scheduler.yield", "setTimeout"]).toContain(
        f.statistics.yieldMethod,
      );
      expect(f.statistics.elapsedMs).toBeGreaterThanOrEqual(
        f.statistics.synchronousMs,
      );
      expect(
        f.data.every((value) =>
          Number.isFinite(THREE.DataUtils.fromHalfFloat(value)),
        ),
      ).toBe(true);
      let nearshore = 0,
        maxDepthError = 0,
        maxContactError = 0,
        contacts = 0;
      // Different phase/spacing from the stored half-metre grid and the earlier
      // exploratory contour oracle. This is sampled accuracy, not a global bound.
      const angles = [35.7, 41.3, 48.2, 54.6, 60.1];
      // Include the remaining coast, not just the admitted camera bay.
      for (let angle = 7.19; angle < 360; angle += 17.3) angles.push(angle);
      for (const angle of angles) {
        const radians = (angle * Math.PI) / 180;
        const depthAt = (radius: number, encoded: boolean) => {
          const x = source.profile.island.centerX + Math.cos(radians) * radius;
          const z = source.profile.island.centerZ + Math.sin(radians) * radius;
          return encoded
            ? sampleCoastalBathymetry(f, x, z)
            : f.seaLevel - source.sampleHeight(x, z);
        };
        let previousRadius = 40.13;
        let previousDepth = depthAt(previousRadius, false);
        for (let radius = 40.13; radius <= 220; radius += 0.37) {
          const x = source.profile.island.centerX + Math.cos(radians) * radius;
          const z = source.profile.island.centerZ + Math.sin(radians) * radius;
          const actual = f.seaLevel - source.sampleHeight(x, z);
          if (previousDepth <= 0 && actual > 0) {
            // Independently solve the actual and encoded zero crossing using
            // the same small bracket; no snapped grid point is the expected value.
            const crossing = (encoded: boolean) => {
              let lo = previousRadius - 0.5;
              let hi = radius + 0.5;
              expect(depthAt(lo, encoded)).toBeLessThan(0);
              expect(depthAt(hi, encoded)).toBeGreaterThan(0);
              for (let i = 0; i < 24; i++) {
                const mid = (lo + hi) / 2;
                if (depthAt(mid, encoded) > 0) hi = mid;
                else lo = mid;
              }
              return (lo + hi) / 2;
            };
            maxContactError = Math.max(
              maxContactError,
              Math.abs(crossing(true) - crossing(false)),
            );
            contacts++;
          }
          previousRadius = radius;
          previousDepth = actual;
          if (actual < -0.5 || actual > 8) continue;
          nearshore++;
          const error = Math.abs(sampleCoastalBathymetry(f, x, z) - actual);
          maxDepthError = Math.max(maxDepthError, error);
        }
      }
      expect(nearshore).toBeGreaterThan(30);
      expect(maxDepthError).toBeLessThan(0.05);
      expect(contacts).toBeGreaterThanOrEqual(angles.length);
      expect(maxContactError).toBeLessThan(0.05);
      for (const [x, z] of [
        [-1000, -1000],
        [2000, 2000],
        [149.5, 400],
        [350, 600.5],
      ])
        expect(sampleCoastalBathymetry(f, x, z)).toBe(13.5);
      expect(source.isCurrent()).toBe(true);
    } finally {
      world.destroy();
    }
  }, 30_000);
});
