import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { isPositionInsideCombatArena } from "../../../../data/duel-manifest";
import {
  getDuelArenaEgressPosition,
  getDuelArenaLobbyReturnPosition,
} from "../../../../data/arena-grading";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import THREE from "../../../../extras/three/three";
import { PMeshHandle } from "../../../../extras/three/geometryToPxMesh";
import { Collider } from "../../../../nodes/Collider";
import { RigidBody } from "../../../../nodes/RigidBody";
import { getPhysX, loadPhysX } from "../../../../physics/PhysXManager";
import { EntityManager } from "../../entities/EntityManager";
import { ResourceSystem } from "../../entities/ResourceSystem";
import { StationSpawnerSystem } from "../../entities/StationSpawnerSystem";
import { BFSPathfinder } from "../../movement/BFSPathfinder";
import {
  getCardinalAdjacentTiles,
  worldToTile,
  type TileCoord,
} from "../../movement/TileSystem";
import {
  COMPACT_LANDSCAPE_ROCKS_SYSTEM,
  CompactLandscapeRocksSystem,
} from "../CompactLandscapeRocksSystem";
import {
  COMPACT_SERVICE_COURT_SYSTEM,
  CompactServiceCourtSystem,
} from "../CompactServiceCourtSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import { TerrainQuadTree } from "../TerrainQuadTree";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
} from "../TerrainQuadChunkGenerator";
import { TerrainSystem } from "../TerrainSystem";
import {
  HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE as candidate,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as baseline,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";

class CpuServerWorld extends World {
  override get isServer() {
    return true;
  }
}
const saved = {
  config: DataManager["worldConfig"],
  profile: DataManager["worldTerrainProfile"],
  identity: DataManager["worldContentIdentity"],
};
const worlds: World[] = [];
const bodies: RigidBody[] = [];
const owned: { dispose(): void }[] = [];

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
  for (const body of bodies.splice(0)) body.deactivate();
  for (const world of worlds.splice(0)) world.destroy();
  for (const object of owned.splice(0)) object.dispose();
  DataManager["worldConfig"] = saved.config;
  DataManager["worldTerrainProfile"] = saved.profile;
  DataManager["worldContentIdentity"] = saved.identity;
});

function admit(profile: WorldTerrainProfile) {
  DataManager["worldContentIdentity"] = null;
  DataManager.setWorldConfig({
    ...structuredClone(saved.config!),
    terrainProfile: structuredClone(profile),
  });
}

async function terrainFixture(profile: WorldTerrainProfile) {
  admit(profile);
  const world = new CpuServerWorld();
  worlds.push(world);
  await world.physics.init();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  await roads.init();
  await roads.start();
  return { world, terrain, roads };
}

async function resourceFixture(profile: WorldTerrainProfile) {
  const f = await terrainFixture(profile);
  const manager = f.world.register(
    "entity-manager",
    EntityManager,
  ) as EntityManager;
  const resources = f.world.register(
    "resource",
    ResourceSystem,
  ) as ResourceSystem;
  const stations = f.world.register(
    "station-spawner",
    StationSpawnerSystem,
  ) as StationSpawnerSystem;
  const court = f.world.register(
    COMPACT_SERVICE_COURT_SYSTEM,
    CompactServiceCourtSystem,
  ) as CompactServiceCourtSystem;
  const rocks = f.world.register(
    COMPACT_LANDSCAPE_ROCKS_SYSTEM,
    CompactLandscapeRocksSystem,
  ) as CompactLandscapeRocksSystem;
  await resources.init();
  await court.init();
  await rocks.init();
  await f.terrain.start();
  const settle = () =>
    Promise.all([...resources["terrainResourceTails"].values()]);
  await settle();
  await resources["initializeWorldAreaResources"]();
  await settle();
  await stations.start();
  await court.start();
  await rocks.start();
  expect(court.getCourt()).not.toBeNull();
  expect(rocks.getRocks()?.placements).toHaveLength(17);
  expect(f.terrain.getTiles().size).toBe(25);
  expect(
    [...f.terrain.getTiles().values()].filter((tile) => tile.contentGenerated),
  ).toHaveLength(9);
  return { ...f, manager, resources };
}

type Walkable = (tile: TileCoord, from?: TileCoord) => boolean;
function walkability(world: World): Walkable {
  return (tile, from) =>
    tile.x >= 250 &&
    tile.x < 550 &&
    tile.z >= 250 &&
    tile.z < 550 &&
    !isPositionInsideCombatArena(tile.x + 0.5, tile.z + 0.5) &&
    world.collision.isWalkable(tile.x, tile.z) &&
    (!from || !world.collision.isBlocked(from.x, from.z, tile.x, tile.z));
}

