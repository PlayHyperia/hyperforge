import { afterEach, describe, expect, it } from "vitest";
import { openSync, closeSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { stationDataProvider } from "../../../../data/StationDataProvider";
import {
  getDuelArenaConfig,
  isPositionInsideDuelArenaZone,
} from "../../../../data/duel-manifest";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import type { TerrainResourceSpawnBatch } from "../../../../types/world/terrain";
import type { Resource } from "../../../../types/core/core";
import { ResourceSystem } from "../../entities/ResourceSystem";
import { EntityManager } from "../../entities/EntityManager";
import { BFSPathfinder } from "../../movement/BFSPathfinder";
import { CollisionFlag } from "../../movement/CollisionFlags";
import {
  getCardinalAdjacentTiles,
  worldToTile,
} from "../../movement/TileSystem";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import {
  createCompactIslandPaths,
  compactPathSegmentDistance,
  COMPACT_PATH_BLEND_WIDTH,
} from "../CompactIslandPaths";
import {
  validateTreeAnchor,
  type TreeGenerationSource,
} from "../BiomeResourceGenerator";

class CpuServerWorld extends World {
  override get isServer(): boolean {
    return true;
  }
}
type TerrainInternals = {
  loadFlatZonesFromManifest(): void;
  loadWaterBodiesFromManifest(): void;
  createTreeGenerationSource(x: number, z: number): TreeGenerationSource;
};
type ResourceInternals = {
  initializeWorldAreaResources(): Promise<void>;
  registerTerrainResources(batch: TerrainResourceSpawnBatch): Promise<void>;
  resources: Map<string, Resource>;
};
const worlds: World[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});

async function fixture() {
  expect(DataManager.getInstance().isReady()).toBe(true);
  const world = new CpuServerWorld();
  worlds.push(world);
  const manager = world.register(
    "entity-manager",
    EntityManager,
  ) as EntityManager;
  const resource = world.register("resource", ResourceSystem) as ResourceSystem;
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  await terrain.init();
  const internal = terrain as unknown as TerrainInternals;
  internal.loadWaterBodiesFromManifest();
  internal.loadFlatZonesFromManifest();
  await roads.init();
  await roads.start();
  await resource.init();
  const registration = resource as unknown as ResourceInternals;
  await registration.initializeWorldAreaResources();
  return { world, manager, terrain, roads, internal, registration };
}

