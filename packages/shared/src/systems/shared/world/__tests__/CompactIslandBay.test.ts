import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { getDuelArenaConfig } from "../../../../data/duel-manifest";
import { NoiseGenerator } from "../../../../utils/NoiseGenerator";
import { CollisionFlag } from "../../movement/CollisionFlags";
import { createCompactIslandLandform } from "../CompactIslandLandform";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import { createCompactIslandPaths } from "../CompactIslandPaths";
import { TerrainSystem } from "../TerrainSystem";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as candidate,
  SCULPTED_COMPACT_V2_PROFILE_FIXTURE as previous,
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE as noBay,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";

const landform = createCompactIslandLandform();
const noise = new NoiseGenerator(candidate.seed);
const shape = candidate.landform!;
const c = Math.cos(shape.inletBearing),
  s = Math.sin(shape.inletBearing);
function point(along: number, across: number) {
  return { x: 350 + along * c - across * s, z: 400 + along * s + across * c };
}
function mask(profile: WorldTerrainProfile, along: number, across: number) {
  const p = point(along, across);
  return landform.mask(p.x, p.z, noise, profile);
}
function smooth(t: number) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
const worlds: World[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});
type TerrainInternals = {
  activeTerrainProfile: WorldTerrainProfile | null;
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  bakeWalkabilityFlags(x: number, z: number): void;
};
async function fixture(profile: WorldTerrainProfile) {
  const world = new World();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const internal = terrain as unknown as TerrainInternals;
  terrain.getWorldTerrainProfile();
  // Isolated historical sampler fixture: the real system captures this admitted
  // profile before init. No DataManager/global manifest, methods or physics are
  // replaced; all non-shape config fields are identical (asserted below).
  internal.activeTerrainProfile = profile;
  await terrain.init();
  internal.loadWaterBodiesFromManifest();
  internal.loadFlatZonesFromManifest();
  return { world, terrain, internal };
}

