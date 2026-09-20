import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import type { FlatZone } from "../../../../types/world/terrain";
import type {
  CompactPondDocksManifest,
  WorldArea,
  WorldConfigManifest,
} from "../../../../types/world/world-types";
import { getPhysX, loadPhysX } from "../../../../physics/PhysXManager";
import THREE from "../../../../extras/three/three";
import { TerrainSystem } from "../TerrainSystem";
import { ProceduralDocks } from "../ProceduralDocks";
import type { ElevatedWaterBody } from "../WaterBodyRegistry";
import {
  groundCompactPondDock,
  POND_DOCK_SURFACE,
  type GroundedPondDock,
} from "../CompactPondDockLayout";
import { getCompactPondDockDirection } from "../DockDefinition";
import { CollisionFlag, CollisionMask } from "../../movement/CollisionFlags";
import { BFSPathfinder } from "../../movement/BFSPathfinder";
import {
  DockGenerator,
  DEFAULT_DOCK_PARAMS,
} from "@hyperforge/procgen/items/dock";

const candidate = JSON.parse(
  readFileSync(
    new URL(
      "../__fixtures__/inland-pond-basin-candidate.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  flatZone: FlatZone;
  waterBody: Omit<ElevatedWaterBody, "radiusSq" | "sourceType">;
};
const layout: CompactPondDocksManifest = {
  schemaVersion: 1,
  layoutId: "compact-pond-docks-v1",
  terrainProfileId: "compact-duel-island-v6",
  waterBodyId: "haven_pond_water",
  docks: [
    {
      id: "haven-fishing-landing",
      x: 390,
      z: 424.5,
      rotation: 90,
      recipeId: "haven-fishing-landing-v1",
    },
    {
      id: "haven-reed-jetty",
      x: 433,
      z: 415.5,
      rotation: 270,
      recipeId: "haven-reed-jetty-v1",
    },
  ],
};
const saved = {
  config: DataManager["worldConfig"],
  profile: DataManager["worldTerrainProfile"],
  identity: DataManager["worldContentIdentity"],
};
const worlds: World[] = [];
const areas = new Map<string, WorldArea>();
const nativeReleases: (() => void)[] = [];

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
  const failures: unknown[] = [];
  const release = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      failures.push(error);
    }
  };
  for (const world of worlds.splice(0)) {
    release(() => world.getSystem<ProceduralDocks>("docks")?.destroy());
    release(() => world.destroy());
  }
  for (const releaseNative of nativeReleases.splice(0)) release(releaseNative);
  for (const [key, original] of areas) ALL_WORLD_AREAS[key] = original;
  areas.clear();
  DataManager["worldConfig"] = saved.config;
  DataManager["worldTerrainProfile"] = saved.profile;
  DataManager["worldContentIdentity"] = saved.identity;
  if (failures.length)
    throw new AggregateError(failures, "Dock test cleanup failed");
});

async function fixture(
  options: {
    native?: boolean;
    terrain?: boolean;
    water?: boolean;
    configured?: boolean;
  } = {},
) {
  await DataManager.getInstance().initialize();
  const entry = Object.entries(ALL_WORLD_AREAS).find(([, area]) =>
    area.flatZones?.some((zone) => zone.id === "haven_pond_floor"),
  );
  if (!entry) throw new Error("Missing actual pond area fixture");
  const [key, original] = entry;
  areas.set(key, original);
  ALL_WORLD_AREAS[key] = {
    ...structuredClone(original),
    flatZones: [
      ...(original.flatZones ?? []).filter(
        (zone) => zone.id !== "haven_pond_floor",
      ),
      structuredClone(candidate.flatZone),
    ],
    waterBodies: [
      ...(original.waterBodies ?? []).filter(
        (body) => body.id !== "haven_pond_water",
      ),
      structuredClone(candidate.waterBody),
    ],
  };
  DataManager["worldContentIdentity"] = null;
  const config: WorldConfigManifest = structuredClone(saved.config!);
  if (options.configured === false) delete config.compactPondDocks;
  else config.compactPondDocks = structuredClone(layout);
  DataManager.setWorldConfig(config);
  const world = new World();
  worlds.push(world);
  if (options.native !== false) await world.physics.init();
  const terrain =
    options.terrain === false
      ? null
      : (world.register("terrain", TerrainSystem) as TerrainSystem);
  if (terrain) {
    await terrain.init();
    if (options.water !== false) terrain["loadWaterBodiesFromManifest"]();
    terrain["loadFlatZonesFromManifest"]();
  }
  const owner = world.register("docks", ProceduralDocks) as ProceduralDocks;
  await owner.init();
  return { world, terrain, owner };
}