// Exact hydrated LOD0 GLB headers are read, not model-bounds.json (which omits
// some source node scales). This is conservative transformed declared geometry,
// not alpha silhouettes, wind, decoded GPU data or visual acceptance.
type GlbDocument = {
  scene?: number;
  scenes: { nodes: number[] }[];
  nodes: {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
  }[];
  meshes: {
    primitives: { attributes: { POSITION: number }; indices?: number }[];
  }[];
  accessors: {
    min?: [number, number, number];
    max?: [number, number, number];
    count: number;
  }[];
};
function modelBounds(asset: string, scale = 1) {
  const relative = asset.replace(/^asset:\/\//, "");
  expect(relative).toMatch(/^models\/(trees|stations)\/[^.]+\.glb$/);
  const filename = fileURLToPath(
    new URL(
      `../../../../../../server/world/assets/${relative}`,
      import.meta.url,
    ),
  );
  const fd = openSync(filename, "r");
  let document: GlbDocument;
  try {
    const header = Buffer.alloc(20);
    expect(readSync(fd, header, 0, 20, 0)).toBe(20);
    expect(header.readUInt32LE(0)).toBe(0x46546c67);
    expect(header.readUInt32LE(4)).toBe(2);
    expect(header.readUInt32LE(16)).toBe(0x4e4f534a);
    const bytes = header.readUInt32LE(12);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    const json = Buffer.alloc(bytes);
    expect(readSync(fd, json, 0, bytes, 20)).toBe(bytes);
    document = JSON.parse(json.toString("utf8")) as GlbDocument;
  } finally {
    closeSync(fd);
  }
  const box = new THREE.Box3();
  let triangles = 0,
    primitives = 0;
  function visit(index: number, parent: THREE.Matrix4) {
    const node = document.nodes[index];
    const local = node.matrix
      ? new THREE.Matrix4().fromArray(node.matrix)
      : new THREE.Matrix4().compose(
          new THREE.Vector3(...(node.translation ?? [0, 0, 0])),
          new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
          new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
        );
    const matrix = parent.clone().multiply(local);
    if (node.mesh !== undefined)
      for (const primitive of document.meshes[node.mesh].primitives) {
        const position = document.accessors[primitive.attributes.POSITION];
        if (!position.min || !position.max)
          throw new Error("GLB position bounds required");
        const primitiveBox = new THREE.Box3(
          new THREE.Vector3(...position.min),
          new THREE.Vector3(...position.max),
        ).applyMatrix4(matrix);
        box.union(primitiveBox);
        triangles +=
          (primitive.indices === undefined
            ? position.count
            : document.accessors[primitive.indices].count) / 3;
        primitives++;
      }
    for (const child of node.children ?? []) visit(child, matrix);
  }
  for (const index of document.scenes[document.scene ?? 0].nodes)
    visit(index, new THREE.Matrix4().makeScale(scale, scale, scale));
  expect(box.isEmpty()).toBe(false);
  return {
    box,
    radius: Math.hypot(
      Math.max(Math.abs(box.min.x), Math.abs(box.max.x)),
      Math.max(Math.abs(box.min.z), Math.abs(box.max.z)),
    ),
    triangles,
    primitives,
  };
}

const EXPECTED = [
  {
    id: "tree_367_311",
    area: "central_haven",
    species: "general",
    x: 366.5,
    z: 322.5,
    model: "general_04.glb",
  },
  {
    id: "tree_373_313",
    area: "preparation_training_grounds",
    species: "oak",
    x: 318.5,
    z: 312.5,
    model: "oak_01.glb",
  },
  {
    id: "tree_379_311",
    area: "preparation_training_grounds",
    species: "maple",
    x: 323.5,
    z: 288.5,
    model: "maple_01.glb",
  },
  {
    id: "tree_379_304",
    area: "preparation_training_grounds",
    species: "mahogany",
    x: 381.5,
    z: 329.5,
    model: "mahogany_01.glb",
  },
  {
    id: "tree_375_299",
    area: "preparation_training_grounds",
    species: "magic",
    x: 318.5,
    z: 344.5,
    model: "magic_02.glb",
  },
] as const;

describe("real authored functional grove relocation", () => {
  it("retains exact five IDs, source species/scale, original policy areas and safe grounded cardinal approaches", async () => {
    const { world, manager, terrain, internal, registration } = await fixture();
    const trees = [...registration.resources.values()].filter(
      (row) => row.type === "tree",
    );
    expect(trees.map((row) => row.id).sort()).toEqual(
      EXPECTED.map((row) => row.id).sort(),
    );
    expect(ALL_WORLD_AREAS.central_haven.bounds).toEqual({
      minX: 332,
      maxX: 368,
      minZ: 302,
      maxZ: 338,
    });
    expect(ALL_WORLD_AREAS.preparation_training_grounds.bounds).toEqual({
      minX: 314,
      maxX: 386,
      minZ: 284,
      maxZ: 356,
    });
    expect(ALL_WORLD_AREAS.central_haven.safeZone).toBe(true);
    expect(ALL_WORLD_AREAS.preparation_training_grounds.safeZone).toBe(false);
    const paths = createCompactIslandPaths(
      terrain.getWorldTerrainProfile(),
      ALL_WORLD_AREAS,
      getDuelArenaConfig(),
      terrain.getResourceGroundHeight.bind(terrain),
    );
    const stations = Object.values(ALL_WORLD_AREAS)
      .flatMap((area) => area.stations ?? [])
      .map((row) => {
        const definition = stationDataProvider.getStationData(row.type)!;
        return {
          ...row,
          radius: definition.model
            ? modelBounds(definition.model, definition.modelScale).radius
            : 1,
        };
      });
    const npcs = Object.values(ALL_WORLD_AREAS).flatMap(
      (area) => area.npcs ?? [],
    );
    const receipt = [];
    for (const expected of EXPECTED) {
      // Preserve the existing launch-preflight preparation route envelope.
      const hub = ALL_WORLD_AREAS.central_haven.bounds;
      expect(
        Math.max(
          Math.abs(expected.x - (hub.minX + hub.maxX) / 2),
          Math.abs(expected.z - (hub.minZ + hub.maxZ) / 2),
        ),
        `${expected.id} preparation route envelope`,
      ).toBeLessThanOrEqual(32);
      const area = ALL_WORLD_AREAS[expected.area];
      const entry = area.resources.find(
        (row) => row.instanceId === expected.id,
      )!;
      expect(entry.resourceId).toBe(`tree_${expected.species}`);
      const entity = manager.getEntity(expected.id);
      expect(entity).toBeInstanceOf(ResourceEntity);
      if (!(entity instanceof ResourceEntity))
        throw new Error("Actual tree missing");
      expect(entity.position.x).toBe(expected.x);
      expect(entity.position.z).toBe(expected.z);
      expect(entity.position.y).toBe(
        terrain.getResourceGroundHeight(expected.x, expected.z),
      );
      expect(entity.config.modelScale).toBe(1);
      const variants = entity.config.modelVariants!;
      const hash =
        (entity as unknown as { hashString(s: string): number }).hashString(
          expected.id,
        ) >>> 0;
      const model = variants[hash % variants.length];
      expect(model).toContain(expected.model);
      const bounds = modelBounds(model, entity.config.modelScale);
      const source = internal.createTreeGenerationSource(
        Math.floor((expected.x + 50) / 100),
        Math.floor((expected.z + 50) / 100),
      );
      const admission = validateTreeAnchor(
        source,
        expected.x,
        expected.z,
        isPositionInsideDuelArenaZone,
      );
      expect(admission.rejection, expected.id).toBeNull();
      const roadMargin = Math.min(
        ...paths.flatMap((path) =>
          path.path
            .slice(1)
            .map(
              (end, i) =>
                compactPathSegmentDistance(expected, path.path[i], end) -
                path.width / 2 -
                COMPACT_PATH_BLEND_WIDTH -
                bounds.radius,
            ),
        ),
      );
      const stationMargin = Math.min(
        ...stations.map(
          (station) =>
            Math.hypot(
              expected.x - station.position.x,
              expected.z - station.position.z,
            ) -
            station.radius -
            bounds.radius -
            1,
        ),
      );
      const npcMargin = Math.min(
        ...npcs.map(
          (npc) =>
            Math.hypot(
              expected.x - npc.position.x,
              expected.z - npc.position.z,
            ) -
            bounds.radius -
            1.5,
        ),
      );
      const pondMargin =
        Math.hypot(expected.x - 343, expected.z - 302) - 11 - bounds.radius;
      if (Math.min(roadMargin, stationMargin, npcMargin, pondMargin) <= 0) {
        const candidates = [];
        for (let x = area.bounds.minX + 1.5; x < area.bounds.maxX - 1; x++) {
          for (let z = area.bounds.minZ + 1.5; z < area.bounds.maxZ - 1; z++) {
            if (Math.max(Math.abs(x - 350), Math.abs(z - 320)) > 32) continue;
            const point = { x, z };
            const margin = Math.min(
              ...paths.flatMap((path) =>
                path.path
                  .slice(1)
                  .map(
                    (end, i) =>
                      compactPathSegmentDistance(point, path.path[i], end) -
                      path.width / 2 -
                      COMPACT_PATH_BLEND_WIDTH -
                      bounds.radius,
                  ),
              ),
              ...stations.map(
                (station) =>
                  Math.hypot(x - station.position.x, z - station.position.z) -
                  station.radius -
                  bounds.radius -
                  1,
              ),
              ...npcs.map(
                (npc) =>
                  Math.hypot(x - npc.position.x, z - npc.position.z) -
                  bounds.radius -
                  1.5,
              ),
              Math.hypot(x - 343, z - 302) - 11 - bounds.radius,
            );
            if (
              margin <= 0 ||
              validateTreeAnchor(source, x, z, isPositionInsideDuelArenaZone)
                .rejection
            )
              continue;
            candidates.push({ x, z, margin });
          }
        }
        candidates.sort((a, b) => b.margin - a.margin);
        console.info(
          "[Rejected grove placement alternatives]",
          JSON.stringify({
            id: expected.id,
            radius: bounds.radius,
            candidates: candidates.slice(0, 8),
          }),
        );
      }
      expect(roadMargin, `${expected.id} road crown margin`).toBeGreaterThan(0);
      expect(
        stationMargin,
        `${expected.id} station crown margin`,
      ).toBeGreaterThan(0);
      expect(npcMargin, `${expected.id} NPC crown margin`).toBeGreaterThan(0);
      expect(pondMargin, `${expected.id} pond envelope margin`).toBeGreaterThan(
        0,
      );
      const anchor = worldToTile(expected.x, expected.z);
      expect(
        world.collision.hasFlags(anchor.x, anchor.z, CollisionFlag.BLOCKED),
      ).toBe(true);
      const approaches = getCardinalAdjacentTiles(anchor, 1, 1);
      expect(approaches).toHaveLength(4);
      for (const tile of approaches) {
        const x = tile.x + 0.5,
          z = tile.z + 0.5;
        expect(x).toBeGreaterThanOrEqual(area.bounds.minX);
        expect(x).toBeLessThan(area.bounds.maxX);
        expect(z).toBeGreaterThanOrEqual(area.bounds.minZ);
        expect(z).toBeLessThan(area.bounds.maxZ);
        expect(world.collision.isWalkable(tile.x, tile.z)).toBe(true);
        expect(
          validateTreeAnchor(source, x, z, isPositionInsideDuelArenaZone)
            .rejection,
        ).toBeNull();
        // Actual BFS and collision matrix; cached deterministic terrain predicates
        // admit land, not an always-true fake navigation callback. No live NPC motion.
        const cache = new Map<string, boolean>();
        const pathfinder = new BFSPathfinder();
        const isWalkable: Parameters<BFSPathfinder["findPath"]>[2] = (
          candidate,
          from,
        ) => {
          const key = `${candidate.x},${candidate.z}`;
          let safe = cache.get(key);
          if (safe === undefined) {
            const wx = candidate.x + 0.5,
              wz = candidate.z + 0.5;
            const h = terrain.getResourceGroundHeight(wx, wz);
            const water = terrain
              .getWaterBodyRegistry()
              .getWaterSurfaceAt(wx, wz);
            safe =
              wx >= 314 &&
              wx < 386 &&
              wz >= 284 &&
              wz < 348 &&
              h > water + 1 &&
              world.collision.isWalkable(candidate.x, candidate.z);
            cache.set(key, safe);
          }
          return (
            safe &&
            (!from ||
              !world.collision.isBlocked(
                from.x,
                from.z,
                candidate.x,
                candidate.z,
              ))
          );
        };
        // Respect the real per-search cap. Long routes are continued by the
        // movement owner; this checks bounded geometric reachability, not its
        // tick scheduler, live NPC occupancy or a complete server walking run.
        let current = { x: 348, z: 321 };
        const endpoints = new Set<string>();
        for (let segment = 0; segment < 8; segment++) {
          if (current.x === tile.x && current.z === tile.z) break;
          const route = pathfinder.findPath(current, tile, isWalkable);
          expect(route.length, expected.id).toBeGreaterThan(0);
          const end = route.at(-1)!;
          for (const step of route) {
            expect(
              Math.max(
                Math.abs(step.x - current.x),
                Math.abs(step.z - current.z),
              ),
            ).toBeLessThanOrEqual(1);
            expect(isWalkable(step, current)).toBe(true);
            current = step;
          }
          const key = `${end.x},${end.z}`;
          expect(
            endpoints.has(key),
            `${expected.id} stalled partial route`,
          ).toBe(false);
          endpoints.add(key);
          current = end;
          if (!pathfinder.wasLastPathPartial()) break;
        }
        expect(current).toEqual(tile);
      }
      receipt.push({
        id: expected.id,
        x: expected.x,
        z: expected.z,
        y: admission.position.y,
        model,
        triangles: bounds.triangles,
        primitives: bounds.primitives,
        bounds: {
          min: bounds.box.min.toArray(),
          max: bounds.box.max.toArray(),
        },
        roadMargin,
        stationMargin,
        npcMargin,
        pondMargin,
        approaches: approaches.length,
      });
    }
    console.info(
      "[AuthoredResourceGrove actual CPU receipt]",
      JSON.stringify(receipt),
    );
  });

  it("never accepts procedural overrides or relocates a live same-ID authored owner", async () => {
    const { manager, registration } = await fixture();
    const entity = manager.getEntity(EXPECTED[0].id)!;
    const point = {
      type: "tree" as const,
      subType: "general" as const,
      instanceId: EXPECTED[0].id,
      position: { x: 365.5, y: 0, z: 322.5 },
    };
    await expect(
      registration.registerTerrainResources({
        spawnPoints: [point],
        owner: { tileX: 4, tileZ: 3 },
      }),
    ).rejects.toThrow("only for authored trees");
    await expect(
      registration.registerTerrainResources({
        spawnPoints: [point],
        isManifest: true,
      }),
    ).rejects.toThrow("Conflicting registration");
    expect(manager.getEntity(entity.id)).toBe(entity);
    expect(entity.position.x).toBe(366.5);
  });
});
