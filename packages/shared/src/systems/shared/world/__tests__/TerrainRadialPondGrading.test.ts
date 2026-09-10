import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { World } from "../../../../core/World";
import { ALL_WORLD_AREAS, type WorldArea } from "../../../../data/world-areas";
import type { FlatZone } from "../../../../types/world/terrain";
import { TerrainSystem } from "../TerrainSystem";

type ManifestArea = WorldArea & { flatZones?: FlatZone[] };
type TerrainInternals = {
  initializeTerrainGenerator(): void;
  loadFlatZonesFromManifest(): void;
  getFlatZoneHeight(x: number, z: number): number | null;
};

const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../../server/world/assets/manifests/world-areas.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, Record<string, ManifestArea>>;
const actualAreas = Object.assign({}, ...Object.values(manifest)) as Record<
  string,
  ManifestArea
>;
const actualPond = Object.values(actualAreas)
  .flatMap((area) => area.flatZones ?? [])
  .find((zone) => zone.radialPond)!;
const originalAreas = Object.entries(ALL_WORLD_AREAS);

function terrainFor(areas?: Record<string, ManifestArea>) {
  for (const key of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[key];
  Object.assign(ALL_WORLD_AREAS, areas);
  // Real world, noise generator, zone registration/index and height resolver.
  // These CPU grading tests neither start a renderer nor replace terrain methods.
  const world = Object.assign(new World(), { config: { terrainSeed: 0 } });
  const terrain = new TerrainSystem(world);
  const internals = terrain as unknown as TerrainInternals;
  internals.initializeTerrainGenerator();
  if (areas) internals.loadFlatZonesFromManifest();
  return { terrain, internals };
}

function grade(overrides: Partial<FlatZone> = {}): FlatZone {
  return {
    id: "underlying_grade",
    centerX: actualPond.centerX,
    centerZ: actualPond.centerZ,
    width: 60,
    depth: 60,
    height: 40,
    blendRadius: 10,
    ...overrides,
  };
}

describe("TerrainSystem radial pond underlying grading", () => {
  afterEach(() => {
    for (const key of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[key];
    Object.assign(ALL_WORLD_AREAS, Object.fromEntries(originalAreas));
  });

  it("joins the actual manifest's surrounding terrain continuously around the entire outer ring", () => {
    const { terrain } = terrainFor(actualAreas);
    const profile = actualPond.radialPond!;
    const radius = profile.bankOuterRadius + actualPond.blendRadius;
    const epsilon = 0.00001;
    let largestBoundaryDifference = 0;
    let largestAuthoredDifference = 0;
    for (let i = 0; i < 64; i++) {
      const angle = (i * Math.PI * 2) / 64;
      const sample = (r: number) =>
        terrain.getHeightAt(
          actualPond.centerX + Math.cos(angle) * r,
          actualPond.centerZ + Math.sin(angle) * r,
        );
      const inside = sample(radius - epsilon);
      const boundary = sample(radius);
      const outside = sample(radius + epsilon);
      expect([inside, boundary, outside].every(Number.isFinite)).toBe(true);
      largestBoundaryDifference = Math.max(
        largestBoundaryDifference,
        Math.abs(inside - boundary),
        Math.abs(outside - boundary),
      );
      largestAuthoredDifference = Math.max(
        largestAuthoredDifference,
        Math.abs(
          boundary -
            terrain.getProceduralHeightAt(
              actualPond.centerX + Math.cos(angle) * radius,
              actualPond.centerZ + Math.sin(angle) * radius,
            ),
        ),
      );
    }
    // The actual ring must exercise authored grading, not just raw fallback.
    expect(largestAuthoredDifference).toBeGreaterThan(0.1);
    expect(largestBoundaryDifference).toBeLessThan(0.001);
  });

  it("preserves bed and bank priority while blending to the winning underlying core, including zero", () => {
    const profile = actualPond.radialPond!;
    for (const height of [0, 40]) {
      for (const reverse of [false, true]) {
        const { terrain } = terrainFor();
        const zones = [actualPond, grade({ height })];
        for (const zone of reverse ? zones.reverse() : zones) {
          terrain.registerFlatZone(zone);
        }
        const sample = (radius: number) =>
          terrain.getHeightAt(actualPond.centerX + radius, actualPond.centerZ);
        expect(sample(0)).toBe(actualPond.height);
        expect(sample(profile.bedRadius)).toBe(actualPond.height);
        expect(sample((profile.bedRadius + profile.bankInnerRadius) / 2)).toBe(
          (actualPond.height + profile.bankHeight) / 2,
        );
        expect(sample(profile.bankInnerRadius)).toBe(profile.bankHeight);
        expect(sample(profile.bankOuterRadius)).toBe(profile.bankHeight);
        expect(
          sample(profile.bankOuterRadius + actualPond.blendRadius / 2),
        ).toBe((profile.bankHeight + height) / 2);
        expect(sample(profile.bankOuterRadius + actualPond.blendRadius)).toBe(
          height,
        );
      }
    }
  });

  it("uses the underlying blend result, and lets a core override it regardless of registration order", () => {
    const profile = actualPond.radialPond!;
    const radius = profile.bankOuterRadius + actualPond.blendRadius / 2;
    const x = actualPond.centerX + radius;
    const z = actualPond.centerZ;
    for (const reverse of [false, true]) {
      const { terrain } = terrainFor();
      const blend = grade({ width: 10 });
      const zones = [actualPond, blend];
      for (const zone of reverse ? zones.reverse() : zones) {
        terrain.registerFlatZone(zone);
      }
      const progress = (radius - blend.width / 2) / blend.blendRadius;
      const weight = progress * progress * (3 - 2 * progress);
      const underlying =
        blend.height +
        (terrain.getProceduralHeightAt(x, z) - blend.height) * weight;
      expect(terrain.getHeightAt(x, z)).toBeCloseTo(
        (profile.bankHeight + underlying) / 2,
        12,
      );
      terrain.registerFlatZone(
        grade({ id: "nearest_core", centerX: x, width: 2, height: 35 }),
      );
      expect(terrain.getHeightAt(x, z)).toBe((profile.bankHeight + 35) / 2);
    }
  });

  it("retains raw procedural fallback when no non-radial zone applies", () => {
    const { terrain, internals } = terrainFor();
    terrain.registerFlatZone(actualPond);
    const profile = actualPond.radialPond!;
    const radius = profile.bankOuterRadius + actualPond.blendRadius / 2;
    const x = actualPond.centerX + radius;
    const z = actualPond.centerZ;
    expect(terrain.getHeightAt(x, z)).toBeCloseTo(
      (profile.bankHeight + terrain.getProceduralHeightAt(x, z)) / 2,
      12,
    );
    expect(
      internals.getFlatZoneHeight(
        actualPond.centerX + profile.bankOuterRadius + actualPond.blendRadius,
        z,
      ),
    ).toBeNull();
  });

  it("retains nearest-pond priority through overlapping indexed zones and repeated queries", () => {
    const second: FlatZone = {
      ...actualPond,
      id: "second_pond",
      centerX: actualPond.centerX + 2,
      height: actualPond.height - 1,
      radialPond: { ...actualPond.radialPond!, bankHeight: 29 },
    };
    for (const reverse of [false, true]) {
      const { terrain } = terrainFor();
      const zones = [actualPond, second, grade()];
      for (const zone of reverse ? zones.reverse() : zones) {
        terrain.registerFlatZone(zone);
      }
      for (let i = 0; i < 4; i++) {
        expect(terrain.getHeightAt(second.centerX, second.centerZ)).toBe(
          second.height,
        );
        expect(
          terrain.getHeightAt(actualPond.centerX, actualPond.centerZ),
        ).toBe(actualPond.height);
        expect(
          terrain.getHeightAt(actualPond.centerX + 20, actualPond.centerZ),
        ).toBe(40);
      }
    }
  });
});