describe("versioned tapered coastal bay", () => {
  it("binds exactly four finite bay fields to the new identity and retains the old algorithm", () => {
    expect(DataManager.getWorldTerrainProfile()).toEqual(candidate);
    expect(candidate.id).toBe("compact-duel-island-v4");
    expect(candidate.algorithm).toBe("compact-island-sculpt-v3");
    expect(previous.id).toBe("compact-duel-island-v3");
    expect(previous.algorithm).toBe("compact-island-sculpt-v2");
    expect(previous.bay).toBeUndefined();
    expect(candidate.bay).toEqual({
      innerHalfWidth: 24,
      centerlineBend: 8,
      leftBankScale: 0.95,
      rightBankScale: 1.1,
    });
    expect(Object.isFrozen(candidate.bay)).toBe(true);
    const { id: id4, algorithm: algorithm4, bay, ...stable4 } = candidate;
    const { id: id3, algorithm: algorithm3, ...stable3 } = previous;
    expect(stable4).toEqual(stable3);
    expect([id4, algorithm4]).not.toEqual([id3, algorithm3]);
    const identity = worldTerrainProfileIdentity(candidate);
    expect(identity).not.toBe(worldTerrainProfileIdentity(previous));
    for (const key of Object.keys(bay!) as Array<
      keyof NonNullable<typeof bay>
    >) {
      expect(
        worldTerrainProfileIdentity(
          validateWorldTerrainProfile({
            ...candidate,
            bay: { ...bay, [key]: bay![key] + 0.01 },
          }),
        ),
      ).not.toBe(identity);
    }
    for (const invalid of [
      { ...candidate, bay: undefined },
      { ...previous, bay },
      { ...candidate, id: id3 },
      { ...previous, id: id4 },
      ...[
        { innerHalfWidth: NaN },
        { innerHalfWidth: 15 },
        { innerHalfWidth: 50 },
        { centerlineBend: 19 },
        { leftBankScale: 0 },
        { rightBankScale: 2 },
        { unexpected: 1 },
      ].map((patch) => ({ ...candidate, bay: { ...bay, ...patch } })),
    ])
      expect(() => validateWorldTerrainProfile(invalid)).toThrow(
        /WorldTerrainProfile/,
      );
    // Independent old rectangular formula: neither a relabeled identity nor a
    // blanket family dispatch may silently apply the new shape to old fixtures.
    for (let along = 80; along <= 140; along += 2)
      for (let across = -42; across <= 42; across += 3) {
        const oldBite =
          smooth((along - 84) / 26) * smooth((42 - Math.abs(across)) / 18);
        expect(mask(previous, along, across)).toBeCloseTo(
          mask(noBay, along, across) * (1 - oldBite),
          12,
        );
      }
  });

  it("rounds the inner head, widens toward sea and bends without symmetric bank falloff", () => {
    function section(along: number) {
      const selected: number[] = [];
      for (let i = -420; i <= 420; i++) {
        const across = i / 10;
        const coast = mask(noBay, along, across);
        if (coast > 1e-6 && 1 - mask(candidate, along, across) / coast > 0.001)
          selected.push(across);
      }
      expect(selected.length).toBeGreaterThan(0);
      return {
        width: selected.at(-1)! - selected[0],
        center: (selected.at(-1)! + selected[0]) / 2,
      };
    }
    const sections = [86, 100, 110, 135].map(section);
    expect(sections[0].width).toBeLessThan(20);
    for (let i = 1; i < sections.length; i++)
      expect(sections[i].width).toBeGreaterThan(sections[i - 1].width + 2);
    expect(sections[2].center).toBeGreaterThan(7);
    expect(sections[3].center).toBeLessThan(sections[2].center - 1);
    // Equal offsets from the inner centerline have unequal earth-bank ramps.
    const left = 1 - mask(candidate, 110, 8 - 18) / mask(noBay, 110, 8 - 18);
    const right = 1 - mask(candidate, 110, 8 + 18) / mask(noBay, 110, 8 + 18);
    expect(Math.abs(left - right)).toBeGreaterThan(0.02);
    expect(mask(candidate, 83.999, 8)).toBe(mask(noBay, 83.999, 8));
  });

  it("changes only the existing refined inlet envelope and keeps finite continuous joins", () => {
    const regions = createCompactPreparationDetailRegions(
      candidate,
      ALL_WORLD_AREAS,
      64,
    );
    expect(regions).toEqual(
      createCompactPreparationDetailRegions(previous, ALL_WORLD_AREAS, 64),
    );
    const envelope = regions[3];
    let changed = 0;
    for (let x = 150; x <= 550; x += 2)
      for (let z = 200; z <= 600; z += 2) {
        const before = landform.height(x, z, noise, previous);
        const after = landform.height(x, z, noise, candidate);
        expect(Number.isFinite(after)).toBe(true);
        if (before === after) continue;
        changed++;
        expect(x).toBeGreaterThanOrEqual(envelope.minX);
        expect(x).toBeLessThanOrEqual(envelope.maxX);
        expect(z).toBeGreaterThanOrEqual(envelope.minZ);
        expect(z).toBeLessThanOrEqual(envelope.maxZ);
      }
    expect(changed).toBeGreaterThan(100);
    const epsilon = 1e-4;
    for (const along of [84, 110, 165 * 1.12])
      for (let across = -42; across <= 42; across += 2) {
        const a = point(along - epsilon, across),
          b = point(along, across),
          d = point(along + epsilon, across);
        const h0 = landform.height(a.x, a.z, noise, candidate),
          h1 = landform.height(b.x, b.z, noise, candidate),
          h2 = landform.height(d.x, d.z, noise, candidate);
        expect(Math.abs(h2 - h0)).toBeLessThan(0.002);
        expect(
          Math.abs((h1 - h0) / epsilon - (h2 - h1) / epsilon),
        ).toBeLessThan(0.002);
      }
  });

  it("preserves real authored grades, all five authored trees, and every path point", async () => {
    const current = await fixture(candidate),
      old = await fixture(previous);
    const sameHeight = (x: number, z: number) =>
      expect(current.terrain.getResourceGroundHeight(x, z)).toBe(
        old.terrain.getResourceGroundHeight(x, z),
      );
    let trees = 0,
      gradedSamples = 0;
    for (const area of Object.values(ALL_WORLD_AREAS)) {
      for (let x = area.bounds.minX; x <= area.bounds.maxX; x += 2)
        for (let z = area.bounds.minZ; z <= area.bounds.maxZ; z += 2) {
          sameHeight(x, z);
          gradedSamples++;
        }
      for (const entry of [
        ...(area.resources ?? []),
        ...(area.npcs ?? []),
        ...(area.stations ?? []),
      ]) {
        sameHeight(entry.position.x, entry.position.z);
        if ("resourceId" in entry && entry.resourceId.startsWith("tree_")) {
          trees++;
          sameHeight(
            Math.floor(entry.position.x) + 0.5,
            Math.floor(entry.position.z) + 0.5,
          );
        }
      }
    }
    expect(trees).toBe(5);
    expect(gradedSamples).toBeGreaterThan(1000);
    expect(
      createCompactIslandPaths(
        candidate,
        ALL_WORLD_AREAS,
        getDuelArenaConfig(),
        current.terrain.getResourceGroundHeight.bind(current.terrain),
      ),
    ).toEqual(
      createCompactIslandPaths(
        previous,
        ALL_WORLD_AREAS,
        getDuelArenaConfig(),
        old.terrain.getResourceGroundHeight.bind(old.terrain),
      ),
    );
    expect(
      current.terrain.getWaterBodyRegistry().getWaterSurfaceAt(343, 302),
    ).toBe(old.terrain.getWaterBodyRegistry().getWaterSurfaceAt(343, 302));
    expect(DataManager.getWorldTerrainProfile()).toEqual(candidate);
  });

  it("uses the actual changed surface for ocean classification and baked movement-water flags", async () => {
    const { world, terrain, internal } = await fixture(candidate);
    internal.bakeWalkabilityFlags(4, 5);
    internal.bakeWalkabilityFlags(5, 5);
    let wet = 0,
      dry = 0;
    for (let along = 105; along <= 145; along += 5)
      for (let across = -40; across <= 40; across += 4) {
        const p = point(along, across);
        const x = Math.floor(p.x) + 0.5,
          z = Math.floor(p.z) + 0.5;
        const height = terrain.getResourceGroundHeight(x, z);
        const info = terrain.getTerrainInfoAt(x, z);
        expect(info.height).toBe(height);
        expect(info.underwater).toBe(height < candidate.water.threshold);
        if (height < candidate.water.threshold - 3) {
          wet++;
          expect(info.walkable).toBe(false);
          expect(
            world.collision.hasFlags(
              Math.floor(x),
              Math.floor(z),
              CollisionFlag.WATER,
            ),
          ).toBe(true);
        } else if (height > candidate.water.threshold + 5) {
          dry++;
          expect(
            world.collision.hasFlags(
              Math.floor(x),
              Math.floor(z),
              CollisionFlag.WATER,
            ),
          ).toBe(false);
        }
      }
    expect(wet).toBeGreaterThan(30);
    expect(dry).toBeGreaterThan(30);
    // This proves production CPU water/navigation classification only, not a
    // live PhysX body, GPU water mesh, avatar contact or art acceptance.
  });
});