function completeRoute(
  start: TileCoord,
  target: TileCoord,
  walkable: Walkable,
  label: string,
) {
  if (!walkable(start) || !walkable(target))
    throw new Error(`${label}: blocked endpoint`);
  const bfs = new BFSPathfinder(),
    seen = new Set<string>();
  const route: TileCoord[] = [{ ...start }];
  let cursor = start;
  for (
    let part = 0;
    part < 12 && (cursor.x !== target.x || cursor.z !== target.z);
    part++
  ) {
    const segment = bfs.findPath(cursor, target, walkable);
    if (!segment.length)
      throw new Error(
        `${label}: empty partial path at ${JSON.stringify(cursor)}`,
      );
    for (const tile of segment) {
      const distance = Math.max(
        Math.abs(tile.x - cursor.x),
        Math.abs(tile.z - cursor.z),
      );
      if (distance !== 1 || !walkable(tile, cursor))
        throw new Error(`${label}: invalid route edge`);
      route.push({ ...tile });
      cursor = tile;
    }
    const key = `${cursor.x},${cursor.z}`;
    if (seen.has(key)) throw new Error(`${label}: partial path cycle`);
    seen.add(key);
  }
  if (cursor.x !== target.x || cursor.z !== target.z)
    throw new Error(`${label}: incomplete route`);
  return route;
}

