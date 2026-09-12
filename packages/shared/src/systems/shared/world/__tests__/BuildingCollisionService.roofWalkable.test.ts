import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { createEntityID } from "../../../../types/core/identifiers";
import type { BuildingLayoutInput } from "../../../../types/world/building-collision-types";
import { resolvePlayerSupportHeight } from "../../../../utils/movement/PlayerSupport";
import { BuildingCollisionService } from "../BuildingCollisionService";

const worlds: World[] = [];
const position = { x: 398, y: 28.83930152309769, z: 370 };
const buildingId = "roof-policy-test";

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.destroy();
});

function layout(floors = 1): BuildingLayoutInput {
  return {
    width: 2,
    depth: 2,
    floors,
    floorPlans: Array.from({ length: floors }, () => ({
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
    })),
    stairs:
      floors > 1
        ? { col: 0, row: 0, direction: "north", landing: { col: 0, row: 1 } }
        : null,
  };
}

function fixture(input = layout()) {
  const world = new World();
  worlds.push(world);
  const service = new BuildingCollisionService(world);
  service.registerBuilding(buildingId, "cpu-test", input, { ...position }, 0);
  return { world, service, building: service.getBuilding(buildingId)! };
}

function groundFlags(world: World) {
  const flags: number[] = [];
  for (let x = 392; x <= 404; x++) {
    for (let z = 364; z <= 378; z++) flags.push(world.collision.getFlags(x, z));
  }
  return flags;
}

