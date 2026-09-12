import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { EventType } from "../../../../types/events";
import type {
  TerrainTile,
  TerrainResourceSpawnBatch,
} from "../../../../types/world/terrain";
import type { CompactResourceGrovesManifest } from "../../../../types/world/world-types";
import { EntityManager } from "../../entities/EntityManager";
import { ResourceSystem } from "../../entities/ResourceSystem";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { createCompactResourceGroveNodes } from "../CompactResourceGroves";
import type { TreeGenerationSource } from "../BiomeResourceGenerator";
import { isPositionInsideDuelArenaZone } from "../../../../data/duel-manifest";
import { CollisionFlag } from "../../movement/CollisionFlags";
import layouts from "./fixtures/CompactResourceGroves.layouts.json";
import { BFSPathfinder } from "../../movement/BFSPathfinder";
import {
  getCardinalAdjacentTiles,
  worldToTile,
  type TileCoord,
} from "../../movement/TileSystem";
import type { Resource } from "../../../../types/core/core";

// Exact pre-grove candidate03 baseline, not recomputed expectations.
// Existing authored server quaternion randomness is outside this stable census.
const EXISTING = [
  {
    id: "tree_281_513",
    subType: "banana",
    x: 280.5,
    y: 25.95063550849739,
    z: 512.5,
    scale: 1.0393102768434468,
  },
  {
    id: "tree_281_518",
    subType: "palm",
    x: 280.5,
    y: 21.83347737930466,
    z: 517.5,
    scale: 1.0570706823973615,
  },
  {
    id: "tree_289_508",
    subType: "banana",
    x: 288.5,
    y: 30.564014967770945,
    z: 507.5,
    scale: 1.1543517902852856,
  },
  {
    id: "tree_311_295",
    subType: "palm",
    x: 310.5,
    y: 28.395813068882305,
    z: 294.5,
    scale: 1.1728671277344382,
  },
  {
    id: "tree_335_266",
    subType: "palm",
    x: 334.5,
    y: 26.431061431582275,
    z: 265.5,
    scale: 1.082286132751565,
  },
  {
    id: "tree_367_311",
    subType: "general",
    x: 366.5,
    y: 28.419301523097687,
    z: 322.5,
    scale: 1,
  },
  {
    id: "tree_373_313",
    subType: "oak",
    x: 318.5,
    y: 28.419301523097687,
    z: 312.5,
    scale: 1,
  },
  {
    id: "tree_375_299",
    subType: "magic",
    x: 318.5,
    y: 28.419301523097687,
    z: 344.5,
    scale: 1,
  },
  {
    id: "tree_377_288",
    subType: "banana",
    x: 376.5,
    y: 28.419301523097687,
    z: 287.5,
    scale: 1.1065835295027548,
  },
  {
    id: "tree_379_304",
    subType: "mahogany",
    x: 381.5,
    y: 28.419301523097687,
    z: 329.5,
    scale: 1,
  },
  {
    id: "tree_379_311",
    subType: "maple",
    x: 323.5,
    y: 28.419301523097687,
    z: 288.5,
    scale: 1,
  },
  {
    id: "tree_502_419",
    subType: "banana",
    x: 501.5,
    y: 17.947079836660937,
    z: 418.5,
    scale: 1.1373860959283508,
  },
  {
    id: "tree_503_432",
    subType: "general",
    x: 502.5,
    y: 17.922226870245474,
    z: 431.5,
    scale: 1.0061008904609132,
  },
] as const;
const ADDED_IDS = [
  "tree_288_387",
  "tree_290_432",
  "tree_293_460",
  "tree_294_422",
  "tree_297_449",
  "tree_305_410",
  "tree_310_471",
  "tree_315_492",
  "tree_318_465",
  "tree_320_501",
  "tree_328_484",
  "tree_330_500",
  "tree_333_466",
  "tree_443_383",
  "tree_459_383",
  "tree_461_396",
].sort();
class CpuServerWorld extends World {
  override get isServer() {
    return true;
  }
}
type TerrainInternals = {
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  generateTile(x: number, z: number, content: boolean): TerrainTile;
  unloadTile(tile: TerrainTile): void;
  updatePlayerBasedTerrain(): void;
  processTileGenerationQueue(): void;
  createTreeGenerationSource(x: number, z: number): TreeGenerationSource;
};
type ResourceInternals = {
  initializeWorldAreaResources(): Promise<void>;
  terrainResourceTails: Map<string, Promise<void>>;
  registerTerrainResources(batch: TerrainResourceSpawnBatch): Promise<void>;
  resources: Map<string, Resource>;
  respawnAtTick: Map<string, number>;
};
const worlds: World[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});
async function fixture() {
  const world = new CpuServerWorld();
  worlds.push(world);
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
  const t = terrain as unknown as TerrainInternals,
    r = resources as unknown as ResourceInternals;
  await terrain.init();
  t.loadWaterBodiesFromManifest();
  t.loadFlatZonesFromManifest();
  await roads.init();
  await roads.start();
  await resources.init();
  const settle = async () => {
    await Promise.all([...r.terrainResourceTails.values()]);
  };
  const batches: TerrainResourceSpawnBatch[] = [];
  world.on(
    EventType.RESOURCE_SPAWN_POINTS_REGISTERED,
    (batch: TerrainResourceSpawnBatch) => batches.push(batch),
  );
  return { world, manager, terrain, resources, t, r, settle, batches };
}
describe("actual compact functional grove tile pipeline", () => {
  it("publishes 48 actual resources from 9 content owners, retains all 29 prior transforms/species/scales and never duplicates on stationary updates", async () => {
    const f = await fixture();
    await f.terrain.start();
    await f.settle();
    await f.r.initializeWorldAreaResources();
    await f.settle();
    const rows = () =>
      f.resources
        .getAllResources()
        .filter((r) => r.type === "tree")
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(rows().map((r) => r.id)).toEqual(
      [
        ...EXISTING.map((r) => r.id),
        ...ADDED_IDS,
        ...layouts.additions.map((a) => a.id),
      ].sort(),
    );
    expect(rows()).toHaveLength(48);
    expect(
      [...f.terrain.getTiles().values()].filter((t) => t.contentGenerated),
    ).toHaveLength(9);
    expect(f.terrain.getTiles().size).toBe(25);
    for (const expected of EXISTING) {
      const e = f.manager.getEntity(expected.id);
      expect(e).toBeInstanceOf(ResourceEntity);
      if (!(e instanceof ResourceEntity))
        throw new Error("actual original resource missing");
      expect({ x: e.position.x, y: e.position.y, z: e.position.z }).toEqual({
        x: expected.x,
        y: expected.y,
        z: expected.z,
      });
      expect(e.config.resourceId).toBe(`tree_${expected.subType}`);
      expect(e.config.modelScale).toBe(expected.scale);
    }
    const previous = layouts.previous.regions.flatMap((r) => r.anchors);
    expect(previous.map((a) => a.id).sort()).toEqual(ADDED_IDS);
    // Independent frozen predecessor fixture, not expectations regenerated from config.
    for (const a of [...previous, ...layouts.additions]) {
      const e = f.manager.getEntity(a.id);
      expect(e).toBeInstanceOf(ResourceEntity);
      if (!(e instanceof ResourceEntity))
        throw new Error("Missing frozen grove actor");
      expect(e.position.toArray()).toEqual([
        a.position.x,
        a.position.y,
        a.position.z,
      ]);
      expect(e.config.modelScale).toBe(a.scale);
      expect(e.config.resourceId).toBe(`tree_${a.subType}`);
      const live = DataManager.getWorldConfig()!
        .compactResourceGroves!.regions.flatMap((r) => r.anchors)
        .find((n) => n.id === a.id)!;
      const { region: _region, ...expected } = { region: "", ...a };
      expect(live).toEqual(expected);
    }
    for (const region of DataManager.getWorldConfig()!.compactResourceGroves!
      .regions)
      for (const a of region.anchors) {
        const e = f.manager.getEntity(a.id);
        expect(e).toBeInstanceOf(ResourceEntity);
        if (!(e instanceof ResourceEntity))
          throw new Error("actual grove resource missing");
        expect({ x: e.position.x, y: e.position.y, z: e.position.z }).toEqual(
          a.position,
        );
        expect(e.position.y).toBe(
          f.terrain.getResourceGroundHeight(a.position.x, a.position.z),
        );
        expect(e.config.resourceId).toBe(`tree_${a.subType}`);
        expect(e.config.modelScale).toBe(a.scale);
        expect(e.config.depletedModelScale).toBe(0.1 * a.scale);
        expect(e.config.respawnTime).toBe(48000); // Existing 80 ticks × 600 ms; unchanged manifest.
        expect(e.config.harvestYield).toEqual([
          {
            itemId: a.subType === "oak" ? "oak_logs" : "logs",
            quantity: 1,
            chance: 1,
          },
        ]);
        expect(
          f.world.collision.hasFlags(
            Math.floor(a.position.x),
            Math.floor(a.position.z),
            CollisionFlag.BLOCKED,
          ),
        ).toBe(true);
        const batch = f.batches.find((b) =>
          b.spawnPoints.some(
            (p) =>
              p.position.x === a.position.x && p.position.z === a.position.z,
          ),
        );
        expect(batch?.owner).toEqual({
          tileX: Math.floor((a.position.x + 50) / 100),
          tileZ: Math.floor((a.position.z + 50) / 100),
        });
        expect(batch?.isManifest).not.toBe(true);
        expect(
          batch?.spawnPoints.find(
            (p) =>
              p.position.x === a.position.x && p.position.z === a.position.z,
          )?.instanceId,
        ).toBeUndefined();
      }
    const entities = rows().map((r) => f.manager.getEntity(r.id)),
      batchCount = f.batches.length;
    f.t.updatePlayerBasedTerrain();
    f.t.processTileGenerationQueue();
    await f.settle();
    expect(rows().map((r) => f.manager.getEntity(r.id))).toEqual(entities);
    expect(f.batches).toHaveLength(batchCount);
  });

  it("retains completed bank-front collision routes to all 48 trees and four free cardinal approaches at every new tree", async () => {
    const f = await fixture();
    await f.terrain.start();
    await f.settle();
    await f.r.initializeWorldAreaResources();
    await f.settle();
    const rows = f.resources.getAllResources().filter((r) => r.type === "tree");
    expect(rows).toHaveLength(48);
    const additions = new Set(layouts.additions.map((a) => a.id));
    // Actual authoritative collision flags/edge checks, with bounded arena exclusion.
    // Moving actors and station-model envelopes are separate offline/native gates.
    const walkable = (p: TileCoord, from?: TileCoord) =>
      p.x >= 250 &&
      p.x < 550 &&
      p.z >= 250 &&
      p.z < 550 &&
      !isPositionInsideDuelArenaZone(p.x + 0.5, p.z + 0.5) &&
      f.world.collision.isWalkable(p.x, p.z) &&
      (!from || !f.world.collision.isBlocked(from.x, from.z, p.x, p.z));
    for (const row of rows) {
      const adjacent = getCardinalAdjacentTiles(
        worldToTile(row.position.x, row.position.z),
        1,
        1,
      ).filter((p) => walkable(p));
      if (additions.has(row.id)) expect(adjacent, row.id).toHaveLength(4);
      expect(adjacent.length, row.id).toBeGreaterThan(0);
      const target = adjacent.sort(
        (a, b) =>
          Math.abs(a.x - 348) +
          Math.abs(a.z - 322) -
          Math.abs(b.x - 348) -
          Math.abs(b.z - 322),
      )[0];
      let cursor = { x: 348, z: 322 };
      const bfs = new BFSPathfinder(),
        seen = new Set<string>();
      for (
        let search = 0;
        search < 12 && (cursor.x !== target.x || cursor.z !== target.z);
        search++
      ) {
        const segment = bfs.findPath(cursor, target, walkable);
        expect(segment.length, row.id).toBeGreaterThan(0);
        for (const p of segment) {
          expect(walkable(p, cursor), row.id).toBe(true);
          expect(
            Math.max(Math.abs(p.x - cursor.x), Math.abs(p.z - cursor.z)),
          ).toBeLessThanOrEqual(1);
          cursor = p;
        }
        const key = `${cursor.x},${cursor.z}`;
        expect(seen.has(key), row.id).toBe(false);
        seen.add(key);
      }
      expect(cursor, row.id).toEqual(target);
    }
  });

  it("does not reset existing or scale-0.8 depletion/deadlines when an admitted owner is replayed", async () => {
    const f = await fixture();
    await f.terrain.start();
    await f.settle();
    const ids = ["tree_288_387", "tree_288_441"];
    const refs = ids.map((id) => {
      const entity = f.manager.getEntity(id) as ResourceEntity;
      const resource = f.r.resources.get(id)!;
      resource.isAvailable = false;
      resource.lastDepleted = 123456;
      f.r.respawnAtTick.set(id, 4321);
      entity.deplete();
      return { entity, resource };
    });
    const batch = f.batches.find(
      (b) => b.owner?.tileX === 3 && b.owner.tileZ === 4,
    )!;
    await Promise.all([
      f.r.registerTerrainResources(batch),
      f.r.registerTerrainResources(batch),
    ]);
    f.t.updatePlayerBasedTerrain();
    f.t.processTileGenerationQueue();
    await f.settle();
    ids.forEach((id, index) => {
      expect(f.manager.getEntity(id)).toBe(refs[index].entity);
      expect(f.r.resources.get(id)).toBe(refs[index].resource);
      expect(refs[index].resource.isAvailable).toBe(false);
      expect(refs[index].resource.lastDepleted).toBe(123456);
      expect(refs[index].entity.config.depleted).toBe(true);
      expect(f.r.respawnAtTick.get(id)).toBe(4321);
    });
  });

  it("retires one centered owner and reloads the exact same grove IDs/positions without destroying neighboring or authored trees", async () => {
    const f = await fixture();
    await f.terrain.start();
    await f.settle();
    await f.r.initializeWorldAreaResources();
    await f.settle();
    const tile = f.terrain.getTiles().get("3_4")!;
    expect(tile).toBeDefined();
    const ids = tile.resources
      .filter((r) => r.type === "tree")
      .map(
        (r) =>
          `tree_${(300 + r.position.x).toFixed(0)}_${(400 + r.position.z).toFixed(0)}`,
      );
    expect(ids.sort()).toEqual(
      [
        "tree_288_387",
        "tree_290_432",
        "tree_294_422",
        "tree_297_449",
        "tree_305_410",
        "tree_298_401",
        "tree_297_439",
        "tree_287_400",
        "tree_308_438",
        "tree_288_441",
        "tree_292_410",
        "tree_309_450",
        "tree_302_387",
      ].sort(),
    );
    expect(
      (f.manager.getEntity("tree_288_441") as ResourceEntity).config.modelScale,
    ).toBe(0.8);
    const old = ids.map((id) => f.manager.getEntity(id));
    const other = f.manager.getEntity("tree_461_396"),
      authored = f.manager.getEntity("tree_373_313");
    f.t.unloadTile(tile);
    await f.settle();
    for (const id of ids) expect(f.manager.getEntity(id)).toBeUndefined();
    expect(f.manager.getEntity("tree_461_396")).toBe(other);
    expect(f.manager.getEntity("tree_373_313")).toBe(authored);
    f.t.generateTile(3, 4, true);
    await f.settle();
    ids.forEach((id, i) => {
      expect(f.manager.getEntity(id)).toBeInstanceOf(ResourceEntity);
      expect(f.manager.getEntity(id)).not.toBe(old[i]);
      expect(old[i]!.destroyed).toBe(true);
      expect(old[i]!.node.parent).toBeNull();
      expect(f.world.entities.hot.has(old[i]!)).toBe(false);
    });
    expect(
      f.resources.getAllResources().filter((r) => r.type === "tree"),
    ).toHaveLength(48);
  });

  it("uses real computed terrain for runtime rejection and publishes no partial owner result", async () => {
    const f = await fixture();
    await f.terrain.start();
    await f.settle();
    const layout = DataManager.getWorldConfig()!.compactResourceGroves!;
    const source = f.t.createTreeGenerationSource(3, 4),
      owner = { tileX: 3, tileZ: 4 };
    const nodes = createCompactResourceGroveNodes(
      layout,
      owner,
      source,
      new Set(),
      isPositionInsideDuelArenaZone,
    );
    expect(nodes.length).toBeGreaterThan(0);
    expect(
      nodes.every(
        (n) =>
          n.position.x >= -50 &&
          n.position.x < 50 &&
          n.position.z >= -50 &&
          n.position.z < 50,
      ),
    ).toBe(true);
    expect(() =>
      createCompactResourceGroveNodes(
        layout,
        owner,
        source,
        new Set([nodes[0].id]),
        isPositionInsideDuelArenaZone,
      ),
    ).toThrow("collision");
    const bad = JSON.parse(
      JSON.stringify(layout),
    ) as CompactResourceGrovesManifest;
    Object.assign(bad.regions[0].anchors[0].position, {
      y: bad.regions[0].anchors[0].position.y + 0.01,
    });
    expect(() =>
      createCompactResourceGroveNodes(
        bad,
        owner,
        source,
        new Set(),
        isPositionInsideDuelArenaZone,
      ),
    ).toThrow("ground height");
    const road = JSON.parse(
      JSON.stringify(layout),
    ) as CompactResourceGrovesManifest;
    // The real compact plaza path is in owner3_3, not a fabricated road predicate.
    Object.assign(road.regions[0].anchors[0], {
      id: "tree_337_334",
      position: {
        x: 336.5,
        y: f.terrain.getResourceGroundHeight(336.5, 333.5),
        z: 333.5,
      },
    });
    expect(() =>
      createCompactResourceGroveNodes(
        road,
        { tileX: 3, tileZ: 3 },
        f.t.createTreeGenerationSource(3, 3),
        new Set(),
        isPositionInsideDuelArenaZone,
      ),
    ).toThrow("physical anchor");
    expect(
      createCompactResourceGroveNodes(
        undefined,
        owner,
        source,
        new Set(),
        isPositionInsideDuelArenaZone,
      ),
    ).toEqual([]);
  });
});
