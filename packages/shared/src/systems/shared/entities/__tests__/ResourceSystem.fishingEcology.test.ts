import { afterEach, describe, expect, it, vi } from "vitest";

import { GATHERING_CONSTANTS } from "../../../../constants/GatheringConstants";
import { CollisionFlag } from "../../movement/CollisionFlags";
import { CollisionMatrix } from "../../movement/CollisionMatrix";
import { worldToTile } from "../../movement/TileSystem";
import { ResourceSystem } from "../ResourceSystem";
import { readFileSync } from "node:fs";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { EntityManager } from "../EntityManager";
import { TerrainSystem } from "../../world/TerrainSystem";
import { getExternalResource } from "../../../../utils/ExternalAssetUtils";
import type {
  WorldArea,
  WorldConfigManifest,
} from "../../../../types/world/world-types";
import type { FlatZone } from "../../../../types/world/terrain";
import type { ElevatedWaterBody } from "../../world/WaterBodyRegistry";
import { createResourceID } from "../../../../utils/IdentifierUtils";
import { findFishingSpotTiles } from "../../../../utils/ShoreUtils";
import { snapToTileCenter } from "../../movement/TileSystem";
import {
  getDuelArenaConfig,
  isPositionInsideDuelArenaZone,
} from "../../../../data/duel-manifest";
import {
  createDuelArenaFloorZones,
  getDuelArenaGradeHeight,
} from "../../../../data/arena-grading";

type FishingResource = {
  id: string;
  type: "fishing_spot";
  name: string;
  position: { x: number; y: number; z: number };
  skillRequired: "fishing";
  isAvailable: boolean;
  drops: [];
};

type FishingEntity = {
  position: {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): void;
  };
  data: { position: [number, number, number] };
  config: { position: { x: number; y: number; z: number } };
  markNetworkDirty: ReturnType<typeof vi.fn>;
};

function createFishingEcologyFixture() {
  const collision = new CollisionMatrix();
  for (let x = 1; x <= 30; x++) {
    for (let z = -15; z <= 15; z++) {
      collision.addFlags(x, z, CollisionFlag.WATER);
    }
  }

  const entities = new Map<string, FishingEntity>();
  const networkSend = vi.fn();
  const world = {
    isServer: true,
    currentTick: 0,
    collision,
    entities,
    network: { send: networkSend },
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getPlayer: vi.fn(),
    getSystem: vi.fn(() => null),
    $eventBus: {
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      subscribeOnce: vi.fn(() => ({ unsubscribe: vi.fn() })),
      emitEvent: vi.fn(),
      request: vi.fn(),
      respond: vi.fn(),
    },
  };
  const system = new ResourceSystem(world as never);
  const resources = new Map<string, FishingResource>();
  const timers = new Map<
    string,
    {
      moveAtTick: number;
      originalPosition: { x: number; y: number; z: number };
    }
  >();
  const terrain = {
    getHeightAt: (x: number, z: number) =>
      x >= 1 && x <= 30 && z >= -15 && z <= 15 ? 0 : 10,
    getWaterBodyRegistry: () => ({ getWaterSurfaceAt: () => 8 }),
  };
  const internals = system as unknown as {
    resources: typeof resources;
    fishingSpotMoveTimers: typeof timers;
    terrainSystem: typeof terrain;
    processFishingSpotMovement: (tick: number) => void;
  };
  internals.resources = resources;
  internals.fishingSpotMoveTimers = timers;
  internals.terrainSystem = terrain;

  const addSpot = (
    id: string,
    x: number,
    z: number,
    moveAtTick: number,
  ): void => {
    const position = { x, y: 8, z };
    resources.set(id, {
      id,
      type: "fishing_spot",
      name: id,
      position: { ...position },
      skillRequired: "fishing",
      isAvailable: true,
      drops: [],
    });
    entities.set(id, {
      position: {
        ...position,
        set(nextX: number, nextY: number, nextZ: number): void {
          this.x = nextX;
          this.y = nextY;
          this.z = nextZ;
        },
      },
      data: { position: [x, 8, z] },
      config: { position: { ...position } },
      markNetworkDirty: vi.fn(),
    });
    timers.set(id, { moveAtTick, originalPosition: { ...position } });
  };

  return {
    world,
    system,
    resources,
    entities,
    timers,
    networkSend,
    internals,
    addSpot,
  };
}

