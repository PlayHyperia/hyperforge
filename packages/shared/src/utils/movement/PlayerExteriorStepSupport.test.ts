import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../core/World";
import { TerrainSystem } from "../../systems/shared/world/TerrainSystem";
import { BuildingCollisionService } from "../../systems/shared/world/BuildingCollisionService";
import type { BuildingLayoutInput } from "../../types/world/building-collision-types";
import { getDuelArenaSolidSurfaceHeight } from "../../data/arena-grading";
import {
  resolveExteriorStepSupportHeight,
  resolvePlayerRootHeight,
  resolvePlayerSupportHeight,
} from "./PlayerSupport";

const worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.destroy();
});

async function fixture(baseOffset = 0) {
  const world = new World();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  const buildings = new BuildingCollisionService(world);
  // The measured 8m candidate's actual two-cell south entrance, without any
  // scene/asset registration. A floor plan is input to the real collision owner.
  const floor = () => ({
    footprint: [
      [true, true],
      [true, true],
    ],
    roomMap: [
      [0, 0],
      [0, 0],
    ],
    internalOpenings: new Map<string, string>(),
    externalOpenings: new Map([["0,1,south", "door"]]),
  });
  const layout: BuildingLayoutInput = {
    width: 2,
    depth: 2,
    floors: 2,
    floorPlans: [floor(), floor()],
    stairs: null,
  };
  const ground = terrain.getHeightAt(360, 318);
  buildings.registerBuilding(
    "exterior-support",
    "cpu-test",
    layout,
    { x: 360, y: ground + baseOffset, z: 318 },
    0,
  );
  return { world, terrain, buildings, ground };
}

describe("exposed exterior step support with actual terrain and collision owners", () => {
  it("keeps the measured shallow and deep buried rows above unchanged plaza terrain", async () => {
    const { terrain, buildings, ground } = await fixture();
    const rows = [
      [322.5, 0.225],
      [323.5, -0.39375],
      [324.5, -0.9],
    ] as const;
    for (const [z, rawOffset] of rows) {
      const x = 357.5;
      expect(buildings.getBuildingAt(Math.floor(x), Math.floor(z))).toBeNull();
      const raw = buildings.getStepHeightAtWorld(x, z)!;
      expect(raw - ground).toBeCloseTo(rawOffset, 12);
      expect(terrain.getHeightAt(x, z)).toBe(ground);
      const expected = ground + Math.max(rawOffset, 0);
      expect(resolvePlayerSupportHeight(x, z, terrain, buildings)).toBeCloseTo(
        expected,
        12,
      );
      expect(resolvePlayerRootHeight(x, z, terrain, buildings)).toBeCloseTo(
        expected + 0.01,
        12,
      );
      // The geometry/ramp API remains raw; this repair only chooses exposed support.
      expect(buildings.getStepHeight(Math.floor(x), Math.floor(z))).toBe(raw);
    }
  });

  it("retains negative local steps exposed above lower surrounding terrain, including sub-tile interpolation", async () => {
    const { terrain, buildings, ground } = await fixture(2);
    for (const z of [323.25, 323.5, 323.75, 324.25, 324.5, 324.75]) {
      const x = 357.5,
        raw = buildings.getStepHeightAtWorld(x, z)!;
      expect(raw).toBeLessThan(ground + 2);
      expect(raw).toBeGreaterThan(terrain.getHeightAt(x, z));
      expect(resolvePlayerRootHeight(x, z, terrain, buildings)).toBe(
        raw + 0.01,
      );
    }
  });

  it("does not raise actual interior ground/upper floors even when they lie below exterior terrain", async () => {
    const { terrain, buildings, ground } = await fixture(-6);
    for (const floorIndex of [0, 1]) {
      const floor = buildings.getFloor("exterior-support", floorIndex)!;
      expect(floor.elevation).toBeLessThan(ground);
      expect(
        resolvePlayerRootHeight(357.5, 320.5, terrain, buildings, floorIndex),
      ).toBe(floor.elevation + 0.01);
      expect(
        resolvePlayerRootHeight(357.5, 320.5, null, buildings, floorIndex),
      ).toBe(floor.elevation + 0.01);
    }
    // Negative floor admission was unsupported before this exterior-only fix.
    expect(
      resolvePlayerRootHeight(357.5, 320.5, terrain, buildings, -1),
    ).toBeNull();
  });

  it("fails closed on missing/nonfinite outdoor support and uses an actual known platform without a terrain substitute", async () => {
    const { terrain, buildings } = await fixture();
    const raw = buildings.getStepHeightAtWorld(357.5, 324.5)!;
    expect(
      resolveExteriorStepSupportHeight(357.5, 324.5, raw, null),
    ).toBeNull();
    expect(
      resolveExteriorStepSupportHeight(357.5, 324.5, raw, undefined),
    ).toBeNull();
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(
        resolveExteriorStepSupportHeight(357.5, 324.5, bad, terrain),
      ).toBeNull();
      expect(
        resolveExteriorStepSupportHeight(bad, 324.5, raw, terrain),
      ).toBeNull();
    }
    expect(
      resolveExteriorStepSupportHeight(357.5, 324.5, null, terrain),
    ).toBeNull();
    // Fault-inject actual mutable terrain data AFTER valid registration, not a
    // fake getHeightAt implementation. This is not a claim of valid admission.
    const zone = {
      id: "nonfinite-support-fault",
      centerX: 800,
      centerZ: 800,
      width: 4,
      depth: 4,
      height: 10,
      blendRadius: 0,
    };
    terrain.registerFlatZone(zone);
    zone.height = NaN;
    expect(Number.isFinite(terrain.getHeightAt(800, 800))).toBe(false);
    expect(resolveExteriorStepSupportHeight(800, 800, 9, terrain)).toBeNull();
    const solid = getDuelArenaSolidSurfaceHeight(385, 374)!;
    expect(solid).not.toBeNull();
    expect(resolveExteriorStepSupportHeight(385, 374, solid - 0.2, null)).toBe(
      solid,
    );
    expect(resolveExteriorStepSupportHeight(385, 374, solid + 0.2, null)).toBe(
      solid + 0.2,
    );
  });
});
