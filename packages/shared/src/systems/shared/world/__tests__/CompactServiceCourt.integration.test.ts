import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  createOpenWorkshop,
  OPEN_WORKSHOP_POSTS,
} from "@hyperforge/procgen/building";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import type {
  WorldArea,
  WorldConfigManifest,
} from "../../../../types/world/world-types";
import { PlayerEntity } from "../../../../entities/player/PlayerEntity";
import { NPCEntity } from "../../../../entities/npc/NPCEntity";
import { BankEntity } from "../../../../entities/world/BankEntity";
import { MobNPCSpawnerSystem } from "../../entities/MobNPCSpawnerSystem";
import { TownSystem } from "../TownSystem";
import { validatePhysicalBankAccess } from "../../../../../../server/src/shared/PhysicalBankAccess";
import { ArenaPoolManager } from "../../../../../../server/src/systems/DuelSystem/ArenaPoolManager";
import {
  getDuelArenaConfig,
  isPositionInsideCombatArena,
} from "../../../../data/duel-manifest";
import {
  getDuelArenaEgressPosition,
  getDuelArenaLobbyReturnPosition,
} from "../../../../data/arena-grading";
import { stationDataProvider } from "../../../../data/StationDataProvider";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { Box3, Vector3 } from "../../../../extras/three/three";
import { loadPhysX } from "../../../../physics/PhysXManager";
import { ResourceSystem } from "../../entities/ResourceSystem";
import { EntityManager } from "../../entities/EntityManager";
import {
  StationSpawnerSystem,
  STATION_GROUND_CLEARANCE,
} from "../../entities/StationSpawnerSystem";
import { BFSPathfinder } from "../../movement/BFSPathfinder";
import {
  worldToTile,
  getCardinalAdjacentTiles,
  type TileCoord,
} from "../../movement/TileSystem";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import {
  COMPACT_SERVICE_COURT,
  groundCompactServiceCourt,
  createCompactServicePlanting,
  createCompactServiceSoil,
  validateCompactServicePlanting,
} from "../CompactServiceCourt";
import { COMPACT_POND_MODELS } from "../CompactPondDressing";
import {
  CompactServiceCourtSystem,
  COMPACT_SERVICE_COURT_SYSTEM,
} from "../CompactServiceCourtSystem";
import {
  createCompactIslandPaths,
  compactPathIntersectsBounds,
  COMPACT_PATH_BLEND_WIDTH,
} from "../CompactIslandPaths";
import { modelBounds } from "./fixtures/StaticGlbBounds";
import {
  COMPACT_LANDSCAPE_ROCKS_SYSTEM,
  CompactLandscapeRocksSystem,
} from "../CompactLandscapeRocksSystem";

class CpuServerWorld extends World {
  override get isServer() {
    return true;
  }
}
const saved = {
  config: DataManager["worldConfig"],
  profile: DataManager["worldTerrainProfile"],
  identity: DataManager["worldContentIdentity"],
  areas: { ...ALL_WORLD_AREAS },
};
const worlds: World[] = [];
beforeAll(async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await loadPhysX();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
  DataManager["worldConfig"] = saved.config;
  DataManager["worldTerrainProfile"] = saved.profile;
  DataManager["worldContentIdentity"] = saved.identity;
  for (const key of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[key];
  Object.assign(ALL_WORLD_AREAS, saved.areas);
});
async function fixture() {
  DataManager["worldContentIdentity"] = null;
  DataManager.setWorldConfig({
    ...structuredClone(saved.config!),
    compactServiceCourt: structuredClone(COMPACT_SERVICE_COURT),
  });
  const world = new CpuServerWorld();
  worlds.push(world);
  await world.physics.init();
  const manager = world.register(
    "entity-manager",
    EntityManager,
  ) as EntityManager;
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  const resources = world.register(
    "resource",
    ResourceSystem,
  ) as ResourceSystem;
  const stations = world.register(
    "station-spawner",
    StationSpawnerSystem,
  ) as StationSpawnerSystem;
  const owner = world.register(
    COMPACT_SERVICE_COURT_SYSTEM,
    CompactServiceCourtSystem,
  ) as CompactServiceCourtSystem;
  await terrain.init();
  await roads.init();
  await resources.init();
  await owner.init();
  await roads.start();
  await terrain.start();
  const internal = resources as unknown as {
    terrainResourceTails: Map<string, Promise<void>>;
    initializeWorldAreaResources(): Promise<void>;
  };
  await Promise.all([...internal.terrainResourceTails.values()]);
  await internal.initializeWorldAreaResources();
  await Promise.all([...internal.terrainResourceTails.values()]);
  await stations.start();
  return { world, manager, terrain, roads, resources, owner };
}

