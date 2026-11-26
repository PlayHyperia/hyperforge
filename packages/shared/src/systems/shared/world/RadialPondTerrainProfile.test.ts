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
  it("admits mineral-shore as appearance only and rejects mineral groundCover", () => {
    const mineral: FlatZone = {
      ...zone,
      radialPond: {
        ...zone.radialPond!,
        bankSectors: [
          {
            bearing: 0.7,
            halfWidth: 0.55,
            innerRadius: 6.4,
            innerHeight: 27.86,
          },
        ],
        bankComposition: {
          schemaVersion: 1,
          sectors: [{ sectorIndex: 0, surface: "mineral-shore" }],
        },
      },
    };
    expect(validateRadialPondTerrainProfile(mineral)).toBeNull();
    const unselected = structuredClone(mineral);
    delete unselected.radialPond!.bankComposition;
    for (let i = 0; i <= 80; i++) {
      const radius = i / 8;
      expect(
        resolveRadialPondTerrainHeight(mineral, 10 + radius, -5, () => 29.2),
      ).toBe(
        resolveRadialPondTerrainHeight(unselected, 10 + radius, -5, () => 29.2),
      );
    }
    Object.assign(mineral.radialPond!.bankComposition!.sectors[0], {
      groundCover: { emergenceHeight: 0.11, fullHeight: 0.24 },
    });
    expect(validateRadialPondTerrainProfile(mineral)).toMatch(
      /mineral-shore.*groundCover/,
    );
    Object.assign(mineral.radialPond!.bankComposition!.sectors[0], {
      surface: "mineral-unknown",
    });
    expect(validateRadialPondTerrainProfile(mineral)).toMatch(/surface/);
  });
  it("admits surface composition without changing any canonical height or lazy underlying call", () => {
    const shaped: FlatZone = {
      ...zone,
      width: 22,
      depth: 22,
      radialPond: {
        ...zone.radialPond!,
        bankOuterRadius: 9,
        shorelineAmplitude: 0.9,
        bankSectors: [
          {
            bearing: -2.3,
            halfWidth: 0.7,
            innerRadius: 6.1,
            innerHeight: 28.08,
            outerRadius: 8.2,
            outerHeight: 28.55,
          },
          {
            bearing: -1.5,
            halfWidth: 0.8,
            innerRadius: 6.8,
            innerHeight: 28.08,
            outerRadius: 8.7,
            outerHeight: 28.24,
          },
          {
            bearing: 0.7,
            halfWidth: 0.55,
            innerRadius: 6.4,
            innerHeight: 27.86,
          },
        ],
      },
    };
    const composed: FlatZone = {
      ...shaped,
      radialPond: {
        ...shaped.radialPond!,
        bankComposition: {
          schemaVersion: 1,
          sectors: [
            {
              sectorIndex: 0,
              surface: "cutbank",
              groundCover: { emergenceHeight: 0.15, fullHeight: 0.3 },
            },
            {
              sectorIndex: 1,
              surface: "sedge-shelf",
              groundCover: { emergenceHeight: 0.04, fullHeight: 0.12 },
            },
            { sectorIndex: 2, surface: "dry-turf" },
          ],
        },
      },
    };
    expect(validateRadialPondTerrainProfile(composed)).toBeNull();
    expect(shaped.radialPond).not.toHaveProperty("bankComposition");
    for (let index = 0; index <= 24; index++) {
      const angle = -Math.PI + (index / 24) * Math.PI * 2;
      for (const radius of [
        0, 4.8, 5, 5.6, 6.1, 6.8, 7.2, 8.2, 8.7, 9, 10.5, 10.999, 11, 12,
      ]) {
        const x = shaped.centerX + Math.cos(angle) * radius;
        const z = shaped.centerZ + Math.sin(angle) * radius;
        let legacyCalls = 0,
          selectedCalls = 0;
        const legacy = resolveRadialPondTerrainHeight(shaped, x, z, () => {
          legacyCalls++;
          return 30 + x * 0.02 - z * 0.01;
        });
        const selected = resolveRadialPondTerrainHeight(composed, x, z, () => {
          selectedCalls++;
          return 30 + x * 0.02 - z * 0.01;
        });
        expect(selected).toBe(legacy);
        expect(selectedCalls).toBe(legacyCalls);
      }
    }
  });

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
