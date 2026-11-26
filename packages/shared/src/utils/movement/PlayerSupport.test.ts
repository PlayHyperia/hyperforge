import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../core/World";
import { TerrainSystem } from "../../systems/shared/world/TerrainSystem";
import { BuildingCollisionService } from "../../systems/shared/world/BuildingCollisionService";
import type { BuildingLayoutInput } from "../../types/world/building-collision-types";
import { getDuelArenaConfig } from "../../data/duel-manifest";
import {
  createDuelArenaFloorZones,
  getDuelArenaGradeHeight,
  DUEL_ARENA_FLOOR_SOLID_OFFSET,
  getDuelArenaSolidSurfaceHeight,
} from "../../data/arena-grading";
import {
  resolvePlayerRootHeight,
  resolvePlayerSupportHeight,
  PLAYER_ROOT_CLEARANCE,
} from "./PlayerSupport";

const worlds: World[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});
async function fixture(withStairs = false) {
  const world = new World();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  await terrain.init();
  const authored = terrain as unknown as {
    loadWaterBodiesFromManifest(): void;
    loadFlatZonesFromManifest(): void;
  };
  authored.loadWaterBodiesFromManifest();
  authored.loadFlatZonesFromManifest();
  const buildings = new BuildingCollisionService(world);
  const floor = (footprint: boolean[][]) => ({
    footprint,
    roomMap: footprint.map((row) => row.map(() => 0)),
    internalOpenings: new Map<string, string>(),
    externalOpenings: new Map([["0,0,north", "door"]]),
  });
  const layout: BuildingLayoutInput = {
    width: 2,
    depth: 2,
    floors: 2,
    floorPlans: [
      floor([
        [true, true],
        [true, false],
      ]),
      floor([
        [true, false],
        [true, false],
      ]),
    ],
    stairs: withStairs
      ? { col: 0, row: 0, direction: "north", landing: { col: 0, row: 1 } }
      : null,
  };
  buildings.registerBuilding(
    "support-building",
    "test-town",
    layout,
    { x: 300, y: 35, z: 320 },
    0,
  );
  return { world, terrain, buildings };
}

