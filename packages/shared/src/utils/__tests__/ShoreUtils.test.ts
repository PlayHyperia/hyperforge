import { describe, expect, it } from "vitest";

import { CollisionFlag } from "../../systems/shared/movement/CollisionFlags";
import { CollisionMatrix } from "../../systems/shared/movement/CollisionMatrix";
import { findFishingSpotTiles } from "../ShoreUtils";

describe("findFishingSpotTiles", () => {
  it("resolves an elevated circular water surface after a conservative water flag", () => {
    const collision = new CollisionMatrix();
    collision.addFlags(0, -1, CollisionFlag.WATER);

    const oceanSurface = 16;
    const pondSurface = 22;
    const pondCenter = { x: 0.5, z: -1.5 };
    const pondRadiusSq = 0.6 ** 2;
    const getWaterSurfaceAt = (x: number, z: number) => {
      const dx = x - pondCenter.x;
      const dz = z - pondCenter.z;
      return dx * dx + dz * dz <= pondRadiusSq ? pondSurface : oceanSurface;
    };

    // The flagged neighbor's center lies outside the circle. A single surface
    // lookup there sees only the ocean level, while the inward probes cross
    // the actual elevated pond geometry.
    expect(getWaterSurfaceAt(0.5, -0.5)).toBe(oceanSurface);

    const points = findFishingSpotTiles(
      collision,
      { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
      () => 20,
      getWaterSurfaceAt,
    );

    expect(points).toEqual([
      {
        x: 0.5,
        y: pondSurface,
        z: -1.75,
        waterDirection: "N",
      },
    ]);
  });
});
