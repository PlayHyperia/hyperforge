import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { EventType } from "../../../../types/events";
import type {
  TerrainTile,
  TerrainResourceSpawnBatch,
} from "../../../../types/world/terrain";
import type {
  CompactResourceGrovesManifest,
  WorldConfigManifest,
} from "../../../../types/world/world-types";
import { EntityManager } from "../../entities/EntityManager";
import { ResourceSystem } from "../../entities/ResourceSystem";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { createCompactResourceGroveNodes } from "../CompactResourceGroves";
import {
  validateTreeAnchor,
  type TreeGenerationSource,
} from "../BiomeResourceGenerator";
import {
  getDuelArenaConfig,
  isPositionInsideDuelArenaZone,
} from "../../../../data/duel-manifest";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import {
  WORLD_IDENTITY_MANIFESTS,
  WorldManifestIdentityBuilder,
} from "../../../../data/WorldContentIdentity";
import { WorldContentAdmission } from "../../../../runtime/WorldContentAdmission";
import {
  COMPACT_PATH_BLEND_WIDTH,
  compactPathSegmentDistance,
  createCompactIslandPaths,
} from "../CompactIslandPaths";
import { getCompactPondDockSupportBounds } from "../DockDefinition";
import { modelBounds } from "./fixtures/StaticGlbBounds";
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

// Explicit private overlay admission; historical layout tests remain unchanged.
const GROVE_MOVES = [
  {
    before: "tree_459_383",
    after: "tree_453_392",
    x: 452.5,
    z: 391.5,
    model: "general_03.glb",
  },
  {
    before: "tree_471_406",
    after: "tree_467_401",
    x: 466.5,
    z: 400.5,
    model: "general_05.glb",
  },
  {
    before: "tree_460_365",
    after: "tree_464_385",
    x: 463.5,
    z: 384.5,
    model: "general_01.glb",
  },
] as const;
const compositionStage = process.env.HYPERIA_GROVE_COMPOSITION_STAGE;
function compositionSelection(
  expected: "assets-v9" | "assets-v11" | "assets-v12",
) {
  const directory = process.env.ASSETS_DIR;
  if (!directory) throw new Error("Selected grove assets are required");
  expect(basename(directory)).toBe(expected);
  const sourcePath = join(directory, "manifests/world-config.json");
  const bytes = readFileSync(sourcePath);
  const config = JSON.parse(bytes.toString()) as WorldConfigManifest;
  expect(DataManager.getWorldConfig()!.compactResourceGroves).toEqual(
    config.compactResourceGroves,
  );
  return {
    directory,
    sourcePath,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    config,
  };
}