function expectUniqueSpotTiles(resources: Map<string, FishingResource>): void {
  const tiles = [...resources.values()].map(({ position }) =>
    worldToTile(position.x, position.z),
  );
  expect(new Set(tiles.map(({ x, z }) => `${x},${z}`)).size).toBe(tiles.length);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResourceSystem long-run fishing ecology", () => {
  it("keeps three moving spots bounded, distinct, and fully synchronized for ten simulated hours", () => {
    const fixture = createFishingEcologyFixture();
    fixture.addSpot("fish-a", 1.75, -12.5, 200);
    fixture.addSpot("fish-b", 1.75, 0.5, 250);
    fixture.addSpot("fish-c", 29.25, 10.5, 300);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const moveCountBySpot = new Map<string, number>();
    let checkedPackets = 0;
    const tenHoursInTicks = 10 * 60 * 60 * (1000 / 600);
    for (let tick = 0; tick <= tenHoursInTicks; tick++) {
      fixture.world.currentTick = tick;
      fixture.internals.processFishingSpotMovement(tick);
      expectUniqueSpotTiles(fixture.resources);

      const moveCalls = fixture.networkSend.mock.calls.filter(
        ([packet]) => packet === "fishingSpotMoved",
      );
      while (checkedPackets < moveCalls.length) {
        const payload = moveCalls[checkedPackets][1] as {
          resourceId: string;
          oldPosition: { x: number; y: number; z: number };
          newPosition: { x: number; y: number; z: number };
        };
        checkedPackets++;
        const distance = Math.hypot(
          payload.newPosition.x - payload.oldPosition.x,
          payload.newPosition.z - payload.oldPosition.z,
        );
        expect(distance).toBeGreaterThanOrEqual(
          GATHERING_CONSTANTS.FISHING_SPOT_MOVE.relocateMinDistance,
        );
        expect(distance).toBeLessThanOrEqual(
          GATHERING_CONSTANTS.FISHING_SPOT_MOVE.relocateRadius,
        );
        moveCountBySpot.set(
          payload.resourceId,
          (moveCountBySpot.get(payload.resourceId) ?? 0) + 1,
        );

        const resource = fixture.resources.get(payload.resourceId)!;
        const entity = fixture.entities.get(payload.resourceId)!;
        expect(entity.position).toMatchObject(resource.position);
        expect(entity.data.position).toEqual([
          resource.position.x,
          resource.position.y,
          resource.position.z,
        ]);
        expect(entity.config.position).toEqual(resource.position);
        expect(entity.markNetworkDirty).toHaveBeenCalled();
      }
    }

    expect(checkedPackets).toBeGreaterThan(100);
    expect(moveCountBySpot).toEqual(
      new Map([
        ["fish-a", expect.any(Number)],
        ["fish-b", expect.any(Number)],
        ["fish-c", expect.any(Number)],
      ]),
    );
    for (const count of moveCountBySpot.values()) {
      expect(count).toBeGreaterThan(0);
    }
    for (const timer of fixture.timers.values()) {
      expect(timer.moveAtTick).toBeGreaterThan(tenHoursInTicks);
      expect(timer.moveAtTick).toBeLessThanOrEqual(
        tenHoursInTicks +
          GATHERING_CONSTANTS.FISHING_SPOT_MOVE.baseTicks +
          GATHERING_CONSTANTS.FISHING_SPOT_MOVE.varianceTicks,
      );
    }
  });
});