function actorCount(world: World): () => number {
  const px = getPhysX()!;
  const types = new px.PxActorTypeFlags(px.PxActorTypeFlagEnum.eRIGID_STATIC);
  nativeReleases.push(() => px.destroy(types));
  return () => world.physics.scene!.getNbActors(types);
}
function records(terrain: TerrainSystem): readonly GroundedPondDock[] {
  const body = terrain
    .getWaterBodyRegistry()
    .getAllBodies()
    .find((body) => body.id === layout.waterBodyId)!;
  const ground = terrain.captureCanonicalGroundLease();
  return layout.docks.map((dock) => groundCompactPondDock(dock, body, ground));
}
function point(record: GroundedPondDock, forward: number, across: number) {
  const direction = getCompactPondDockDirection(record.descriptor.rotation);
  return {
    x: record.descriptor.x + direction.x * forward - direction.z * across,
    z: record.descriptor.z + direction.z * forward + direction.x * across,
  };
}
function collisionSnapshot(world: World, entries: readonly GroundedPondDock[]) {
  return entries.map((entry) => {
    const rows: number[] = [];
    for (let x = entry.bounds.minX - 1; x <= entry.bounds.maxX; x++)
      for (let z = entry.bounds.minZ - 1; z <= entry.bounds.maxZ; z++)
        rows.push(world.collision.getFlags(x, z));
    return rows;
  });
}
function grassSnapshot(terrain: TerrainSystem) {
  return terrain["getTerrainSurfaceForRegion"](380, 405, 440, 435);
}
function captureMeshDisposals(world: World) {
  const disposals = new Map<THREE.BufferGeometry, number>();
  const capture = (event: { child: THREE.Object3D }) => {
    if (
      !(event.child instanceof THREE.Mesh) ||
      !event.child.name.startsWith("PondDock_")
    )
      return;
    const geometry = event.child.geometry;
    disposals.set(geometry, 0);
    geometry.addEventListener("dispose", () =>
      disposals.set(geometry, disposals.get(geometry)! + 1),
    );
  };
  world.stage.scene.addEventListener("childadded", capture);
  return disposals;
}