describe("real player support surfaces, separate from terrain grade", () => {
  it("resolves all three actual platform interiors and boundaries to solid top without raising their terrain", async () => {
    const { terrain } = await fixture();
    const base = getDuelArenaGradeHeight();
    const floors = createDuelArenaFloorZones(getDuelArenaConfig(), base);
    expect(floors).toHaveLength(3);
    for (const floor of floors) {
      for (const [dx, dz] of [
        [0, 0],
        [floor.width / 2, 0],
        [-floor.width / 2, 0],
        [0, floor.depth / 2],
        [0, -floor.depth / 2],
      ]) {
        const x = floor.centerX + dx,
          z = floor.centerZ + dz;
        expect(terrain.getHeightAt(x, z)).toBe(floor.height);
        expect(resolvePlayerSupportHeight(x, z, terrain)).toBeCloseTo(
          base + DUEL_ARENA_FLOOR_SOLID_OFFSET,
          12,
        );
        expect(resolvePlayerRootHeight(x, z, terrain)).toBeCloseTo(
          base + DUEL_ARENA_FLOOR_SOLID_OFFSET + PLAYER_ROOT_CLEARANCE,
          12,
        );
      }
      const x = floor.centerX + floor.width / 2 + 1e-5;
      expect(getDuelArenaSolidSurfaceHeight(x, floor.centerZ)).toBeNull();
      expect(resolvePlayerSupportHeight(x, floor.centerZ, terrain)).toBe(
        terrain.getHeightAt(x, floor.centerZ),
      );
    }
  });

  it("uses integer-owned actual ground/upper floors and never promotes a missing floor or exterior concavity", async () => {
    const { terrain, buildings } = await fixture();
    const building = buildings.getBuilding("support-building")!;
    const upper = building.floors[1];
    const [key] = upper.walkableTiles;
    const [tileX, tileZ] = key.split(",").map(Number);
    expect(buildings.getBuildingAt(tileX + 0.5, tileZ + 0.5)).toBeNull();
    expect(buildings.getBuildingAt(tileX, tileZ)).toBe(building.buildingId);
    for (const floorIndex of [0, 1]) {
      expect(
        resolvePlayerSupportHeight(
          tileX + 0.5,
          tileZ + 0.5,
          terrain,
          buildings,
          floorIndex,
        ),
      ).toBe(building.floors[floorIndex].elevation);
      expect(
        resolvePlayerRootHeight(
          tileX + 0.5,
          tileZ + 0.5,
          terrain,
          buildings,
          floorIndex,
        ),
      ).toBe(building.floors[floorIndex].elevation + PLAYER_ROOT_CLEARANCE);
    }
    const lowerOnly = [...building.floors[0].walkableTiles].find(
      (tile) => !upper.walkableTiles.has(tile),
    )!;
    const [holeX, holeZ] = lowerOnly.split(",").map(Number);
    // The service exposes the floor's elevation even over this missing tile;
    // the support resolver must also require that floor's actual footprint.
    expect(buildings.getFloorElevation(holeX, holeZ, 1)).toBe(upper.elevation);
    expect(buildings.isTileWalkableInBuilding(holeX, holeZ, 1)).toBe(false);
    expect(
      resolvePlayerSupportHeight(
        holeX + 0.5,
        holeZ + 0.5,
        terrain,
        buildings,
        1,
      ),
    ).toBe(terrain.getHeightAt(holeX + 0.5, holeZ + 0.5));
    expect(
      resolvePlayerSupportHeight(
        tileX + 0.5,
        tileZ + 0.5,
        terrain,
        buildings,
        8,
      ),
    ).toBe(terrain.getHeightAt(tileX + 0.5, tileZ + 0.5));
    const outside = { x: 302.5, z: 322.5 };
    expect(buildings.isNearBuildingForElevation(outside.x, outside.z)).toBe(
      true,
    );
    expect(buildings.getBuildingAt(302, 322)).toBeNull();
    expect(
      resolvePlayerSupportHeight(outside.x, outside.z, terrain, buildings),
    ).toBe(terrain.getHeightAt(outside.x, outside.z));
  });

  it("retains physical upper-floor support when actual furniture blocks navigation", async () => {
    const { terrain, buildings } = await fixture();
    const upper = buildings.getFloor("support-building", 1)!;
    const [key] = upper.walkableTiles;
    const [tileX, tileZ] = key.split(",").map(Number);
    expect(buildings.blockFloorTile("support-building", 1, tileX, tileZ)).toBe(
      true,
    );
    expect(upper.walkableTiles.has(key)).toBe(true);
    expect(buildings.isTileWalkableInBuilding(tileX, tileZ, 1)).toBe(false);
    expect(
      resolvePlayerSupportHeight(
        tileX + 0.5,
        tileZ + 0.5,
        terrain,
        buildings,
        1,
      ),
    ).toBe(upper.elevation);
    expect(
      resolvePlayerRootHeight(tileX + 0.5, tileZ + 0.5, terrain, buildings, 1),
    ).toBe(upper.elevation + PLAYER_ROOT_CLEARANCE);
    expect(
      buildings.unblockFloorTile("support-building", 1, tileX, tileZ),
    ).toBe(true);
    expect(
      resolvePlayerSupportHeight(
        tileX + 0.5,
        tileZ + 0.5,
        terrain,
        buildings,
        1,
      ),
    ).toBe(upper.elevation);
  });

  it("uses actual entrance-step geometry at sub-tile positions only for ground-level players", async () => {
    const { terrain, buildings } = await fixture();
    const steps = buildings.getBuilding("support-building")!.stepTiles;
    expect(steps.length).toBeGreaterThan(0);
    let samples = 0;
    for (const step of steps)
      for (const dx of [0.25, 0.5, 0.75]) {
        const x = step.tileX + dx,
          z = step.tileZ + 0.5;
        if (buildings.getBuildingAt(Math.floor(x), Math.floor(z)) !== null)
          continue;
        const expected = buildings.getStepHeightAtWorld(x, z);
        expect(expected).not.toBeNull();
        expect(resolvePlayerSupportHeight(x, z, terrain, buildings, 0)).toBe(
          expected,
        );
        expect(resolvePlayerRootHeight(x, z, terrain, buildings, 0)).toBe(
          expected! + PLAYER_ROOT_CLEARANCE,
        );
        expect(resolvePlayerSupportHeight(x, z, terrain, buildings, 1)).toBe(
          terrain.getHeightAt(x, z),
        );
        samples++;
      }
    expect(samples).toBeGreaterThan(0);
  });

  it("follows actual interior stair and landing support on the requested floor with clearance applied once", async () => {
    const { terrain, buildings } = await fixture(true);
    const building = buildings.getBuilding("support-building")!;
    let samples = 0;
    const sampledHeights = new Set<number>();
    for (const floorIndex of [0, 1]) {
      const floor = buildings.getFloor("support-building", floorIndex)!;
      expect(floor.stairTiles.length).toBeGreaterThan(0);
      for (const stair of floor.stairTiles)
        for (const fraction of [0.25, 0.5, 0.75]) {
          const x = stair.tileX + 0.5,
            z = stair.tileZ + fraction;
          const support = buildings.getStairElevation(x, z, floor.floorIndex);
          expect(support).not.toBeNull();
          expect(support!).toBeGreaterThan(building.floors[0].elevation);
          expect(support!).toBeLessThan(building.floors[1].elevation);
          sampledHeights.add(support!);
          expect(
            resolvePlayerSupportHeight(
              x,
              z,
              terrain,
              buildings,
              floor.floorIndex,
            ),
          ).toBe(support);
          expect(
            resolvePlayerRootHeight(x, z, terrain, buildings, floor.floorIndex),
          ).toBe(support! + PLAYER_ROOT_CLEARANCE);
          samples++;
        }
    }
    expect(samples).toBeGreaterThan(6);
    expect(sampledHeights.size).toBe(3);
  });

  it("retains real terrain fallback and returns no manufactured support for invalid inputs", async () => {
    const { terrain, buildings } = await fixture();
    expect(resolvePlayerRootHeight(350, 320, terrain)).toBe(
      terrain.getHeightAt(350, 320) + PLAYER_ROOT_CLEARANCE,
    );
    expect(resolvePlayerRootHeight(NaN, 320, terrain)).toBeNull();
    expect(resolvePlayerRootHeight(350, Infinity, terrain)).toBeNull();
    expect(resolvePlayerRootHeight(350, 320, null)).toBeNull();
    expect(
      resolvePlayerRootHeight(350, 320, terrain, buildings, -1),
    ).toBeNull();
    expect(
      resolvePlayerRootHeight(350, 320, terrain, buildings, 0.5),
    ).toBeNull();
  });
});