// New opt-in coverage uses actual systems and native Entity.init promises; the
// historical simulation above is retained unchanged, not used as this proof.
class FishingServerWorld extends World {
  override get isServer(): boolean {
    return true;
  }
}
const basin = JSON.parse(
  readFileSync(
    new URL(
      "../../world/__fixtures__/inland-pond-basin-candidate.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  flatZone: FlatZone;
  waterBody: Omit<ElevatedWaterBody, "radiusSq" | "sourceType">;
};
const families = [
  "net",
  "bait",
  "fly",
  "cage",
  "harpoon",
  "monkfish",
  "shark",
].map((kind) => `fishing_spot_${kind}`);
const actualWorlds: World[] = [];
const originals = new Map<string, WorldArea>();
const savedData = {
  config: DataManager["worldConfig"],
  profile: DataManager["worldTerrainProfile"],
  identity: DataManager["worldContentIdentity"],
};
afterEach(() => {
  for (const world of actualWorlds.splice(0)) world.destroy();
  for (const [id, area] of originals) ALL_WORLD_AREAS[id] = area;
  originals.clear();
  DataManager["worldConfig"] = savedData.config;
  DataManager["worldTerrainProfile"] = savedData.profile;
  DataManager["worldContentIdentity"] = savedData.identity;
});
async function actualFixture({
  water = true,
  bake = true,
  manager = true,
  bodyCenter,
}: {
  water?: boolean;
  bake?: boolean;
  manager?: boolean;
  bodyCenter?: { x: number; z: number };
} = {}) {
  await DataManager.getInstance().initialize();
  const pair = Object.entries(ALL_WORLD_AREAS).find(([, area]) =>
    area.flatZones?.some((zone) => zone.id === "haven_pond_floor"),
  )!;
  originals.set(pair[0], pair[1]);
  const actualBasin = structuredClone(basin);
  if (bodyCenter) {
    actualBasin.flatZone.centerX = actualBasin.waterBody.centerX = bodyCenter.x;
    actualBasin.flatZone.centerZ = actualBasin.waterBody.centerZ = bodyCenter.z;
  }
  ALL_WORLD_AREAS[pair[0]] = {
    ...structuredClone(pair[1]),
    flatZones: [
      ...pair[1].flatZones!.filter((zone) => zone.id !== "haven_pond_floor"),
      actualBasin.flatZone,
    ],
    waterBodies: [
      ...(pair[1].waterBodies ?? []).filter(
        (body) => body.id !== "haven_pond_water",
      ),
      actualBasin.waterBody,
    ],
  };
  DataManager["worldContentIdentity"] = null;
  DataManager.setWorldConfig(
    structuredClone(savedData.config!) as WorldConfigManifest,
  );
  const world = new FishingServerWorld();
  actualWorlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  await terrain.init();
  if (water) terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  if (bake) {
    terrain["generateTile"](4, 4, false);
    // No transport in this real CPU World; invoke the same server bake owner
    // after generating the retained tile, not a fake collision/readiness flag.
    terrain["bakeWalkabilityFlags"](4, 4);
  }
  const entities = manager
    ? (world.register("entity-manager", EntityManager) as EntityManager)
    : null;
  const system = world.register("resource", ResourceSystem) as ResourceSystem;
  await system.init();
  const area: WorldArea = {
    ...structuredClone(pair[1]),
    id: "candidate_pond_fishing",
    resources: [],
    bounds: { minX: 383, maxX: 437, minZ: 388, maxZ: 442 },
    fishing: {
      enabled: true,
      spotCount: 14,
      spotTypes: [...families],
      waterBodyId: basin.waterBody.id,
    },
  };
  return { world, terrain, system, entities, area };
}
function assertRealCoverage(f: Awaited<ReturnType<typeof actualFixture>>) {
  const counts = new Map<string, number>();
  const resources = [...f.system["resources"].values()];
  const floors = createDuelArenaFloorZones(
    getDuelArenaConfig(),
    getDuelArenaGradeHeight(),
  );
  expect(resources).toHaveLength(14);
  const tiles = new Set<string>();
  const outputs = new Set<string>();
  for (const resource of resources) {
    const variant = f.system["resourceVariants"].get(
      createResourceID(resource.id),
    )!;
    expect(resource.toolRequired).toBe(
      getExternalResource(variant)!.toolRequired,
    );
    counts.set(variant, (counts.get(variant) ?? 0) + 1);
    for (const drop of resource.drops) outputs.add(drop.itemId);
    const tile = worldToTile(resource.position.x, resource.position.z);
    tiles.add(`${tile.x},${tile.z}`);
    expect(
      f.world.collision.hasFlags(tile.x, tile.z, CollisionFlag.WATER),
    ).toBe(true);
    expect(
      f.terrain.getResourceGroundHeight(
        resource.position.x,
        resource.position.z,
      ),
    ).toBeLessThan(basin.waterBody.surfaceY);
    expect(resource.position.y).toBe(basin.waterBody.surfaceY);
    expect(f.world.entities.get(resource.id)).toBeInstanceOf(ResourceEntity);
    for (const floor of floors)
      expect(
        Math.abs(resource.position.x - floor.centerX) > floor.width / 2 + 1 ||
          Math.abs(resource.position.z - floor.centerZ) > floor.depth / 2 + 1,
      ).toBe(true);
  }
  expect(tiles.size).toBe(14);
  expect(counts).toEqual(new Map(families.map((id) => [id, 2])));
  expect(outputs.size).toBe(12);
  return resources;
}
describe("body-bound fishing coverage with actual terrain and resource ownership", () => {
  it("admits all seven families/twelve fish exactly twice, reserving pending registration and preserving repeated calls", async () => {
    const f = await actualFixture();
    const protectedCampus = { x: 397.5, y: basin.waterBody.surfaceY, z: 409.5 };
    expect(
      isPositionInsideDuelArenaZone(protectedCampus.x, protectedCampus.z),
    ).toBe(true);
    expect(
      f.system["createResourceFromSpawnPoint"](
        { type: "tree", subType: "oak", position: protectedCampus },
        true,
      ),
    ).toBeUndefined();
    const body = f.terrain
      .getWaterBodyRegistry()
      .getAllBodies()
      .find((b) => b.id === basin.waterBody.id)!;
    const sampled = findFishingSpotTiles(
      f.world.collision,
      f.area.bounds,
      f.terrain.getResourceGroundHeight.bind(f.terrain),
      f.terrain
        .getWaterBodyRegistry()
        .getWaterSurfaceAt.bind(f.terrain.getWaterBodyRegistry()),
      GATHERING_CONSTANTS.FISHING_SPOT_MOVE.shoreMinSpacing,
    ).map(snapToTileCenter);
    console.info(
      "bound-pond-capacity",
      JSON.stringify({
        discovered: sampled.length,
        admitted: sampled.filter((p) =>
          f.system["isBoundFishingPoint"](p, { body, bounds: f.area.bounds }),
        ).length,
      }),
    );
    const first = f.system["spawnDynamicFishingSpots"](f.area.id, f.area);
    const second = f.system["spawnDynamicFishingSpots"](f.area.id, f.area);
    expect(second).toBe(first);
    expect(f.system["terrainResourceRegistrations"].size).toBe(14);
    await Promise.all([first, second]);
    const resources = assertRealCoverage(f);
    expect(
      resources.some((r) =>
        isPositionInsideDuelArenaZone(r.position.x, r.position.z),
      ),
    ).toBe(true);
    // Consume an actual typed production spawn descriptor, not a cast around
    // TerrainResourceSpawnPoint's historical tree/ore-only subtype union.
    const registeredCampusFish = [
      ...f.system["terrainResourceRegistrations"].values(),
    ].find(({ registration }) =>
      isPositionInsideDuelArenaZone(
        registration.resource.position.x,
        registration.resource.position.z,
      ),
    )!;
    const unbound = f.world.register(
      "legacy-resource-probe",
      ResourceSystem,
    ) as ResourceSystem;
    expect(
      unbound["createResourceFromSpawnPoint"](
        registeredCampusFish.registration.spawnPoint,
        true,
      ),
    ).toBeUndefined();
    const reachable = new Set<string>();
    const queue = [{ x: 386, z: 425 }];
    expect(f.world.collision.isWalkable(386, 425)).toBe(true);
    reachable.add("386,425");
    for (let index = 0; index < queue.length; index++) {
      const from = queue[index];
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const next = { x: from.x + dx, z: from.z + dz },
          key = `${next.x},${next.z}`;
        if (
          next.x < 378 ||
          next.x > 443 ||
          next.z < 383 ||
          next.z > 447 ||
          reachable.has(key) ||
          !f.world.collision.isWalkable(next.x, next.z) ||
          f.world.collision.isBlocked(from.x, from.z, next.x, next.z)
        )
          continue;
        reachable.add(key);
        queue.push(next);
      }
    }
    for (const resource of resources)
      expect(
        queue.some(
          (tile) =>
            Math.hypot(
              tile.x + 0.5 - resource.position.x,
              tile.z + 0.5 - resource.position.z,
            ) <= GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE,
        ),
      ).toBe(true);
    await f.system["spawnDynamicFishingSpots"](f.area.id, f.area);
    expect([...f.system["resources"].values()]).toEqual(resources);
    expect(f.system.getResourceEcologyStats().pendingFishingAreas).toBe(0);
    console.info(
      "bound-pond-fishing-coverage",
      JSON.stringify(
        resources.map((r) => ({
          id: r.id,
          family: f.system["resourceVariants"].get(createResourceID(r.id)),
          position: r.position,
        })),
      ),
    );
  });

  it("defers before actual terrain bake and when complete family allocation is impossible, then retries without partial publication", async () => {
    const f = await actualFixture({ bake: false });
    await f.system["spawnDynamicFishingSpots"](f.area.id, f.area);
    expect(f.system["resources"].size).toBe(0);
    expect(f.system["pendingFishingAreas"].size).toBe(1);
    f.terrain["generateTile"](4, 4, false);
    f.terrain["bakeWalkabilityFlags"](4, 4);
    f.area.fishing!.spotCount = 63;
    await f.system["spawnDynamicFishingSpots"](f.area.id, f.area);
    expect(f.system["resources"].size).toBe(0);
    expect(f.system["terrainResourceRegistrations"].size).toBe(0);
    f.area.fishing!.spotCount = 14;
    await f.system["spawnDynamicFishingSpots"](f.area.id, f.area);
    assertRealCoverage(f);
  });

  it("rolls back a real asynchronous registration failure and retries after installing the actual EntityManager", async () => {
    const f = await actualFixture({ manager: false });
    await expect(
      f.system["spawnDynamicFishingSpots"](f.area.id, f.area),
    ).rejects.toThrow("EntityManager not available");
    expect(f.system["terrainResourceRegistrations"].size).toBe(0);
    expect(f.system["boundFishingResources"].size).toBe(0);
    expect(f.system["boundFishingSpawns"].size).toBe(0);
    expect(f.system["pendingFishingAreas"].size).toBe(1);
    f.world.register("entity-manager", EntityManager);
    await f.system["spawnDynamicFishingSpots"](f.area.id, f.area);
    assertRealCoverage(f);
  });

  it("reserves real unfinished registrations across overlapping areas and refuses changed settled bindings", async () => {
    const f = await actualFixture();
    const first = f.system["spawnDynamicFishingSpots"](f.area.id, f.area);
    const other = {
      ...f.area,
      id: "other_bound_area",
      fishing: { ...f.area.fishing!, spotCount: 7 },
    };
    const second = f.system["spawnDynamicFishingSpots"](other.id, other);
    expect(f.system["terrainResourceRegistrations"].size).toBe(21);
    await Promise.all([first, second]);
    expect(f.system["resources"].size).toBe(21);
    expect(
      new Set(
        [...f.system["resources"].values()].map(
          (r) => `${Math.floor(r.position.x)},${Math.floor(r.position.z)}`,
        ),
      ).size,
    ).toBe(21);
    expect(() =>
      f.system["spawnDynamicFishingSpots"](f.area.id, {
        ...f.area,
        fishing: { ...f.area.fishing!, spotCount: 7 },
      }),
    ).toThrow("changes require restart");
  });

  it.each(["duel_arena_floor_1", "duel_lobby_floor", "duel_hospital_floor"])(
    "never admits an explicit pond target over actual %s infrastructure",
    async (id) => {
      const floor = createDuelArenaFloorZones(
        getDuelArenaConfig(),
        getDuelArenaGradeHeight(),
      ).find((entry) => entry.id === id)!;
      expect(floor).toBeDefined();
      const f = await actualFixture({
        bodyCenter: { x: floor.centerX, z: floor.centerZ },
      });
      const body = f.terrain
        .getWaterBodyRegistry()
        .getAllBodies()
        .find((entry) => entry.id === basin.waterBody.id)!;
      f.area.bounds = {
        minX: floor.centerX - 1,
        maxX: floor.centerX + 1,
        minZ: floor.centerZ - 1,
        maxZ: floor.centerZ + 1,
      };
      f.area.fishing!.spotCount = 1;
      f.area.fishing!.spotTypes = [families[0]];
      expect(
        f.system["isBoundFishingPoint"](
          { x: floor.centerX + 0.5, z: floor.centerZ + 0.5 },
          { body, bounds: f.area.bounds },
        ),
      ).toBe(false);
      await f.system["spawnDynamicFishingSpots"](f.area.id, f.area);
      expect(f.system["resources"].size).toBe(0);
      expect(f.system["terrainResourceRegistrations"].size).toBe(0);
    },
  );

  it("rejects missing explicit ownership and invalid families before allocation", async () => {
    const f = await actualFixture({ water: false });
    expect(() =>
      f.system["spawnDynamicFishingSpots"](f.area.id, f.area),
    ).toThrow("exact explicit water owner");
    f.terrain["loadWaterBodiesFromManifest"]();
    for (const types of [[families[0], families[0]], ["tree_normal"], []]) {
      f.area.fishing!.spotTypes = types;
      expect(() =>
        f.system["spawnDynamicFishingSpots"](f.area.id, f.area),
      ).toThrow("Invalid bound fishing coverage");
    }
    expect(f.system["terrainResourceRegistrations"].size).toBe(0);
  });

  it("keeps actual moving entities inside the same wet basin and never resurrects a destroyed pending registration", async () => {
    const f = await actualFixture();
    await f.system["spawnDynamicFishingSpots"](f.area.id, f.area);
    for (let wave = 0; wave < 10; wave++) {
      for (const id of f.system["resources"].keys())
        f.system["relocateFishingSpot"](id, wave * 400);
      assertRealCoverage(f);
    }
    f.system.destroy();
    expect(f.entities!.getAllEntities().size).toBe(0);
    const next = f.world.register(
      "resource_pending",
      ResourceSystem,
    ) as ResourceSystem;
    await next.init();
    const pending = next["spawnDynamicFishingSpots"](f.area.id, f.area);
    next.destroy();
    await pending;
    expect(f.entities!.getAllEntities().size).toBe(0);
    expect(next["boundFishingSpawns"].size).toBe(0);
    expect(next["boundFishingResources"].size).toBe(0);
  });
});