describe("actual procedural pond dock ownership and native collision (not rendered acceptance)", () => {
  it("keeps non-compact generated geometry on the historical zero-mask wood path", async () => {
    const { owner } = await fixture({ configured: false });
    const recipe = {
      ...DEFAULT_DOCK_PARAMS,
      widthRange: [3, 3] as [number, number],
      lengthRange: [6, 6] as [number, number],
    };
    const generated = new DockGenerator().generate(
      recipe,
      {
        position: { x: 390, y: 25, z: 424.5 },
        waterwardNormal: { x: 1, z: 0 },
        landwardNormal: { x: -1, z: 0 },
        height: 25,
        slope: 0,
        distanceFromCenter: 0,
      },
      { seed: "legacy-dock-timber-control", waterLevel: 24.6, skipMesh: true },
    );
    const mesh = owner["buildDockMeshWorldSpace"](
      generated,
      recipe,
      24.6,
      21.6,
    );
    expect(mesh).not.toBeNull();
    try {
      const geometry = mesh!.geometry;
      expect(
        Array.from(geometry.getAttribute("dockTimberCoord").array).every(
          (value) => value === 0,
        ),
      ).toBe(true);
      expect(
        Array.from(geometry.getAttribute("dockTimberAxis").array).every(
          (value) => value === 0,
        ),
      ).toBe(true);
      const position = geometry.getAttribute("position");
      const normal = geometry.getAttribute("normal");
      for (let forward = 0; forward <= 12; forward++)
        for (let across = 0; across <= 3; across++) {
          const index = forward * 4 + across;
          expect([
            position.getX(index),
            position.getY(index),
            position.getZ(index),
          ]).toEqual([390 + forward * 0.5, 25, 423 + across]);
          expect([
            normal.getX(index),
            normal.getY(index),
            normal.getZ(index),
          ]).toEqual([0, 1, 0]);
        }
    } finally {
      mesh?.geometry.dispose();
    }
  });

  it("closes every fitted timber plank below the byte-exact retained top without changing its walking surface", async () => {
    const { world, terrain, owner } = await fixture();
    const entries = records(terrain!);
    await owner.start();
    const sharedMaterials = new Set<THREE.Material>();
    let upwardRays = 0;
    for (const entry of entries) {
      const mesh = world.stage.scene.getObjectByName(
        `PondDock_${entry.descriptor.id}`,
      );
      if (!(mesh instanceof THREE.Mesh) || Array.isArray(mesh.material))
        throw new Error("Expected one actual merged dock mesh/material");
      sharedMaterials.add(mesh.material);
      const geometry = mesh.geometry;
      const position = geometry.getAttribute("position");
      const index = geometry.getIndex()!;
      expect(
        Array.from(position.array.slice(0, entry.positions.length)),
      ).toEqual(Array.from(entry.positions));
      expect(Array.from(index.array.slice(0, entry.indices.length))).toEqual(
        Array.from(entry.indices),
      );
      expect(geometry.groups).toHaveLength(0);
      expect(mesh.material.transparent).toBe(false);
      expect(mesh.material.opacity).toBe(1);
      const coord = geometry.getAttribute("dockTimberCoord");
      const axis = geometry.getAttribute("dockTimberAxis");
      expect(coord.count).toBe(position.count);
      expect(axis.count).toBe(position.count);
      expect(Array.from(coord.array).every(Number.isFinite)).toBe(true);
      expect(Array.from(axis.array).every(Number.isFinite)).toBe(true);
      const direction = getCompactPondDockDirection(entry.descriptor.rotation);
      for (let i = 0; i < entry.positions.length / 3; i++) {
        expect(coord.getW(i)).toBe(1);
        expect(coord.getZ(i)).toBe(0);
        expect([axis.getX(i), axis.getY(i), axis.getZ(i)]).toEqual([
          -direction.z,
          0,
          direction.x,
        ]);
      }
      let verticalMemberVertices = 0;
      for (let i = 0; i < axis.count; i++) {
        expect(Math.hypot(axis.getX(i), axis.getY(i), axis.getZ(i))).toBe(1);
        if (coord.getW(i) === 2 && axis.getY(i) === 1) verticalMemberVertices++;
      }
      expect(verticalMemberVertices).toBeGreaterThan(0);

      // Every source row has 12 original top triangles and40 added bottom/side
      // triangles. Coordinate-welded edges must occur twice with opposite
      // directions, proving closed oriented solids (not merely an opaque top).
      const plankGeometry = owner["buildCompactDockPlanks"](entry);
      try {
        const pp = plankGeometry.getAttribute("position");
        const pi = plankGeometry.getIndex()!;
        expect(pp.count).toBe(1239);
        expect(pi.count / 3).toBe(832);
        for (let row = 0; row < 16; row++) {
          const edges = new Map<
            string,
            { count: number; orientation: number }
          >();
          let volume = 0;
          const reference = new THREE.Vector3().fromBufferAttribute(
            pp,
            row * 7,
          );
          for (const [start, count] of [
            [row * 36, 36],
            [entry.indices.length + row * 120, 120],
          ]) {
            for (let i = start; i < start + count; i += 3) {
              const vertices = [0, 1, 2].map((corner) =>
                new THREE.Vector3().fromBufferAttribute(
                  pp,
                  pi.getX(i + corner),
                ),
              );
              const normal = vertices[1]
                .clone()
                .sub(vertices[0])
                .cross(vertices[2].clone().sub(vertices[0]));
              expect(normal.lengthSq()).toBeGreaterThan(0);
              volume +=
                vertices[0]
                  .clone()
                  .sub(reference)
                  .dot(
                    vertices[1]
                      .clone()
                      .sub(reference)
                      .cross(vertices[2].clone().sub(reference)),
                  ) / 6;
              const keys = vertices.map((p) => `${p.x},${p.y},${p.z}`);
              for (let edge = 0; edge < 3; edge++) {
                const a = keys[edge],
                  b = keys[(edge + 1) % 3];
                const key = a < b ? `${a}|${b}` : `${b}|${a}`;
                const value = edges.get(key) ?? { count: 0, orientation: 0 };
                value.count++;
                value.orientation += a < b ? 1 : -1;
                edges.set(key, value);
              }
            }
          }
          expect(
            [...edges.values()].every(
              ({ count, orientation }) => count === 2 && orientation === 0,
            ),
          ).toBe(true);
          // Float32 Y extrusion can differ by half an ULP per vertex.
          const volumeErrorBound =
            3 * 0.5 * 2 ** (Math.floor(Math.log2(entry.deckY)) - 24);
          expect(
            Math.abs(volume - 3 * 0.5 * POND_DOCK_SURFACE.boardThickness),
          ).toBeLessThanOrEqual(volumeErrorBound);
        }
      } finally {
        plankGeometry.dispose();
      }

      mesh.updateMatrixWorld(true);
      const ray = new THREE.Raycaster(
        new THREE.Vector3(),
        new THREE.Vector3(0, 1, 0),
      );
      // Clear of the existing transverse beams and posts: test the actual
      // merged mesh AND native actor from below, including the fitted apron.
      for (const forward of [
        -1.75, -1.25, -0.75, -0.25, 0.25, 1.25, 2.25, 3.75, 4.75, 5.75,
      ]) {
        const p = point(entry, forward, 0);
        const expected =
          entry.heightAt(p.x, p.z)! - POND_DOCK_SURFACE.boardThickness;
        ray.ray.origin.set(p.x, expected - 0.25, p.z);
        const visible = ray.intersectObject(mesh, false);
        expect(visible.length).toBeGreaterThan(0);
        const tolerance =
          8 * 2 ** (Math.floor(Math.log2(Math.abs(expected))) - 23);
        expect(Math.abs(visible[0].point.y - expected)).toBeLessThanOrEqual(
          tolerance,
        );
        const physical = world.physics.raycast(
          ray.ray.origin,
          ray.ray.direction,
          1,
        );
        expect(physical).not.toBeNull();
        expect(Math.abs(physical!.point.y - expected)).toBeLessThanOrEqual(
          tolerance,
        );
        upwardRays++;
      }
    }
    expect(sharedMaterials.size).toBe(1);
    console.info(
      "actual-pond-dock-timber",
      JSON.stringify({
        planksPerDock: 16,
        platformTriangles: 832,
        addedTrianglesPerDock: 640,
        upwardMergedAndNativeRays: upwardRays,
        retainedTop: "byte-exact position/index prefix",
        sharedMaterialCount: sharedMaterials.size,
        nativeVisualAcceptance: false,
      }),
    );
  });

  it("publishes two real native meshes once, agrees with fitted ramp/deck heights, and disposes only owned resources", async () => {
    const { world, terrain: maybeTerrain, owner } = await fixture();
    const terrain = maybeTerrain!;
    const entries = records(terrain),
      count = actorCount(world),
      beforeActors = count();
    const beforeGrass = grassSnapshot(terrain),
      beforeCollision = collisionSnapshot(world, entries);
    const beforeChildren = [...world.stage.scene.children];
    const ground = terrain.captureCanonicalGroundLease();
    const groundSamples = entries.map((entry) =>
      entry.tiles.map((tile) =>
        ground.sampleHeight(tile.x + 0.5, tile.z + 0.5),
      ),
    );
    const disposals = captureMeshDisposals(world);
    await owner.start();
    const diagnostics = owner.getCompactDiagnostics();
    expect(diagnostics).toHaveLength(2);
    expect(count()).toBe(beforeActors + 2);
    expect(world.stage.scene.children.length).toBe(beforeChildren.length + 2);
    expect(
      grassSnapshot(terrain).exclusionPolygons?.filter((p) =>
        p.id.startsWith("pond-dock-"),
      ),
    ).toHaveLength(2);
    let rays = 0,
      maximumNativeError = 0;
    for (const [index, entry] of entries.entries()) {
      expect(diagnostics[index]).toMatchObject({
        id: entry.descriptor.id,
        recipeId: entry.descriptor.recipeId,
        waterBodyId: layout.waterBodyId,
        deckY: entry.deckY,
        tiles: 24,
        railSegments: entry.rails.length,
        physicsActor: true,
        physicsShape: true,
      });
      expect(diagnostics[index].vertices).toBeGreaterThan(119);
      expect(diagnostics[index].triangles).toBeGreaterThan(192);
      const mesh = world.stage.scene.getObjectByName(
        `PondDock_${entry.descriptor.id}`,
      );
      expect(mesh).toBeInstanceOf(THREE.Mesh);
      mesh!.updateMatrixWorld(true);
      const visibleRay = new THREE.Raycaster(
        new THREE.Vector3(),
        new THREE.Vector3(0, -1, 0),
      );
      const probes = [
        -1.875, -1.625, -1.125, -0.625, -0.125, 0.125, 0.5, 1.3, 2.3, 3.3, 4.3,
        5.3, 5.875,
      ].flatMap((forward) =>
        [-0.75, 0, 0.75].map((across) => ({ forward, across })),
      );
      // Probe the front cap/shaft footprint as well as the unobstructed deck.
      probes.push(
        ...[-0.225, -0.125].flatMap((forward) =>
          [-1.14, 1.14].map((across) => ({ forward, across })),
        ),
      );
      for (const { forward, across } of probes) {
        const p = point(entry, forward, across),
          expected = entry.heightAt(p.x, p.z)!;
        expect(owner.getDeckHeightAtSmooth(p.x, p.z)).toBe(expected);
        expect(terrain.getHeightAt(p.x, p.z)).toBe(expected);
        expect(terrain.getResourceGroundHeight(p.x, p.z)).toBe(
          ground.sampleHeight(p.x, p.z),
        );
        const origin = new THREE.Vector3(p.x, expected + 3, p.z),
          down = new THREE.Vector3(0, -1, 0);
        visibleRay.ray.origin.copy(origin);
        const visible = visibleRay.intersectObject(mesh!, false);
        expect(visible.length).toBeGreaterThan(0);
        expect(Math.abs(visible[0].point.y - expected)).toBeLessThan(1e-10);
        const native = world.physics.raycast(origin, down, 6);
        expect(native).not.toBeNull();
        const error = Math.abs(native!.point.y - expected);
        // Fixed eight-Float32-ULP physical-ray gate, not a fitted tolerance.
        expect(error).toBeLessThanOrEqual(
          8 * 2 ** (Math.floor(Math.log2(Math.abs(expected))) - 23),
        );
        maximumNativeError = Math.max(maximumNativeError, error);
        rays++;
      }
      for (const tile of entry.tiles) {
        expect(owner.isDockTile(tile.x, tile.z)).toBe(true);
        expect(owner.getDeckHeightAt(tile.x, tile.z)).toBe(
          entry.heightAt(tile.x + 0.5, tile.z + 0.5),
        );
      }
      for (const [forward, across] of [
        [-2.01, 0],
        [6.01, 0],
        [2, -1.51],
        [2, 1.51],
      ]) {
        const p = point(entry, forward, across);
        expect(owner.getDeckHeightAtSmooth(p.x, p.z)).toBeNull();
      }
    }
    await owner.start();
    expect(owner.getCompactDiagnostics()).toEqual(diagnostics);
    expect(count()).toBe(beforeActors + 2);
    expect(world.stage.scene.children.length).toBe(beforeChildren.length + 2);
    expect(ground.isCurrent()).toBe(true);
    expect(
      entries.map((entry) =>
        entry.tiles.map((tile) =>
          terrain.getResourceGroundHeight(tile.x + 0.5, tile.z + 0.5),
        ),
      ),
    ).toEqual(groundSamples);
    console.info(
      "actual-pond-dock-native",
      JSON.stringify({
        actors: 2,
        docks: diagnostics,
        rays,
        maximumNativeError,
        physicalGate: "8 Float32 ULP",
      }),
    );
    owner.destroy();
    owner.destroy();
    expect(count()).toBe(beforeActors);
    expect(owner.getCompactDiagnostics()).toEqual([]);
    expect(world.stage.scene.children).toEqual(beforeChildren);
    expect(grassSnapshot(terrain)).toEqual(beforeGrass);
    expect(collisionSnapshot(world, entries)).toEqual(beforeCollision);
    expect(disposals.size).toBe(2);
    expect([...disposals.values()]).toEqual([1, 1]);
    expect(owner.isStarted()).toBe(false);
    expect(owner.isInitialized()).toBe(false);
    for (const entry of entries)
      for (const tile of entry.tiles)
        expect(owner.getDeckHeightAt(tile.x, tile.z)).toBeNull();
  });

  it("routes actual BFS onto both decks, retains dual-tile rails and latest terrain/occupancy flags", async () => {
    const { world, terrain: maybeTerrain, owner } = await fixture();
    const terrain = maybeTerrain!,
      entries = records(terrain);
    const terrainMask = CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE;
    for (const entry of entries) {
      const { minX, maxX, minZ, maxZ } = entry.bounds;
      for (let x = minX - 2; x < maxX + 2; x++)
        for (let z = minZ - 2; z < maxZ + 2; z++)
          world.collision.setFlags(
            x,
            z,
            terrain.getResourceGroundHeight(x + 0.5, z + 0.5) < entry.waterLevel
              ? CollisionFlag.WATER
              : 0,
          );
    }
    await owner.start();
    for (const entry of entries) {
      for (const tile of entry.tiles) {
        world.collision.replaceFlagsInRegion(
          tile.x,
          tile.z,
          1,
          1,
          terrainMask,
          [terrainMask],
        );
        expect(world.collision.hasFlags(tile.x, tile.z, terrainMask)).toBe(
          false,
        );
        expect(
          world.collision.hasFlags(tile.x, tile.z, CollisionFlag.DOCK),
        ).toBe(true);
      }
      const startPoint = point(entry, -2.5, 0),
        targetPoint = point(entry, 5.5, 0);
      const start = {
          x: Math.floor(startPoint.x),
          z: Math.floor(startPoint.z),
        },
        target = { x: Math.floor(targetPoint.x), z: Math.floor(targetPoint.z) };
      expect(
        terrain.getResourceGroundHeight(start.x + 0.5, start.z + 0.5),
      ).toBeGreaterThan(entry.waterLevel);
      const bfs = new BFSPathfinder();
      const path = bfs.findPath(
        start,
        target,
        (tile, from) =>
          tile.x >= entry.bounds.minX - 2 &&
          tile.x < entry.bounds.maxX + 2 &&
          tile.z >= entry.bounds.minZ - 2 &&
          tile.z < entry.bounds.maxZ + 2 &&
          world.collision.isWalkable(tile.x, tile.z) &&
          (!from || !world.collision.isBlocked(from.x, from.z, tile.x, tile.z)),
      );
      expect(path[path.length - 1]).toEqual(target);
      expect(bfs.wasLastPathPartial()).toBe(false);
      let previous = start;
      for (const tile of path) {
        expect(
          world.collision.isBlocked(previous.x, previous.z, tile.x, tile.z),
        ).toBe(false);
        previous = tile;
      }
      const a = point(entry, 1.5, -1),
        b = point(entry, 1.5, -2),
        diagonal = point(entry, 2.5, -2);
      for (const p of [b, diagonal])
        world.collision.setFlags(Math.floor(p.x), Math.floor(p.z), 0);
      expect(
        world.collision.isBlocked(
          Math.floor(a.x),
          Math.floor(a.z),
          Math.floor(b.x),
          Math.floor(b.z),
        ),
      ).toBe(true);
      expect(
        world.collision.isBlocked(
          Math.floor(b.x),
          Math.floor(b.z),
          Math.floor(a.x),
          Math.floor(a.z),
        ),
      ).toBe(true);
      expect(
        world.collision.isBlocked(
          Math.floor(a.x),
          Math.floor(a.z),
          Math.floor(diagonal.x),
          Math.floor(diagonal.z),
        ),
      ).toBe(true);
      world.collision.addFlags(target.x, target.z, CollisionFlag.OCCUPIED_NPC);
      expect(world.collision.isWalkable(target.x, target.z)).toBe(false);
    }
    owner.destroy();
    for (const entry of entries)
      for (const tile of entry.tiles) {
        expect(
          world.collision.hasFlags(
            tile.x,
            tile.z,
            CollisionFlag.DOCK | CollisionMask.WALLS,
          ),
        ).toBe(false);
        expect(world.collision.hasFlags(tile.x, tile.z, terrainMask)).toBe(
          true,
        );
      }
  });

  it.each(["collision", "grass"])(
    "rolls back the first dock after second-dock %s ownership fails, then retries without leaked actors/leases/meshes",
    async (failure) => {
      const { world, terrain: maybeTerrain, owner } = await fixture();
      const terrain = maybeTerrain!,
        entries = records(terrain),
        second = entries[1];
      const foreign =
        failure === "collision"
          ? world.collision.acquireStaticFootprint([second.tiles[0]])
          : terrain.acquireGrassExclusionPolygons([
              {
                id: `pond-dock-${second.descriptor.id}`,
                ...second.bounds,
                vertices: [
                  { x: second.bounds.minX, z: second.bounds.minZ },
                  { x: second.bounds.maxX, z: second.bounds.minZ },
                  { x: second.bounds.maxX, z: second.bounds.maxZ },
                  { x: second.bounds.minX, z: second.bounds.maxZ },
                ],
              },
            ]);
      const count = actorCount(world),
        beforeActors = count(),
        beforeChildren = [...world.stage.scene.children];
      const beforeGrass = grassSnapshot(terrain),
        beforeCollision = collisionSnapshot(world, entries);
      const disposed = captureMeshDisposals(world);
      try {
        await expect(owner.start()).rejects.toThrow();
        expect(owner.isStarted()).toBe(false);
        expect(owner.getCompactDiagnostics()).toEqual([]);
        expect(count()).toBe(beforeActors);
        expect(world.stage.scene.children).toEqual(beforeChildren);
        expect(grassSnapshot(terrain)).toEqual(beforeGrass);
        expect(collisionSnapshot(world, entries)).toEqual(beforeCollision);
        expect(disposed.size).toBe(1);
        expect([...disposed.values()]).toEqual([1]);
        for (const entry of entries)
          for (const tile of entry.tiles)
            expect(owner.getDeckHeightAt(tile.x, tile.z)).toBeNull();
        foreign.release();
        await owner.start();
        expect(owner.getCompactDiagnostics()).toHaveLength(2);
        expect(count()).toBe(beforeActors + 2);
        owner.destroy();
        expect(count()).toBe(beforeActors);
        expect([...disposed.values()]).toEqual([1, 1, 1]);
      } finally {
        foreign.release();
      }
    },
  );

  it.each(["terrain", "water", "native"] as const)(
    "rejects missing real %s ownership before any dock is published",
    async (missing) => {
      const f = await fixture({ [missing]: false });
      const beforeChildren = [...f.world.stage.scene.children];
      const beforeGrass = f.terrain ? grassSnapshot(f.terrain) : null;
      const beforeZoneCount = f.world.collision.getZoneCount();
      const count = missing === "native" ? null : actorCount(f.world),
        beforeActors = count?.();
      await expect(f.owner.start()).rejects.toThrow();
      expect(f.owner.getCompactDiagnostics()).toEqual([]);
      expect(f.owner.isStarted()).toBe(false);
      expect(f.world.stage.scene.children).toEqual(beforeChildren);
      expect(f.world.collision.getZoneCount()).toBe(beforeZoneCount);
      if (count) expect(count()).toBe(beforeActors);
      if (f.terrain) expect(grassSnapshot(f.terrain)).toEqual(beforeGrass);
    },
  );

  it("rejects a real live registry whose radiusSq differs from its admitted envelope", async () => {
    const { world, terrain, owner } = await fixture({ water: false });
    terrain!.getWaterBodyRegistry().register({
      ...candidate.waterBody,
      radiusSq: candidate.waterBody.radius ** 2 - 1,
      sourceType: "explicit",
    });
    const count = actorCount(world),
      beforeActors = count();
    const children = [...world.stage.scene.children];
    const beforeGrass = grassSnapshot(terrain!);
    await expect(owner.start()).rejects.toThrow(
      "manifest and live water ownership differ",
    );
    expect(owner.getCompactDiagnostics()).toEqual([]);
    expect(owner.isStarted()).toBe(false);
    expect(count()).toBe(beforeActors);
    expect(world.stage.scene.children).toEqual(children);
    expect(grassSnapshot(terrain!)).toEqual(beforeGrass);
  });

  it("preserves absent compact dock configuration as a no-allocation lifecycle", async () => {
    const { world, terrain, owner } = await fixture({ configured: false });
    const count = actorCount(world),
      beforeActors = count(),
      children = [...world.stage.scene.children],
      beforeGrass = grassSnapshot(terrain!);
    await owner.start();
    await owner.start();
    owner.update(1);
    expect(owner.getCompactDiagnostics()).toEqual([]);
    expect(count()).toBe(beforeActors);
    expect(world.stage.scene.children).toEqual(children);
    owner.destroy();
    owner.destroy();
    expect(grassSnapshot(terrain!)).toEqual(beforeGrass);
  });

  it("restores actual canonical terrain water/slope after a real bake while decks are mounted", async () => {
    const { world, terrain: maybeTerrain, owner } = await fixture();
    const terrain = maybeTerrain!,
      entries = records(terrain);
    // Both authored docks are inside the actual 100m tile centered at400,400.
    terrain["bakeWalkabilityFlags"](4, 4);
    const before = collisionSnapshot(world, entries);
    expect(
      entries.every((entry) =>
        entry.tiles.some((tile) =>
          world.collision.hasFlags(tile.x, tile.z, CollisionFlag.WATER),
        ),
      ),
    ).toBe(true);
    await owner.start();
    terrain["bakeWalkabilityFlags"](4, 4);
    for (const entry of entries)
      for (const tile of entry.tiles) {
        expect(
          world.collision.hasFlags(tile.x, tile.z, CollisionFlag.DOCK),
        ).toBe(true);
        expect(
          world.collision.hasFlags(
            tile.x,
            tile.z,
            CollisionFlag.WATER | CollisionFlag.STEEP_SLOPE,
          ),
        ).toBe(false);
      }
    owner.destroy();
    expect(collisionSnapshot(world, entries)).toEqual(before);
  });

  it("does not resurrect ownership when an actual scene childadded callback disposes the first dock", async () => {
    const { world, terrain: maybeTerrain, owner } = await fixture();
    const terrain = maybeTerrain!,
      entries = records(terrain),
      count = actorCount(world),
      beforeActors = count();
    const beforeChildren = [...world.stage.scene.children],
      beforeGrass = grassSnapshot(terrain),
      beforeCollision = collisionSnapshot(world, entries);
    const disposed = captureMeshDisposals(world);
    const onAdded = (event: { child: THREE.Object3D }) => {
      if (event.child.name.startsWith("PondDock_")) owner.dispose();
    };
    world.stage.scene.addEventListener("childadded", onAdded);
    try {
      await owner.start();
      expect(owner.isStarted()).toBe(false);
      expect(owner.getCompactDiagnostics()).toEqual([]);
      expect(count()).toBe(beforeActors);
      expect(world.stage.scene.children).toEqual(beforeChildren);
      expect(grassSnapshot(terrain)).toEqual(beforeGrass);
      expect(collisionSnapshot(world, entries)).toEqual(beforeCollision);
      expect([...disposed.values()]).toEqual([1]);
    } finally {
      world.stage.scene.removeEventListener("childadded", onAdded);
    }
    await owner.start();
    expect(owner.getCompactDiagnostics()).toHaveLength(2);
    owner.destroy();
    expect(count()).toBe(beforeActors);
  });
});