describe("Haven shoulder: actual native cooking and fresh navigation, not live terrain collision ownership", () => {
  it("cooks both actual retained 128 candidate leaves, matches independent triangle rays and releases native ownership", async () => {
    const { world, terrain } = await terrainFixture(candidate);
    const provider = terrain["buildChunkTerrainProvider"]();
    const physx = getPhysX()!,
      types = new physx.PxActorTypeFlags(
        physx.PxActorTypeFlagEnum.eRIGID_STATIC,
      );
    const initialActors = world.physics.scene!.getNbActors(types);
    const report: object[] = [];
    const tree = new TerrainQuadTree({
      resolution: 16,
      rootChunkRadius: 0,
      fineDetailRegions: createCompactPreparationDetailRegions(
        candidate,
        ALL_WORLD_AREAS,
        64,
      ),
    });
    try {
      tree.update(350, 340);
      const shoulder = candidate.havenShoulder!;
      const leaves = tree
        .getFinalNodes()
        .filter(
          (node) =>
            node.centerX + node.size / 2 > shoulder.minX &&
            node.centerX - node.size / 2 < shoulder.maxX &&
            node.centerZ + node.size / 2 > shoulder.minZ &&
            node.centerZ - node.size / 2 < shoulder.maxZ,
        )
        .sort((a, b) => a.centerX - b.centerX);
      expect(
        leaves.map((node) => [
          node.centerX,
          node.centerZ,
          node.size,
          node.resolution,
        ]),
      ).toEqual([
        [250, 350, 100, 128],
        [350, 350, 100, 128],
      ]);
      // These are the two real candidate quadtree leaves intersecting the modifier.
      // The western leaf is deliberately refined from baseline64 to candidate128.
      // Explicitly cook their geometry here: the current live TerrainSystem still
      // has a separate collision owner/resolution; this is not an integration claim.
      for (const node of leaves) {
        const { id: nodeId, centerX, centerZ, resolution } = node;
        const data = generateQuadChunkDataSync(
          centerX,
          centerZ,
          100,
          resolution,
          provider,
        );
        const { geometry } = assembleQuadChunkGeometry(data, provider, 15);
        owned.push(geometry);
        const material = new THREE.MeshBasicMaterial();
        owned.push(material);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(centerX, 0, centerZ);
        mesh.updateMatrixWorld(true);
        const surface = new RetainedTerrainSurface(
          nodeId,
          provider.terrainProfileIdentity,
          centerX,
          centerZ,
          100,
          resolution,
          geometry,
        );
        const position = geometry.getAttribute("position");
        const probes: [number, number][] = [];
        // Sample both triangles of cells distributed across the entire support,
        // including feather and crest; use the real Float32 grid, not an ideal plane.
        for (let z = 0; z < resolution - 1; z += 3)
          for (let x = 0; x < resolution - 1; x += 3) {
            const a = z * resolution + x;
            for (const [u, v] of [
              [0.2, 0.3],
              [0.8, 0.7],
            ]) {
              const wx =
                centerX +
                position.getX(a) +
                u * (position.getX(a + 1) - position.getX(a));
              const wz =
                centerZ +
                position.getZ(a) +
                v * (position.getZ(a + resolution) - position.getZ(a));
              if (wx >= 270 && wx <= 316 && wz >= 301 && wz <= 369)
                probes.push([wx, wz]);
            }
          }
        // Near both sides of the mixed-resolution seam and the exact feather edges.
        for (const z of [303, 304, 312, 329, 347, 366, 367])
          for (const x of [272, 272.125, 299.999, 300.001, 313.875, 314])
            if (x > centerX - 50 && x < centerX + 50) probes.push([x, z]);
        expect(probes.length).toBeGreaterThan(100);
        const ray = new THREE.Raycaster(),
          origin = new THREE.Vector3(),
          down = new THREE.Vector3(0, -1, 0);
        const sample = { height: 0, nx: 0, ny: 0, nz: 0, faceIndex: 0 };
        for (let lifetime = 0; lifetime < 2; lifetime++) {
          const body = new RigidBody({
            type: "static",
            tag: `haven-retained-${resolution}`,
            position: [centerX, 0, centerZ],
          });
          bodies.push(body);
          const collider = new Collider({
            type: "geometry",
            geometry,
            convex: false,
            layer: "environment",
          });
          body.add(collider);
          body.activate(world);
          const handle = collider.pmesh as PMeshHandle;
          expect(body.actor).toBeTruthy();
          expect(body.actorHandle).toBeTruthy();
          expect(collider.shape).toBeTruthy();
          expect(handle).toBeInstanceOf(PMeshHandle);
          expect(handle.item.refs).toBe(1);
          expect(world.physics.scene!.getNbActors(types)).toBe(
            initialActors + 1,
          );
          let maximumSurfaceError = 0,
            maximumVerticalError = 0;
          for (const [x, z] of probes) {
            origin.set(Math.fround(x), 100, Math.fround(z));
            ray.set(origin, down);
            ray.far = 100;
            const visible = ray.intersectObject(mesh, false)[0];
            expect(visible).toBeTruthy();
            expect(
              surface.sample(origin.x - centerX, origin.z - centerZ, sample),
            ).toBe(true);
            expect(sample.height).toBeCloseTo(visible.point.y, 9);
            const actual = world.physics.raycast(origin, down, 100);
            expect(actual).not.toBeNull();
            const normal = visible
              .face!.normal.clone()
              .transformDirection(mesh.matrixWorld);
            const delta = actual!.point.clone().sub(visible.point);
            const surfaceError = Math.abs(delta.dot(normal));
            // Same eight Float32 world-coordinate ULP bound used by actual rock
            // collision tests. This does not authorize a coarse proxy or height bias.
            const magnitude = Math.max(
              Math.abs(origin.x),
              Math.abs(origin.y),
              Math.abs(origin.z),
            );
            const ulp = 2 ** (Math.floor(Math.log2(magnitude)) - 23);
            expect(surfaceError).toBeLessThanOrEqual(8 * ulp);
            maximumSurfaceError = Math.max(maximumSurfaceError, surfaceError);
            maximumVerticalError = Math.max(
              maximumVerticalError,
              Math.abs(delta.y),
            );
          }
          report.push({
            centerX,
            centerZ,
            resolution,
            lifetime,
            probes: probes.length,
            triangles: geometry.index!.count / 3,
            maximumSurfaceError,
            maximumVerticalError,
          });
          body.deactivate();
          body.deactivate();
          expect(world.physics.scene!.getNbActors(types)).toBe(initialActors);
          expect(handle.released).toBe(true);
          expect(handle.item.refs).toBe(0);
          expect(handle.value).toBeNull();
          // A deliberately absent collider must really miss: this catches a
          // proxy/fallback ground silently satisfying the ray comparison.
          expect(world.physics.raycast(origin, down, 100)).toBeNull();
        }
      }
    } finally {
      tree.dispose();
      physx.destroy(types);
    }
    process.stdout.write(
      JSON.stringify({
        havenRetainedPhysX: report,
        liveTerrainCollisionOwnerExercised: false,
      }) + "\n",
    );
  }, 60000);

  it("retains all 48 actual trees, every free harvest approach and every existing route edge after fresh startup", async () => {
    const starts = [
      { x: 348, z: 322 },
      ...[
        getDuelArenaLobbyReturnPosition(true),
        getDuelArenaLobbyReturnPosition(false),
        getDuelArenaEgressPosition(),
      ].map((p) => worldToTile(p.x, p.z)),
    ];
    const before = await resourceFixture(baseline),
      oldWalkable = walkability(before.world);
    const census = (f: Awaited<ReturnType<typeof resourceFixture>>) =>
      f.resources
        .getAllResources()
        .filter((r) => r.type === "tree")
        .map((r) => {
          const entity = f.manager.getEntity(r.id);
          expect(entity).toBeInstanceOf(ResourceEntity);
          return {
            id: r.id,
            subType: r.subType,
            position: { ...r.position },
            scale: (entity as ResourceEntity).config.modelScale,
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    const original = census(before);
    expect(original).toHaveLength(48);
    expect(new Set(original.map((r) => r.id)).size).toBe(48);
    const approaches = original.map((r) => ({
      id: r.id,
      tiles: getCardinalAdjacentTiles(
        worldToTile(r.position.x, r.position.z),
        1,
        1,
      ).filter((tile) => oldWalkable(tile)),
    }));
    for (const row of approaches)
      expect(row.tiles.length, row.id).toBeGreaterThan(0);
    const routes = starts.flatMap((start) =>
      approaches.flatMap((row) =>
        row.tiles.map((target) => {
          const label = `${row.id}: ${start.x},${start.z} -> ${target.x},${target.z}`;
          const tiles = completeRoute(
            start,
            target,
            oldWalkable,
            `baseline ${label}`,
          );
          return {
            label,
            start,
            target,
            tiles,
            heights: tiles.map((t) =>
              before.terrain.getHeightAt(t.x + 0.5, t.z + 0.5),
            ),
            flags: tiles.map((t) => before.world.collision.getFlags(t.x, t.z)),
          };
        }),
      ),
    );
    // This second world has genuinely fresh resource generation, not transferred
    // entities, cached baseline occupancy, or a hot-swapped sampler.
    const after = await resourceFixture(candidate),
      walkable = walkability(after.world);
    expect(census(after)).toEqual(original);
    const descriptor = candidate.havenShoulder!;
    let routeEdges = 0,
      affectedSamples = 0,
      changedRouteSamples = 0,
      maximumRouteHeightDelta = 0,
      maximumRouteEdgeGrade = 0;
    for (const row of approaches) {
      const tree = original.find((r) => r.id === row.id)!;
      const current = getCardinalAdjacentTiles(
        worldToTile(tree.position.x, tree.position.z),
        1,
        1,
      ).filter((tile) => walkable(tile));
      for (const tile of row.tiles)
        expect(current, row.id).toContainEqual(tile);
    }
    for (const route of routes) {
      let previousHeight = 0;
      for (let index = 0; index < route.tiles.length; index++) {
        const tile = route.tiles[index],
          from = index > 0 ? route.tiles[index - 1] : undefined;
        if (!walkable(tile, from))
          throw new Error(
            `candidate blocked existing edge ${route.label}: ${JSON.stringify({ from, tile })}`,
          );
        expect(
          after.world.collision.getFlags(tile.x, tile.z),
          route.label,
        ).toBe(route.flags[index]);
        const x = tile.x + 0.5,
          z = tile.z + 0.5;
        const height = after.terrain.getHeightAt(x, z),
          delta = Math.abs(height - route.heights[index]);
        if (
          x > descriptor.minX &&
          x < descriptor.maxX &&
          z > descriptor.minZ &&
          z < descriptor.maxZ
        )
          affectedSamples++;
        else expect(height, route.label).toBe(route.heights[index]);
        if (delta > 0) changedRouteSamples++;
        maximumRouteHeightDelta = Math.max(maximumRouteHeightDelta, delta);
        if (from) {
          routeEdges++;
          maximumRouteEdgeGrade = Math.max(
            maximumRouteEdgeGrade,
            Math.abs(height - previousHeight) /
              Math.hypot(tile.x - from.x, tile.z - from.z),
          );
        }
        previousHeight = height;
      }
      completeRoute(
        route.start,
        route.target,
        walkable,
        `candidate ${route.label}`,
      );
    }
    expect(routes.length).toBeGreaterThan(600);
    expect(routeEdges).toBeGreaterThan(10000);
    process.stdout.write(
      JSON.stringify({
        havenFreshNavigation: {
          trees: original.length,
          approaches: approaches.reduce((n, r) => n + r.tiles.length, 0),
          starts,
          completeRoutesPerProfile: routes.length,
          existingRouteEdgesReplayed: routeEdges,
          affectedSamples,
          changedRouteSamples,
          maximumRouteHeightDelta,
          maximumRouteEdgeGrade,
        },
        owners: [
          "terrain",
          "resources",
          "stations",
          "service-court",
          "landscape-rocks",
        ],
        fullGameplayNavigationApproval: false,
      }) + "\n",
    );
  }, 60000);
});