describe("explicit non-walkable roof with actual World and collision owners", () => {
  it("preserves the complete default roof, floors and ground flags for omitted versus true", () => {
    const ordinary = fixture(layout(2));
    const explicit = fixture({ ...layout(2), roofWalkable: true });
    expect(explicit.building).toEqual(ordinary.building);
    expect(groundFlags(explicit.world)).toEqual(groundFlags(ordinary.world));
    const roof = ordinary.service.getFloor(buildingId, 2)!;
    expect(roof.floorIndex).toBe(2);
    expect(roof.walkableTiles.size).toBe(64);
    expect(roof.wallSegments.length).toBeGreaterThan(0);
    for (const key of roof.walkableTiles) {
      const [x, z] = key.split(",").map(Number);
      expect(ordinary.service.isWalkableAtFloor(x, z, 2)).toBe(true);
      expect(ordinary.service.getFloorElevation(x, z, 2)).toBe(roof.elevation);
    }
  });

  it("omits the lodge's entire roof floor and edges without changing interior, entrance or ground collision", () => {
    const ordinary = fixture();
    const lodge = fixture({ ...layout(), roofWalkable: false });
    expect(lodge.building.floors).toEqual(ordinary.building.floors.slice(0, 1));
    expect(lodge.building.stepTiles).toEqual(ordinary.building.stepTiles);
    expect(lodge.building.groundCoverageTiles).toEqual(
      ordinary.building.groundCoverageTiles,
    );
    expect(lodge.building.boundingBox).toEqual(ordinary.building.boundingBox);
    expect(groundFlags(lodge.world)).toEqual(groundFlags(ordinary.world));
    expect(groundFlags(lodge.world).some((flags) => flags !== 0)).toBe(true);
    expect(lodge.service.getFloor(buildingId, 1)).toBeUndefined();
    expect(
      BuildingCollisionService.getFloorFromData(lodge.building, 1),
    ).toBeUndefined();
    expect(lodge.service.getDebugBuildingInfo()[0].floorCount).toBe(1);
    expect(
      lodge.service.getDebugBuildingInfo()[0].floors.map((f) => f.floorIndex),
    ).toEqual([0]);
    for (const key of lodge.building.floors[0].walkableTiles) {
      const [x, z] = key.split(",").map(Number);
      expect(lodge.service.queryCollision(x, z, 0)).toEqual(
        ordinary.service.queryCollision(x, z, 0),
      );
      expect(lodge.service.isTileWalkableInBuilding(x, z, 1)).toBe(false);
      expect(lodge.service.isWalkableAtFloor(x, z, 1)).toBe(false);
      expect(lodge.service.getFloorElevation(x, z, 1)).toBeNull();
      expect(lodge.service.getDoorOpeningsAtTile(x, z, 1)).toEqual([]);
      expect(lodge.service.queryCollision(x, z, 1)).toMatchObject({
        isInsideBuilding: true,
        buildingId,
        floorIndex: 1,
        isWalkable: false,
        elevation: null,
        wallBlocking: { north: false, south: false, east: false, west: false },
        stairTile: null,
      });
      expect(
        resolvePlayerSupportHeight(x + 0.5, z + 0.5, null, lodge.service, 0),
      ).toBe(lodge.building.floors[0].elevation);
    }
    for (const step of lodge.building.stepTiles) {
      expect(
        lodge.service.getStepHeightAtWorld(step.tileX + 0.5, step.tileZ + 0.5),
      ).toBe(
        ordinary.service.getStepHeightAtWorld(
          step.tileX + 0.5,
          step.tileZ + 0.5,
        ),
      );
    }
    const playerId = createEntityID("roof-policy-player");
    const oldRoofY = ordinary.service.getFloor(buildingId, 1)!.elevation;
    ordinary.service.updatePlayerBuildingState(playerId, 398, 370, oldRoofY);
    lodge.service.updatePlayerBuildingState(playerId, 398, 370, oldRoofY);
    expect(ordinary.service.getPlayerBuildingState(playerId).currentFloor).toBe(
      1,
    );
    expect(lodge.service.getPlayerBuildingState(playerId).currentFloor).toBe(0);
    expect(lodge.service.blockFloorTile(buildingId, 1, 398, 370)).toBe(false);
    // Missing support is not permission to walk: the navigation queries above
    // reject the absent roof while the separate support helper keeps its fallback.
    expect(lodge.service.isWalkableAtFloor(390, 370, 1)).toBe(true);
  });

  it("preserves both interior floors and actual stair destinations/elevations when only the roof is disabled", () => {
    const ordinary = fixture(layout(2));
    const noRoof = fixture({ ...layout(2), roofWalkable: false });
    expect(noRoof.building.floors).toEqual(
      ordinary.building.floors.slice(0, 2),
    );
    expect(noRoof.service.getFloor(buildingId, 2)).toBeUndefined();
    for (const floor of noRoof.building.floors) {
      expect(floor.stairTiles.length).toBeGreaterThan(0);
      for (const stair of floor.stairTiles) {
        const { tileX: x, tileZ: z } = stair;
        expect(
          noRoof.service.getStairDestination(x, z, floor.floorIndex),
        ).toEqual(ordinary.service.getStairDestination(x, z, floor.floorIndex));
        expect(
          noRoof.service.getStairDestination(x, z, floor.floorIndex),
        ).not.toBeNull();
        expect(
          noRoof.service.getStairLandingTile(x, z, floor.floorIndex),
        ).toEqual(ordinary.service.getStairLandingTile(x, z, floor.floorIndex));
        for (const fraction of [0.1, 0.5, 0.9]) {
          expect(
            noRoof.service.getStairElevation(
              x + fraction,
              z + fraction,
              floor.floorIndex,
            ),
          ).toBe(
            ordinary.service.getStairElevation(
              x + fraction,
              z + fraction,
              floor.floorIndex,
            ),
          );
          expect(
            resolvePlayerSupportHeight(
              x + fraction,
              z + fraction,
              null,
              noRoof.service,
              floor.floorIndex,
            ),
          ).toBe(
            resolvePlayerSupportHeight(
              x + fraction,
              z + fraction,
              null,
              ordinary.service,
              floor.floorIndex,
            ),
          );
        }
      }
    }
  });

  it("keeps explicit absent-roof policy local to the registered owner and retires it on unregister/clear", () => {
    const { service } = fixture({ ...layout(), roofWalkable: false });
    expect(service.isWalkableAtFloor(398, 370, 1)).toBe(false);
    service.unregisterBuilding(buildingId);
    expect(service.getBuildingAtTile(398, 370)).toBeNull();
    expect(service.isWalkableAtFloor(398, 370, 1)).toBe(true);
    service.registerBuilding(
      buildingId,
      "cpu-test",
      layout(),
      { ...position },
      0,
    );
    expect(service.getFloor(buildingId, 1)).toBeDefined();
    expect(service.isWalkableAtFloor(398, 370, 1)).toBe(true);
    service.clear();
    service.registerBuilding(
      buildingId,
      "cpu-test",
      { ...layout(), roofWalkable: false },
      { ...position },
      0,
    );
    expect(service.getFloor(buildingId, 1)).toBeUndefined();
    expect(service.isWalkableAtFloor(398, 370, 1)).toBe(false);
  });

  it("does not turn exterior concavities or unrelated missing levels into roof exclusions", () => {
    const input = layout();
    input.floorPlans[0].footprint[0][1] = false;
    const ordinary = fixture(input);
    const noRoof = fixture({ ...input, roofWalkable: false });
    expect(noRoof.building.boundingBox).toEqual(ordinary.building.boundingBox);
    expect(noRoof.service.isWalkableAtFloor(394, 366, 1)).toBe(false);
    expect(noRoof.service.queryCollision(399, 367, 1)).toEqual(
      ordinary.service.queryCollision(399, 367, 1),
    );
    expect(noRoof.service.queryCollision(399, 367, 1).isInsideBuilding).toBe(
      false,
    );
    expect(noRoof.service.isWalkableAtFloor(399, 367, 1)).toBe(true);
    expect(noRoof.service.queryCollision(394, 366, 8)).toEqual(
      ordinary.service.queryCollision(394, 366, 8),
    );
  });

  it("lets queryCollision find an overlapping real floor before applying an omitted-roof fallback", () => {
    const { service } = fixture({ ...layout(), roofWalkable: false });
    service.registerBuilding(
      "overlapping-floor",
      "cpu-test",
      layout(2),
      { ...position },
      0,
    );
    const actualFloor = service.getFloor("overlapping-floor", 1)!;
    expect(service.queryCollision(398, 370, 1)).toMatchObject({
      buildingId: "overlapping-floor",
      isWalkable: true,
      floorIndex: 1,
      elevation: actualFloor.elevation,
    });
    // This exercises query precedence only, not approval for overlapping
    // building placement or the separate first-owner movement policy.
  });

  it("rejects malformed explicit options before registration or collision writes", () => {
    const { service, world, building } = fixture();
    const flags = groundFlags(world);
    for (const value of [null, "false", 0, 1, {}, []]) {
      const bad = Object.assign(layout(), { roofWalkable: value });
      expect(() =>
        service.registerBuilding(
          "invalid",
          "cpu-test",
          bad,
          { ...position },
          0,
        ),
      ).toThrow("invalid roofWalkable");
      expect(service.getBuilding("invalid")).toBeUndefined();
      expect(service.getBuildingCount()).toBe(1);
      expect(service.getBuilding(buildingId)).toBe(building);
      expect(groundFlags(world)).toEqual(flags);
    }
  });
});