describe("selected eastern woodland composition", () => {
  it.skipIf(compositionStage !== "sample")(
    "samples three proposed grove anchors through actual v9 terrain admission",
    async () => {
      const selected = compositionSelection("assets-v9");
      const f = await fixture();
      const source = f.t.createTreeGenerationSource(5, 4);
      const anchors = selected.config.compactResourceGroves!.regions.flatMap(
        (r) => r.anchors,
      );
      const positions = GROVE_MOVES.map((move) => {
        const original = anchors.find((a) => a.id === move.before)!;
        expect(original.subType).toBe("general");
        expect(original.scale).toBe(1);
        const admitted = validateTreeAnchor(
          source,
          move.x,
          move.z,
          isPositionInsideDuelArenaZone,
        );
        expect(admitted.rejection, move.after).toBeNull();
        expect(admitted.position.y).toBe(
          f.terrain.getResourceGroundHeight(move.x, move.z),
        );
        return {
          ...move,
          previousPosition: original.position,
          position: admitted.position,
          rejection: admitted.rejection,
        };
      });
      console.info(
        "grove-composition-authoritative-heights",
        JSON.stringify({
          sourcePath: selected.sourcePath,
          sourceSha256: selected.sourceSha256,
          positions,
        }),
      );
    },
  );

  it.skipIf(
    compositionStage !== "qualify" && compositionStage !== "qualify-v12",
  )(
    "qualifies selected three-ID delta, exact models, collision routes, replay and owner lifecycle",
    async () => {
      const combinedBank = compositionStage === "qualify-v12";
      const selected = compositionSelection(
        combinedBank ? "assets-v12" : "assets-v11",
      );
      const baseline = resolve(
        selected.directory,
        combinedBank ? "../assets-v10" : "../assets-v9",
      );
      // The combined candidate must preserve the retained bank byte-for-byte;
      // reusing v11 wholesale would silently restore its older terrain.
      if (combinedBank)
        expect(
          readFileSync(join(selected.directory, "manifests/world-areas.json")),
        ).toEqual(readFileSync(join(baseline, "manifests/world-areas.json")));
      const baseConfig = JSON.parse(
        readFileSync(join(baseline, "manifests/world-config.json"), "utf8"),
      ) as WorldConfigManifest;
      const previous = baseConfig.compactResourceGroves!.regions.flatMap(
        (r) => r.anchors,
      );
      const current = selected.config.compactResourceGroves!.regions.flatMap(
        (r) => r.anchors,
      );
      expect(current).toHaveLength(35);
      const expectedConfig = structuredClone(baseConfig);
      for (const move of GROVE_MOVES) {
        const destination = current.find((a) => a.id === move.after)!;
        expect(destination.position.x).toBe(move.x);
        expect(destination.position.z).toBe(move.z);
        const old = expectedConfig
          .compactResourceGroves!.regions.flatMap((r) => r.anchors)
          .find((a) => a.id === move.before)!;
        Object.assign(old, { id: move.after, position: destination.position });
      }
      expect(selected.config).toEqual(expectedConfig);
      const identities: string[] = [];
      for (const directory of [baseline, selected.directory]) {
        const builder = new WorldManifestIdentityBuilder();
        for (const name of WORLD_IDENTITY_MANIFESTS)
          builder.record(
            name,
            JSON.parse(
              readFileSync(join(directory, "manifests", name), "utf8"),
            ),
          );
        identities.push(
          await builder.build(DataManager.getWorldTerrainProfile()),
        );
      }
      expect(identities[0]).not.toBe(identities[1]);
      expect(DataManager.getWorldContentIdentity()).toBe(identities[1]);
      const admission = new WorldContentAdmission(() => identities[1]);
      admission.beginConnection();
      expect(admission.admitSnapshot(identities[0])).toBeNull();
      expect(admission.rejected).toBe(true);
      admission.beginConnection();
      expect(admission.admitSnapshot(identities[1])).not.toBeNull();

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
      const expectedRows = [
        ...EXISTING,
        ...current.map((a) => ({
          id: a.id,
          subType: a.subType,
          ...a.position,
          scale: a.scale,
        })),
      ];
      expect(rows().map((r) => r.id)).toEqual(
        expectedRows.map((r) => r.id).sort(),
      );
      expect(rows()).toHaveLength(48);
      const beforeIds = new Set([
        ...EXISTING.map((r) => r.id),
        ...previous.map((a) => a.id),
      ]);
      const afterIds = new Set(rows().map((r) => r.id));
      expect([...beforeIds].filter((id) => !afterIds.has(id)).sort()).toEqual(
        GROVE_MOVES.map((m) => m.before).sort(),
      );
      expect([...afterIds].filter((id) => !beforeIds.has(id)).sort()).toEqual(
        GROVE_MOVES.map((m) => m.after).sort(),
      );
      for (const expected of expectedRows) {
        const entity = f.manager.getEntity(expected.id);
        expect(entity).toBeInstanceOf(ResourceEntity);
        if (!(entity instanceof ResourceEntity))
          throw new Error("Actual grove actor missing");
        expect(entity.config.resourceId).toBe(`tree_${expected.subType}`);
        expect(entity.position).toMatchObject({
          x: expected.x,
          y: expected.y,
          z: expected.z,
        });
        expect(entity.config.modelScale).toBe(expected.scale);
      }
      const paths = createCompactIslandPaths(
        DataManager.getWorldTerrainProfile(),
        ALL_WORLD_AREAS,
        getDuelArenaConfig(),
        f.terrain.getResourceGroundHeight.bind(f.terrain),
        selected.config,
      );
      const docks = selected.config.compactPondDocks!.docks.map(
        getCompactPondDockSupportBounds,
      );
      const ponds = Object.values(ALL_WORLD_AREAS)
        .flatMap((area) => area.waterBodies ?? [])
        .filter((body) => body.id === "haven_pond_water");
      expect(ponds).toHaveLength(1);
      const pond = ponds[0];
      const proof = GROVE_MOVES.map((move) => {
        const entity = f.manager.getEntity(move.after) as ResourceEntity;
        const hash = (
          entity as unknown as { hashString(s: string): number }
        ).hashString.bind(entity);
        const variants = entity.config.modelVariants!;
        const model = variants[(hash(move.after) >>> 0) % variants.length];
        expect(model).toContain(move.model);
        expect(variants[(hash(move.before) >>> 0) % variants.length]).toBe(
          model,
        );
        const bounds = modelBounds(model, entity.config.modelScale);
        const source = f.t.createTreeGenerationSource(5, 4);
        const accepted = validateTreeAnchor(
          source,
          move.x,
          move.z,
          isPositionInsideDuelArenaZone,
        );
        expect(accepted.rejection, move.after).toBeNull();
        expect(accepted.position).toEqual(
          current.find((a) => a.id === move.after)!.position,
        );
        const roadMargin = Math.min(
          ...paths.flatMap((path) =>
            path.path
              .slice(1)
              .map(
                (end, i) =>
                  compactPathSegmentDistance(move, path.path[i], end) -
                  path.width / 2 -
                  (path.blendWidth ?? COMPACT_PATH_BLEND_WIDTH) -
                  bounds.radius,
              ),
          ),
        );
        const dockMargin = Math.min(
          ...docks.map(
            (b) =>
              Math.hypot(
                Math.max(b.minX - move.x, 0, move.x - b.maxX),
                Math.max(b.minZ - move.z, 0, move.z - b.maxZ),
              ) - bounds.radius,
          ),
        );
        expect(roadMargin, move.after).toBeGreaterThan(0);
        expect(dockMargin, move.after).toBeGreaterThan(0);
        // The entire declared source canopy stays beyond a five-metre shore
        // approach band, not just outside the tree's one-tile collision cell.
        // This is LOD0 static geometry clearance, not wind/LOD silhouette proof
        // or a replacement for actual fishing/traversal qualification.
        const pondMargin =
          Math.hypot(move.x - pond.centerX, move.z - pond.centerZ) -
          pond.radius -
          bounds.radius;
        expect(pondMargin, move.after).toBeGreaterThan(5);
        return {
          id: move.after,
          position: accepted.position,
          model,
          scale: entity.config.modelScale,
          triangles: bounds.triangles,
          primitives: bounds.primitives,
          radius: bounds.radius,
          roadMargin,
          dockMargin,
          pondMargin,
        };
      });
      expect(proof.reduce((sum, r) => sum + r.triangles, 0)).toBe(16101);
      const walkable = (p: TileCoord, from?: TileCoord) =>
        p.x >= 250 &&
        p.x < 550 &&
        p.z >= 250 &&
        p.z < 550 &&
        !isPositionInsideDuelArenaZone(p.x + 0.5, p.z + 0.5) &&
        f.world.collision.isWalkable(p.x, p.z) &&
        (!from || !f.world.collision.isBlocked(from.x, from.z, p.x, p.z));
      let completedRoutes = 0;
      for (const row of rows()) {
        const anchor = worldToTile(row.position.x, row.position.z);
        const adjacent = getCardinalAdjacentTiles(anchor, 1, 1).filter((p) =>
          walkable(p),
        );
        if (GROVE_MOVES.some((m) => m.after === row.id)) {
          expect(
            f.world.collision.hasFlags(
              anchor.x,
              anchor.z,
              CollisionFlag.BLOCKED,
            ),
          ).toBe(true);
          expect(adjacent, row.id).toHaveLength(4);
        }
        expect(adjacent.length, row.id).toBeGreaterThan(0);
        const target = adjacent.sort(
          (a, b) =>
            Math.abs(a.x - 348) +
            Math.abs(a.z - 322) -
            Math.abs(b.x - 348) -
            Math.abs(b.z - 322),
        )[0];
        const bfs = new BFSPathfinder(),
          seen = new Set<string>();
        let cursor = { x: 348, z: 322 };
        for (
          let i = 0;
          i < 12 && (cursor.x !== target.x || cursor.z !== target.z);
          i++
        ) {
          const segment = bfs.findPath(cursor, target, walkable);
          expect(segment.length, row.id).toBeGreaterThan(0);
          for (const next of segment) {
            expect(walkable(next, cursor), row.id).toBe(true);
            cursor = next;
          }
          const key = `${cursor.x},${cursor.z}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
        expect(cursor, row.id).toEqual(target);
        completedRoutes++;
      }
      const tile = f.terrain.getTiles().get("5_4")!;
      expect(tile).toBeDefined();
      const batch = f.batches.find(
        (b) => b.owner?.tileX === 5 && b.owner.tileZ === 4,
      )!;
      expect(batch).toBeDefined();
      const moved = GROVE_MOVES.map((move) => {
        const entity = f.manager.getEntity(move.after) as ResourceEntity;
        const resource = f.r.resources.get(move.after)!;
        resource.isAvailable = false;
        resource.lastDepleted = 123456;
        f.r.respawnAtTick.set(move.after, 4321);
        entity.deplete();
        return { id: move.after, entity, resource };
      });
      await Promise.all([
        f.r.registerTerrainResources(batch),
        f.r.registerTerrainResources(batch),
      ]);
      await f.settle();
      for (const row of moved) {
        expect(f.manager.getEntity(row.id)).toBe(row.entity);
        expect(f.r.resources.get(row.id)).toBe(row.resource);
        expect(row.resource.isAvailable).toBe(false);
        expect(row.resource.lastDepleted).toBe(123456);
        expect(row.entity.config.depleted).toBe(true);
        expect(f.r.respawnAtTick.get(row.id)).toBe(4321);
      }
      const neighbor = f.manager.getEntity("tree_443_383"),
        authored = f.manager.getEntity("tree_373_313");
      f.t.unloadTile(tile);
      await f.settle();
      for (const row of moved) {
        expect(f.manager.getEntity(row.id)).toBeUndefined();
        expect(row.entity.destroyed).toBe(true);
        expect(row.entity.node.parent).toBeNull();
        expect(f.world.entities["hot"].has(row.entity)).toBe(false);
      }
      expect(f.manager.getEntity("tree_443_383")).toBe(neighbor);
      expect(f.manager.getEntity("tree_373_313")).toBe(authored);
      f.t.generateTile(5, 4, true);
      await f.settle();
      for (const row of moved) {
        const entity = f.manager.getEntity(row.id);
        expect(entity).toBeInstanceOf(ResourceEntity);
        expect(entity).not.toBe(row.entity);
        expect(entity!.position).toMatchObject(
          current.find((a) => a.id === row.id)!.position,
        );
      }
      expect(rows().map((r) => r.id)).toEqual(
        expectedRows.map((r) => r.id).sort(),
      );
      console.info(
        "grove-composition-selected-proof",
        JSON.stringify({
          sourcePath: selected.sourcePath,
          sourceSha256: selected.sourceSha256,
          baselineIdentity: identities[0],
          selectedIdentity: identities[1],
          treeCount: rows().length,
          curatedCount: current.length,
          removedIds: GROVE_MOVES.map((m) => m.before),
          addedIds: GROVE_MOVES.map((m) => m.after),
          owner: { x: 5, z: 4 },
          proof,
          completedRoutes,
          cardinalApproaches: 12,
          replayPreserved: true,
          ownerRetiredAndReloaded: true,
          scope:
            "Real server-side resources/collisions and source GLB bounds; no native GPU, wind/branch overlap, visual or performance acceptance.",
        }),
      );
    },
  );
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
      expect(f.world.entities["hot"].has(old[i]!)).toBe(false);
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
