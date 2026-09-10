import { describe, expect, it } from "vitest";

import type { FlatZone } from "../../../types/world/terrain";
import {
  resolveRadialPondTerrainHeight,
  validateRadialPondTerrainProfile,
} from "./RadialPondTerrainProfile";

const zone: FlatZone = {
  id: "pond",
  centerX: 10,
  centerZ: -5,
  width: 20,
  depth: 20,
  height: 26.6,
  blendRadius: 2,
  radialPond: {
    bedRadius: 5,
    bankInnerRadius: 7,
    bankOuterRadius: 8,
    bankHeight: 28.4,
  },
};

describe("radial pond terrain profile", () => {
  it("creates a level bed, smooth shore, level bank, and smooth outer blend", () => {
    expect(validateRadialPondTerrainProfile(zone)).toBeNull();
    expect(resolveRadialPondTerrainHeight(zone, 10, -5, () => 30)).toBe(26.6);
    expect(resolveRadialPondTerrainHeight(zone, 16, -5, () => 30)).toBe(27.5);
    expect(resolveRadialPondTerrainHeight(zone, 17.5, -5, () => 30)).toBe(28.4);
    expect(resolveRadialPondTerrainHeight(zone, 19, -5, () => 30)).toBe(29.2);
    expect(resolveRadialPondTerrainHeight(zone, 20, -5, () => 30)).toBeNull();
  });

  it("rejects profiles whose index bounds cannot contain their full blend", () => {
    expect(
      validateRadialPondTerrainProfile({ ...zone, width: 19.9 }),
    ).toContain("at least 20m");
  });

  it("creates a continuous irregular shore with monotonic radial depth and unchanged outer blend", () => {
    const shaped: FlatZone = {
      ...zone,
      width: 22,
      depth: 22,
      radialPond: {
        ...zone.radialPond!,
        bankOuterRadius: 9,
        shorelineAmplitude: 0.9,
      },
    };
    expect(validateRadialPondTerrainProfile(shaped)).toBeNull();
    const circular = {
      ...shaped,
      radialPond: { ...shaped.radialPond!, shorelineAmplitude: 0 },
    };
    const crossings: number[] = [];
    const sample = (r: number, angle: number, config = shaped) =>
      resolveRadialPondTerrainHeight(
        config,
        zone.centerX + Math.cos(angle) * r,
        zone.centerZ + Math.sin(angle) * r,
        () => 30,
      )!;
    for (let i = 0; i < 256; i++) {
      const angle = (i / 256) * Math.PI * 2;
      let previous = zone.height,
        crossing = 0;
      for (let radius = 0; radius <= 9; radius += 0.025) {
        const value = sample(radius, angle);
        expect(value).toBeGreaterThanOrEqual(previous - 1e-10);
        expect(value).toBeLessThanOrEqual(shaped.radialPond!.bankHeight);
        if (!crossing && value >= 27.8) crossing = radius;
        previous = value;
      }
      crossings.push(crossing);
      expect(crossing).toBeGreaterThan(5);
      expect(crossing).toBeLessThan(7.5);
      for (const r of [9, 9.5, 10, 10.999])
        expect(sample(r, angle)).toBe(sample(r, angle, circular));
      expect(
        Math.abs(sample(9 - 1e-5, angle) - sample(9 + 1e-5, angle)),
      ).toBeLessThan(1e-7);
      // atan2's branch at -pi/pi must not create a seam.
      expect(
        Math.abs(sample(6, Math.PI - 1e-8) - sample(6, -Math.PI + 1e-8)),
      ).toBeLessThan(1e-7);
    }
    expect(Math.max(...crossings) - Math.min(...crossings)).toBeGreaterThan(1);
  });

  it("rejects nonfinite, negative and nonmonotonic shoreline amplitudes", () => {
    for (const shorelineAmplitude of [NaN, Infinity, -0.01, 0.501, 99]) {
      expect(
        validateRadialPondTerrainProfile({
          ...zone,
          radialPond: { ...zone.radialPond!, shorelineAmplitude },
        }),
      ).toContain("shorelineAmplitude");
    }
    expect(
      validateRadialPondTerrainProfile({
        ...zone,
        radialPond: { ...zone.radialPond!, shorelineAmplitude: 0 },
      }),
    ).toBeNull();
  });
});