function expectCurrentPathWear(
  paths: ReturnType<typeof createCompactIslandPaths>,
) {
  expect(paths).toHaveLength(14);
  const profiles = [
    [1.1, 0.85],
    [1.1, 0.85],
    [0.9, 0.8],
    [0.9, 0.8],
    [1.4, 0.9],
    [1.4, 0.9],
    [1.8, 1.6],
    [1.1, 1.45],
    [0.9, 1.3],
    [1.2, 1.65],
    [0.9, 1.3],
  ];
  const previousWidths = [1.8, 1.8, 1.5, 1.5, 2.2, 2.2, 4, 3, 2.5, 3.5, 2.5];
  for (const [index, path] of paths.slice(0, 11).entries()) {
    expect(path.id.startsWith("compact-wear-")).toBe(false);
    expect([path.width, path.blendWidth]).toEqual(profiles[index]);
    expect(path.width / 2 + path.blendWidth!).toBe(
      previousWidths[index] / 2 + 0.5,
    );
    expect(Object.prototype.hasOwnProperty.call(path, "maxInfluence")).toBe(
      false,
    );
  }
  expect(
    paths.slice(11).map(({ id, width, blendWidth, maxInfluence }) => ({
      id,
      width,
      blendWidth,
      maxInfluence,
    })),
  ).toEqual([
    {
      id: "compact-wear-workshop-south",
      width: 0.65,
      blendWidth: 1.5,
      maxInfluence: 0.6,
    },
    {
      id: "compact-wear-workshop-west",
      width: 0.7,
      blendWidth: 1.25,
      maxInfluence: 0.55,
    },
    {
      id: "compact-wear-supplier-north",
      width: 0.45,
      blendWidth: 1.4,
      maxInfluence: 0.5,
    },
  ]);
}

describe("actual compact service court placement and preparation navigation", () => {
  it("admits detached bounded planting only for its court and rejects malformed content", () => {
    const input = structuredClone(saved.config!.compactServicePlanting!);
    expect(input.beds.flatMap((b) => b.plants)).toHaveLength(24);
    const profile = saved.profile!;
    const admitted = validateCompactServicePlanting(
      input,
      profile,
      COMPACT_SERVICE_COURT,
    )!;
    expect(admitted).toEqual(input);
    expect(admitted).not.toBe(input);
    expect(Object.isFrozen(admitted.beds[0].plants[0])).toBe(true);
    expect(Object.isFrozen(admitted.beds[0].soilLobes)).toBe(true);
    expect(Object.isFrozen(admitted.beds[0].soilLobes![0])).toBe(true);
    expect(createCompactServiceSoil(admitted)).toHaveLength(4);
    expect(createCompactServiceSoil(undefined)).toEqual([]);
    expect(createCompactServicePlanting(undefined)).toEqual([]);
    expect(
      validateCompactServicePlanting(undefined, profile, undefined),
    ).toBeUndefined();
    const plant = input.beds[0].plants[0];
    for (const bad of [
      null,
      {},
      { ...input, extra: true },
      { ...input, schemaVersion: 3 },
      { ...input, schemaVersion: 1 },
      { ...input, beds: [input.beds[0], input.beds[0]] },
      {
        ...input,
        get beds() {
          throw new Error("getter must not run");
        },
      },
      ...[
        { ...plant, x: 336 },
        { ...plant, scale: 2 },
        { ...plant, yaw: NaN },
        { ...plant, model: "tree" },
      ].map((p) => ({
        ...input,
        beds: [{ ...input.beds[0], plants: [p] }, input.beds[1]],
      })),
      ...[
        undefined,
        [],
        [input.beds[0].soilLobes![0]],
        [
          { ...input.beds[0].soilLobes![0], centerX: 336 },
          input.beds[0].soilLobes![1],
        ],
        [
          { ...input.beds[0].soilLobes![0], radiusX: 0 },
          input.beds[0].soilLobes![1],
        ],
        [
          { ...input.beds[0].soilLobes![0], extra: 1 },
          input.beds[0].soilLobes![1],
        ],
      ].map((soilLobes) => ({
        ...input,
        beds: [{ ...input.beds[0], soilLobes }, input.beds[1]],
      })),
      {
        ...input,
        beds: input.beds.map((b) => ({
          ...b,
          plants: Array.from({ length: 13 }, () => b.plants[0]),
        })),
      },
    ])
      expect(() =>
        validateCompactServicePlanting(bad, profile, COMPACT_SERVICE_COURT),
      ).toThrow();
    expect(() =>
      validateCompactServicePlanting(input, profile, undefined),
    ).toThrow();
    // Historical v1 remains explicitly bush-only, with no implicit soil field.
    const historical = {
      ...input,
      schemaVersion: 1,
      layoutId: "compact-smithy-planting-v1",
      beds: input.beds.map((bed) => ({
        id: bed.id,
        plants: bed.plants
          .filter((p) => p.model === "bush")
          .map(({ x, z, scale, yaw }) => ({ x, z, scale, yaw })),
      })),
    };
    const old = validateCompactServicePlanting(
      historical,
      profile,
      COMPACT_SERVICE_COURT,
    )!;
    expect(createCompactServiceSoil(old)).toEqual([]);
    expect(createCompactServicePlanting(old)).toEqual(
      createCompactServicePlanting(admitted).filter((p) => p.model === "bush"),
    );
    expect(() =>
      validateCompactServicePlanting(
        input,
        { ...profile, id: "unqualified" },
        COMPACT_SERVICE_COURT,
      ),
    ).toThrow();
  });

  it("keeps complete shrub crowns clear of paths, station workspaces, NPCs and every tree harvest approach", async () => {
    const { terrain, roads, resources, manager } = await fixture();
    const plants = createCompactServicePlanting(
      DataManager.getWorldConfig()!.compactServicePlanting,
    );
    expect(plants).toHaveLength(24);
    expect(new Set(plants.map((p) => p.id)).size).toBe(24);
    expect(plants.filter((p) => p.model === "fern")).toHaveLength(4);
    const paths = createCompactIslandPaths(
      terrain.getWorldTerrainProfile(),
      ALL_WORLD_AREAS,
      getDuelArenaConfig(),
      terrain.getResourceGroundHeight.bind(terrain),
    );
    expectCurrentPathWear(paths);
    const maskBounds = (
      roads as unknown as {
        calculateRoadMaskBounds(
          s: ReturnType<RoadNetworkSystem["getRoadSegmentsForGPU"]>,
        ): { worldSize: number; centerX: number; centerZ: number };
      }
    ).calculateRoadMaskBounds(roads.getRoadSegmentsForGPU());
    const mask = roads.generateRoadInfluenceTexture(
      256,
      maskBounds.worldSize,
      0.5,
      maskBounds.centerX,
      maskBounds.centerZ,
    )!;
    const pixel = maskBounds.worldSize / 256;
    const support: {
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
    }[] = [];
    for (let iz = 0; iz < 256; iz++)
      for (let ix = 0; ix < 256; ix++) {
        if (!mask.data[iz * 256 + ix]) continue;
        const x = ix * pixel - maskBounds.worldSize / 2 + maskBounds.centerX;
        const z = iz * pixel - maskBounds.worldSize / 2 + maskBounds.centerZ;
        support.push({
          minX: x - pixel / 2,
          maxX: x + 1.5 * pixel,
          minZ: z - pixel / 2,
          maxZ: z + 1.5 * pixel,
        });
      }
    const trees = resources.getAllResources().filter((r) => r.type === "tree");
    expect(trees).toHaveLength(48);
    const stations = Object.values(ALL_WORLD_AREAS).flatMap(
      (a) => a.stations ?? [],
    );
    const npcs = Object.values(ALL_WORLD_AREAS).flatMap((a) => a.npcs ?? []);
    for (const p of plants) {
      const radius = COMPACT_POND_MODELS[p.model].radius * p.scale;
      const crown = {
        minX: p.x - radius,
        maxX: p.x + radius,
        minZ: p.z - radius,
        maxZ: p.z + radius,
      };
      for (const path of paths)
        for (let i = 1; i < path.path.length; i++)
          expect
            .soft(
              compactPathIntersectsBounds(
                path.path[i - 1],
                path.path[i],
                crown,
                path.width / 2 + (path.blendWidth ?? COMPACT_PATH_BLEND_WIDTH),
              ),
              `${p.id} analytical ${path.id}: ${JSON.stringify({ crown, start: path.path[i - 1], end: path.path[i], clearance: path.width / 2 + (path.blendWidth ?? COMPACT_PATH_BLEND_WIDTH) })}`,
            )
            .toBe(false);
      expect
        .soft(
          support.some(
            (s) =>
              s.maxX > crown.minX &&
              s.minX < crown.maxX &&
              s.maxZ > crown.minZ &&
              s.minZ < crown.maxZ,
          ),
          `${p.id} actual bilinear road mask`,
        )
        .toBe(false);
      for (const post of OPEN_WORKSHOP_POSTS)
        expect(
          Math.hypot(
            p.x - COMPACT_SERVICE_COURT.position.x - post.x,
            p.z - COMPACT_SERVICE_COURT.position.z - post.z,
          ) - radius,
          `${p.id} post`,
        ).toBeGreaterThan(0.45);
      for (const npc of npcs)
        expect(
          Math.hypot(p.x - npc.position.x, p.z - npc.position.z) - radius,
          `${p.id} ${npc.id}`,
        ).toBeGreaterThan(1.25);
      for (const station of stations) {
        const def = stationDataProvider.getStationData(station.type)!;
        const bounds = modelBounds(def.model!, def.modelScale).box;
        const dx = Math.max(
          bounds.min.x + station.position.x - p.x,
          0,
          p.x - bounds.max.x - station.position.x,
        );
        const dz = Math.max(
          bounds.min.z + station.position.z - p.z,
          0,
          p.z - bounds.max.z - station.position.z,
        );
        expect(
          Math.hypot(dx, dz) - radius,
          `${p.id} ${station.id} complete model and working space`,
        ).toBeGreaterThan(1.25);
      }
      for (const tree of trees) {
        expect(manager.getEntity(tree.id)).toBeInstanceOf(ResourceEntity);
        for (const tile of getCardinalAdjacentTiles(
          worldToTile(tree.position.x, tree.position.z),
          1,
          1,
        ))
          expect(
            Math.hypot(p.x - tile.x - 0.5, p.z - tile.z - 0.5) - radius,
            `${p.id} ${tree.id} harvest capsule`,
          ).toBeGreaterThan(0.8);
      }
      const samples = [-radius, 0, radius].flatMap((dx) =>
        [-radius, 0, radius].map((dz) =>
          terrain["getHeightAtComputed"](p.x + dx, p.z + dz),
        ),
      );
      expect(samples.every(Number.isFinite)).toBe(true);
      expect(
        Math.max(...samples) - Math.min(...samples),
        `${p.id} planted support slope`,
      ).toBeLessThan(0.25);
    }
  }, 60000);

  it("preserves every currently free service/harvest approach and traverses zero-road terrain from the authoritative return marks", async () => {
    const { world, roads, resources, owner } = await fixture();
    const trees = resources.getAllResources().filter((r) => r.type === "tree");
    expect(trees).toHaveLength(48);
    const subjects = [
      ...trees.map((t) => ({ id: t.id, position: t.position })),
      ...Object.values(ALL_WORLD_AREAS)
        .flatMap((a) => a.stations ?? [])
        .map((s) => ({ id: s.id, position: s.position })),
      ...Object.values(ALL_WORLD_AREAS)
        .flatMap((a) => a.npcs ?? [])
        .map((n) => ({ id: n.id, position: n.position })),
    ];
    const walkable = (p: TileCoord, from?: TileCoord) =>
      p.x >= 250 &&
      p.x < 550 &&
      p.z >= 250 &&
      p.z < 550 &&
      !isPositionInsideCombatArena(p.x + 0.5, p.z + 0.5) &&
      world.collision.isWalkable(p.x, p.z) &&
      (!from || !world.collision.isBlocked(from.x, from.z, p.x, p.z));
    const approaches = subjects.map((s) => ({
      id: s.id,
      tiles: getCardinalAdjacentTiles(
        worldToTile(s.position.x, s.position.z),
        1,
        1,
      ).filter((t) => walkable(t)),
    }));
    for (const row of approaches) {
      const subject = subjects.find((s) => s.id === row.id)!;
      expect(
        row.tiles.length,
        JSON.stringify({
          id: row.id,
          position: subject.position,
          flags: getCardinalAdjacentTiles(
            worldToTile(subject.position.x, subject.position.z),
            1,
            1,
          ).map((t) => ({ ...t, flags: world.collision.getFlags(t.x, t.z) })),
        }),
      ).toBeGreaterThan(0);
    }
    const starts = [
      getDuelArenaLobbyReturnPosition(true),
      getDuelArenaLobbyReturnPosition(false),
      getDuelArenaEgressPosition(),
    ].map((p) => worldToTile(p.x, p.z));
    const bfs = new BFSPathfinder();
    const route = (start: TileCoord, target: TileCoord, label: string) => {
      let cursor = start;
      const seen = new Set<string>();
      let previousOffRoad =
        roads.getRoadInfluenceAt(start.x + 0.5, start.z + 0.5) === 0;
      let offRoadRun = 0,
        longestOffRoadRun = 0;
      for (
        let part = 0;
        part < 12 && (cursor.x !== target.x || cursor.z !== target.z);
        part++
      ) {
        const segment = bfs.findPath(cursor, target, walkable);
        expect(segment.length, label).toBeGreaterThan(0);
        for (const tile of segment) {
          expect(walkable(tile, cursor), label).toBe(true);
          if (tile.x !== cursor.x || tile.z !== cursor.z) {
            const offRoad =
              roads.getRoadInfluenceAt(tile.x + 0.5, tile.z + 0.5) === 0;
            offRoadRun = previousOffRoad && offRoad ? offRoadRun + 1 : 0;
            longestOffRoadRun = Math.max(longestOffRoadRun, offRoadRun);
            previousOffRoad = offRoad;
          }
          cursor = tile;
        }
        const key = `${cursor.x},${cursor.z}`;
        expect(seen.has(key), label).toBe(false);
        seen.add(key);
      }
      expect(cursor, label).toEqual(target);
      return longestOffRoadRun;
    };
    // The baseline must actually complete; an unreachable preexisting approach
    // is not silently deleted to make the candidate pass.
    let beforeOffRoadRun = 0;
    for (const start of starts)
      for (const row of approaches)
        for (const target of row.tiles)
          beforeOffRoadRun = Math.max(
            beforeOffRoadRun,
            route(
              start,
              target,
              `before ${row.id} ${start.x},${start.z} -> ${target.x},${target.z}`,
            ),
          );
    // Consecutive actual BFS edges whose BOTH endpoint centers have exactly zero
    // road influence. Existing collision/directional checks still qualify every
    // step; this is off-road navigation evidence, not an island-wide census.
    expect(beforeOffRoadRun).toBeGreaterThanOrEqual(8);
    await owner.start();
    const landscape = world.register(
      COMPACT_LANDSCAPE_ROCKS_SYSTEM,
      CompactLandscapeRocksSystem,
    ) as CompactLandscapeRocksSystem;
    await landscape.init();
    await landscape.start();
    expect(landscape.getRocks()?.placements).toHaveLength(17);
    let afterOffRoadRun = 0;
    for (const start of starts)
      for (const row of approaches)
        for (const target of row.tiles) {
          expect(walkable(target), row.id).toBe(true);
          afterOffRoadRun = Math.max(
            afterOffRoadRun,
            route(
              start,
              target,
              `after ${row.id} ${start.x},${start.z} -> ${target.x},${target.z}`,
            ),
          );
        }
    expect(afterOffRoadRun).toBeGreaterThanOrEqual(8);
  }, 60000);

  it("clears actual tree/station envelopes and all analytical plus bilinear-mask path support", async () => {
    const { manager, terrain, roads, resources } = await fixture();
    const record = groundCompactServiceCourt(
      COMPACT_SERVICE_COURT,
      OPEN_WORKSHOP_POSTS,
      (x, z) => terrain.getHeightAt(x, z),
    );
    const geometry = createOpenWorkshop(record.feet, {
      architecturalFinish: "haven-v1",
    });
    try {
      const envelope = new Box3();
      for (const g of [geometry.timber, geometry.roof, geometry.footings])
        envelope.union(g.boundingBox!);
      envelope.translate(
        new Vector3(record.position.x, record.position.y, record.position.z),
      );
      const trees = resources
        .getAllResources()
        .filter((r) => r.type === "tree");
      expect(trees).toHaveLength(48);
      for (const tree of trees) {
        const entity = manager.getEntity(tree.id);
        if (!(entity instanceof ResourceEntity))
          throw new Error(`Actual resource missing ${tree.id}`);
        const variants = entity.config.modelVariants;
        const hash =
          (entity as unknown as { hashString(s: string): number }).hashString(
            tree.id,
          ) >>> 0;
        const model = variants?.length
          ? variants[hash % variants.length]
          : entity.config.model;
        if (!model) throw new Error(`Actual model absent ${tree.id}`);
        const bounds = modelBounds(model, entity.config.modelScale);
        const distance = Math.hypot(
          Math.max(
            envelope.min.x - tree.position.x,
            0,
            tree.position.x - envelope.max.x,
          ),
          Math.max(
            envelope.min.z - tree.position.z,
            0,
            tree.position.z - envelope.max.z,
          ),
        );
        expect(
          distance - bounds.radius,
          `${tree.id} complete model / roof margin`,
        ).toBeGreaterThan(0.4);
      }
      const paths = createCompactIslandPaths(
        terrain.getWorldTerrainProfile(),
        ALL_WORLD_AREAS,
        getDuelArenaConfig(),
        terrain.getResourceGroundHeight.bind(terrain),
      );
      expectCurrentPathWear(paths);
      const posts = OPEN_WORKSHOP_POSTS.map((p) => ({
        minX: record.position.x + p.x - 0.15,
        maxX: record.position.x + p.x + 0.15,
        minZ: record.position.z + p.z - 0.15,
        maxZ: record.position.z + p.z + 0.15,
      }));
      const maskBounds = (
        roads as unknown as {
          calculateRoadMaskBounds(
            s: ReturnType<RoadNetworkSystem["getRoadSegmentsForGPU"]>,
          ): { worldSize: number; centerX: number; centerZ: number };
        }
      ).calculateRoadMaskBounds(roads.getRoadSegmentsForGPU());
      const mask = roads.generateRoadInfluenceTexture(
        256,
        maskBounds.worldSize,
        0.5,
        maskBounds.centerX,
        maskBounds.centerZ,
      )!;
      const pixel = maskBounds.worldSize / 256;
      const maskSupport: {
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
      }[] = [];
      for (let iz = 0; iz < 256; iz++)
        for (let ix = 0; ix < 256; ix++) {
          if (!mask.data[iz * 256 + ix]) continue;
          const x = ix * pixel - maskBounds.worldSize / 2 + maskBounds.centerX,
            z = iz * pixel - maskBounds.worldSize / 2 + maskBounds.centerZ;
          maskSupport.push({
            minX: x - 0.5 * pixel,
            maxX: x + 1.5 * pixel,
            minZ: z - 0.5 * pixel,
            maxZ: z + 1.5 * pixel,
          });
        }
      const clearPost = (post: (typeof posts)[number]) =>
        paths.every((path) =>
          path.path
            .slice(1)
            .every(
              (end, i) =>
                !compactPathIntersectsBounds(
                  path.path[i],
                  end,
                  post,
                  path.width / 2 +
                    (path.blendWidth ?? COMPACT_PATH_BLEND_WIDTH),
                ),
            ),
        ) &&
        maskSupport.every(
          (s) =>
            !(
              s.maxX > post.minX &&
              s.minX < post.maxX &&
              s.maxZ > post.minZ &&
              s.minZ < post.maxZ
            ),
        );
      if (!posts.every(clearPost)) {
        const available: string[] = [];
        for (let z = 332.5; z <= 342.5; z++)
          for (let x = 329.5; x <= 344.5; x++) {
            const post = {
              minX: x - 0.15,
              maxX: x + 0.15,
              minZ: z - 0.15,
              maxZ: z + 0.15,
            };
            if (clearPost(post)) available.push(`${x},${z}`);
          }
        throw new Error(
          `Court post/path conflict; path-only free cell centers: ${available.join("; ")}`,
        );
      }
      for (const station of Object.values(ALL_WORLD_AREAS).flatMap(
        (a) => a.stations ?? [],
      )) {
        const def = stationDataProvider.getStationData(station.type)!;
        if (!def.model) throw new Error(`Station model absent ${station.id}`);
        const bounds = modelBounds(def.model, def.modelScale).box.translate(
          new Vector3(
            station.position.x,
            terrain.getHeightAt(station.position.x, station.position.z) +
              STATION_GROUND_CLEARANCE +
              (def.modelYOffset ?? 0),
            station.position.z,
          ),
        );
        for (const post of posts)
          expect(
            post.maxX + 0.3 > bounds.min.x &&
              post.minX - 0.3 < bounds.max.x &&
              post.maxZ + 0.3 > bounds.min.z &&
              post.minZ - 0.3 < bounds.max.z,
            `${station.id} post/capsule`,
          ).toBe(false);
        if (envelope.intersectsBox(bounds)) {
          const localExtentX = Math.max(
            Math.abs(bounds.min.x - record.position.x),
            Math.abs(bounds.max.x - record.position.x),
          );
          const underside =
            record.position.y +
            3.2 +
            (5 - localExtentX) * Math.tan((32 * Math.PI) / 180);
          expect(
            underside - bounds.max.y,
            `${station.id} sloped roof clearance`,
          ).toBeGreaterThan(0.5);
        }
      }
      for (const npc of Object.values(ALL_WORLD_AREAS).flatMap(
        (a) => a.npcs ?? [],
      ))
        for (const post of posts)
          expect(
            Math.hypot(
              Math.max(
                post.minX - npc.position.x,
                0,
                npc.position.x - post.maxX,
              ),
              Math.max(
                post.minZ - npc.position.z,
                0,
                npc.position.z - post.maxZ,
              ),
            ),
            npc.id,
          ).toBeGreaterThan(0.9);
    } finally {
      geometry.dispose();
    }
  }, 60000);
});

// These cross-manifest source tests require an explicit isolated asset audition.
// They must not silently activate in a later default-world promotion.
describe.skipIf(
  process.env.HYPERIA_BANK_PAVILION_CANDIDATE !== "integration01",
)("explicit candidate bank pavilion real-world access", () => {
  it("measures the removed lodge grade against the exact Review75 manifest", async () => {
    expect(saved.config?.compactBankPavilion?.layoutId).toBe(
      "compact-bank-pavilion-v1",
    );
    const baselineAssets = process.env.BANK_PAVILION_BASELINE_ASSETS;
    if (!baselineAssets)
      throw new Error(
        "Candidate comparison requires BANK_PAVILION_BASELINE_ASSETS",
      );
    const configBytes = readFileSync(
      resolve(baselineAssets, "manifests/world-config.json"),
    );
    const areaBytes = readFileSync(
      resolve(baselineAssets, "manifests/world-areas.json"),
    );
    const sha = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    expect(sha(configBytes)).toBe(
      "9b62db692eea9bbedaea5903c9db748469ca8905766e96eeef8472b131affe79",
    );
    expect(sha(areaBytes)).toBe(
      "8478d1edca61d83380dd9d83d1ce6e8df07adf7a5864a2f999716a2a8ec9c69c",
    );
    const baselineConfig: WorldConfigManifest = JSON.parse(
      configBytes.toString("utf8"),
    );
    const baselineGroups: Record<
      string,
      Record<string, WorldArea>
    > = JSON.parse(areaBytes.toString("utf8"));
    const baselineAreas = Object.assign(
      {},
      ...[
        "starterTowns",
        "level1Areas",
        "level2Areas",
        "level3Areas",
        "specialAreas",
      ].map((key) => baselineGroups[key] ?? {}),
    ) as Record<string, WorldArea>;
    const measurements = async (
      config: WorldConfigManifest,
      areas: Record<string, WorldArea>,
    ) => {
      for (const key of Object.keys(ALL_WORLD_AREAS))
        delete ALL_WORLD_AREAS[key];
      Object.assign(ALL_WORLD_AREAS, areas);
      DataManager["worldContentIdentity"] = null;
      DataManager.setWorldConfig(config);
      const world = new CpuServerWorld();
      worlds.push(world);
      const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
      await terrain.init();
      const startup = terrain as unknown as {
        loadWaterBodiesFromManifest(): void;
        loadFlatZonesFromManifest(): void;
      };
      startup.loadWaterBodiesFromManifest();
      startup.loadFlatZonesFromManifest();
      const points = Array.from({ length: 21 }, (_, ix) =>
        Array.from({ length: 25 }, (_, iz) => ({
          x: 345 + ix * 0.5,
          z: 320.94 + iz * 0.5025,
        })),
      ).flat();
      points.push(
        { x: 350, z: 326.97 },
        { x: 350, z: 320 },
        { x: 348, z: 318 },
        { x: 344, z: 326.97 },
        { x: 356, z: 326.97 },
        { x: 350, z: 319.94 },
        { x: 350, z: 334 },
      );
      return {
        samples: points.map(({ x, z }) => ({
          x,
          z,
          canonical: terrain.getResourceGroundHeight(x, z),
          gameplay: terrain.getHeightAt(x, z),
        })),
        zones: terrain["getTerrainSurfaceForRegion"](340, 315, 360, 337).zones,
      };
    };
    const baseline = await measurements(baselineConfig, baselineAreas);
    const candidate = await measurements(saved.config!, saved.areas);
    const zoneId = "central_haven_lodge_grass_clearance";
    expect(baseline.zones.find((zone) => zone.id === zoneId)).toMatchObject({
      excludeGrass: true,
      centerX: 350,
      centerZ: 326.97,
      width: 10,
      depth: 12.06,
      height: 28.419301523097687,
      blendRadius: 0,
    });
    expect(candidate.zones.some((zone) => zone.id === zoneId)).toBe(false);
    expect(candidate.zones).toEqual(
      baseline.zones.filter((zone) => zone.id !== zoneId),
    );
    const rows = candidate.samples.map((after, i) => {
      const before = baseline.samples[i];
      expect(
        [
          after.canonical,
          after.gameplay,
          before.canonical,
          before.gameplay,
        ].every(Number.isFinite),
      ).toBe(true);
      return {
        x: after.x,
        z: after.z,
        baseline: before.canonical,
        candidate: after.canonical,
        delta: after.canonical - before.canonical,
        gameplayDelta: after.gameplay - before.gameplay,
      };
    });
    // The retained common Haven grade already owns this entire sampled region;
    // removing the redundant lodge pad must not introduce a local ground step.
    for (const row of rows) {
      expect(row.delta, JSON.stringify(row)).toBe(0);
      expect(row.gameplayDelta, JSON.stringify(row)).toBe(0);
    }
    console.info(
      "BANK_PAVILION_GRADE_RECEIPT",
      JSON.stringify({
        scope:
          "actual CPU canonical/gameplay height; not rendered triangle contact",
        baselineConfigSha256: sha(configBytes),
        baselineAreasSha256: sha(areaBytes),
        samples: rows.length,
        changed: rows.filter((row) => row.delta !== 0).length,
        minDelta: Math.min(...rows.map((row) => row.delta)),
        maxDelta: Math.max(...rows.map((row) => row.delta)),
        maxAbsGameplayDelta: Math.max(
          ...rows.map((row) => Math.abs(row.gameplayDelta)),
        ),
        selected: rows.slice(-7),
        largest: [...rows]
          .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
          .slice(0, 6),
      }),
    );
  });

  it("reaches the actual chest and moved clerk through owned collisions and enforces the real two-tile bank boundary", async () => {
    expect(saved.config?.compactBankPavilion?.layoutId).toBe(
      "compact-bank-pavilion-v1",
    );
    const { world, manager, terrain, resources, owner } = await fixture();
    await owner.start();
    const landscape = world.register(
      COMPACT_LANDSCAPE_ROCKS_SYSTEM,
      CompactLandscapeRocksSystem,
    ) as CompactLandscapeRocksSystem;
    await landscape.init();
    await landscape.start();
    const towns = world.register("towns", TownSystem) as TownSystem;
    await towns.init();
    await towns.start();
    expect(towns.getCompactPreparationLodge()).toBeNull();
    expect(towns.getCollisionService().getBuildingCount()).toBe(0);
    expect(owner.getCourts()).toHaveLength(2);
    expect(landscape.getRocks()?.placements).toHaveLength(17);
    expect(
      resources.getAllResources().filter((r) => r.type === "tree"),
    ).toHaveLength(48);
    const npcs = world.register(
      "mob-npc-spawner",
      MobNPCSpawnerSystem,
    ) as MobNPCSpawnerSystem;
    await npcs.init();
    // The real startup method, without unrelated default combat-mob spawning.
    await (
      npcs as unknown as { spawnAllNPCsFromManifest(): Promise<void> }
    ).spawnAllNPCsFromManifest();
    const clerk = [...manager.getAllEntities().values()].find((entity) =>
      entity.id.startsWith("npc_bank_clerk_"),
    );
    expect(clerk).toBeInstanceOf(NPCEntity);
    if (!(clerk instanceof NPCEntity))
      throw new Error("Actual clerk failed to spawn");
    expect([clerk.position.x, clerk.position.z]).toEqual([352, 322]);
    const bank = world.entities.get("station_bank_spawn");
    expect(bank).toBeInstanceOf(BankEntity);
    if (!(bank instanceof BankEntity))
      throw new Error("Actual bank failed to spawn");
    expect([bank.position.x, bank.position.z]).toEqual([348, 318]);
    const pool = new ArenaPoolManager();
    expect(pool.totalArenas).toBe(1);
    const arena = pool.getArenaBounds(1)!;
    const config = getDuelArenaConfig();
    expect([arena.min.x, arena.min.z, arena.max.x, arena.max.z]).toEqual([
      config.baseX,
      config.baseZ,
      config.baseX + config.arenaWidth,
      config.baseZ + config.arenaLength,
    ]);
    pool.registerArenaWallCollision(world.collision);
    pool.assertArenaWallCollision(world.collision);
    const player = new PlayerEntity(world, {
      id: "bank-pavilion-range-proof",
      name: "Physical bank range proof",
      type: "player",
      position: [350, terrain.getHeightAt(350, 320), 320],
      quaternion: [0, 0, 0, 1],
    });
    world.entities.set(player.id, player);
    try {
      expect(validatePhysicalBankAccess(world, player.id, bank.id)).toBeNull();
      for (const [x, z] of [
        [350.001, 320],
        [350, 320.001],
        [345.999, 318],
        [348, 315.999],
      ]) {
        player.position.set(x, terrain.getHeightAt(x, z), z);
        expect(validatePhysicalBankAccess(world, player.id, bank.id)).toBe(
          "bank_out_of_range",
        );
      }
      const walkable = (p: TileCoord, from?: TileCoord) =>
        p.x >= 250 &&
        p.x < 550 &&
        p.z >= 250 &&
        p.z < 550 &&
        world.collision.isWalkable(p.x, p.z) &&
        (!from || !world.collision.isBlocked(from.x, from.z, p.x, p.z));
      const starts = [
        getDuelArenaLobbyReturnPosition(true),
        getDuelArenaLobbyReturnPosition(false),
        getDuelArenaEgressPosition(),
      ].map((p) => worldToTile(p.x, p.z));
      const targets = [
        { id: "pavilion-center", tiles: [{ x: 350, z: 320 }] },
        ...[bank, clerk].map((entity) => ({
          id: entity.id,
          tiles: getCardinalAdjacentTiles(
            worldToTile(entity.position.x, entity.position.z),
            1,
            1,
          ).filter((tile) => walkable(tile)),
        })),
      ];
      for (const subject of targets)
        expect(subject.tiles.length, subject.id).toBeGreaterThan(0);
      const bfs = new BFSPathfinder();
      const routes: Array<{
        from: TileCoord;
        to: TileCoord;
        subject: string;
        edges: number;
      }> = [];
      for (const start of starts)
        for (const subject of targets)
          for (const target of subject.tiles) {
            expect(walkable(start)).toBe(true);
            expect(walkable(target)).toBe(true);
            let cursor = start,
              edges = 0;
            const visited = new Set<string>();
            for (
              let part = 0;
              part < 12 && (cursor.x !== target.x || cursor.z !== target.z);
              part++
            ) {
              const segment = bfs.findPath(cursor, target, walkable);
              expect(segment.length).toBeGreaterThan(0);
              for (const tile of segment) {
                expect(walkable(tile, cursor)).toBe(true);
                expect(
                  isPositionInsideCombatArena(tile.x + 0.5, tile.z + 0.5),
                ).toBe(false);
                if (tile.x !== cursor.x || tile.z !== cursor.z) edges++;
                cursor = tile;
              }
              const key = `${cursor.x},${cursor.z}`;
              expect(visited.has(key)).toBe(false);
              visited.add(key);
            }
            expect(cursor).toEqual(target);
            routes.push({
              from: start,
              to: target,
              subject: subject.id,
              edges,
            });
          }
      console.info(
        "BANK_PAVILION_ACCESS_RECEIPT",
        JSON.stringify({
          scope:
            "actual CPU World, PhysX-backed court/rock owners, resources/stations/NPCs/TownSystem, server arena perimeter and bank validator; no DB transaction/browser movement",
          courts: owner.getAllDiagnostics(),
          rockCount: landscape.getRocks()?.placements.length,
          oldLodgeCollisionCount: towns
            .getCollisionService()
            .getBuildingCount(),
          bank: { id: bank.id, x: bank.position.x, z: bank.position.z },
          clerk: { id: clerk.id, x: clerk.position.x, z: clerk.position.z },
          bankCenterChebyshevDistance: 2,
          rejectedOutsidePositions: 4,
          routes,
          totalEdges: routes.reduce((sum, route) => sum + route.edges, 0),
        }),
      );
    } finally {
      world.entities.items.delete(player.id);
      world.entities.players.delete(player.id);
      player.destroy();
    }
  }, 60000);
});
