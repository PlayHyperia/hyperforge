import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PMeshHandle } from "../../../../extras/three/geometryToPxMesh";
import { createCompactLandscapeRockFootprints } from "../CompactLandscapeRockFootprints";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { loadPhysX, getPhysX } from "../../../../physics/PhysXManager";
import { TerrainSystem } from "../TerrainSystem";
import type { CompactLandscapeRocksManifest } from "../../../../types/world/world-types";
import {
  createCompactRockCollisionGeometry,
  COMPACT_ROCK_SOURCE_SHA256,
} from "../CompactRockGeometry";
import {
  groundCompactLandscapeRocks,
  validateCompactLandscapeRocks,
} from "../CompactLandscapeRocks";
import {
  CompactLandscapeRocksSystem,
  COMPACT_LANDSCAPE_ROCKS_SYSTEM,
} from "../CompactLandscapeRocksSystem";

const worlds: World[] = [];
const owned: { dispose(): void }[] = [];
const config = DataManager.getWorldConfig()!,
  profile = DataManager.getWorldTerrainProfile();
const descriptor = config.compactLandscapeRocks!;
// These coastal poses were admitted against the exact review52 authored world,
// not the different default terrain. Keep the historical suite independent.
const coastalCandidate =
  process.env.HYPERIA_COASTAL_ROCKS_CANDIDATE === "review59";
const savedData = {
  config: DataManager["worldConfig"],
  profile: DataManager["worldTerrainProfile"],
  identity: DataManager["worldContentIdentity"],
};
const coastalRows: CompactLandscapeRocksManifest["rocks"] = [
  {
    id: "coastal-review59-01",
    variant: "rock11",
    x: 400.7,
    z: 470,
    yaw: 0.7,
    scale: 1.35,
  },
  {
    id: "coastal-review59-02",
    variant: "rock13",
    x: 403.1,
    z: 469,
    yaw: 2.1,
    scale: 1.1,
  },
  {
    id: "coastal-review59-03",
    variant: "rock10",
    x: 400.4,
    z: 472.2,
    yaw: 1.2,
    scale: 0.8,
  },
];
function coastalDescriptor(): CompactLandscapeRocksManifest {
  return {
    ...descriptor,
    layoutId: "compact-preparation-coastal-rocks-v2",
    rocks: [...descriptor.rocks, ...coastalRows],
  };
}
function admitDescriptor(value: CompactLandscapeRocksManifest) {
  // Isolated real manifest admission, restored after each test; no live world
  // identity is modified and no terrain/physics method is replaced.
  DataManager["worldContentIdentity"] = null;
  DataManager.setWorldConfig({ ...config, compactLandscapeRocks: value });
}
class CpuServerWorld extends World {
  override get isServer() {
    return true;
  }
}
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
  for (const object of owned.splice(0)) object.dispose();
  DataManager["worldConfig"] = savedData.config;
  DataManager["worldTerrainProfile"] = savedData.profile;
  DataManager["worldContentIdentity"] = savedData.identity;
});
async function fixture(server = false) {
  const world = server ? new CpuServerWorld() : new World();
  worlds.push(world);
  await world.physics.init();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  await terrain.init();
  const ground = terrain as unknown as {
    loadWaterBodiesFromManifest(): void;
    loadFlatZonesFromManifest(): void;
  };
  ground.loadWaterBodiesFromManifest();
  ground.loadFlatZonesFromManifest();
  const owner = world.register(
    COMPACT_LANDSCAPE_ROCKS_SYSTEM,
    CompactLandscapeRocksSystem,
  ) as CompactLandscapeRocksSystem;
  await owner.init();
  return { world, terrain, owner };
}

describe("authored landscape rocks: real geometry and native collision, not visual acceptance", () => {
  it("derives every near vertex and index from the actual packaged GLB including child transforms", async () => {
    const bytes = readFileSync(
      new URL(
        "../../../../../../server/world/assets/rocks/compact-outcrops-v1/rock-moss-set.glb",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      COMPACT_ROCK_SOURCE_SHA256,
    );
    type Accessor = { bufferView: number; byteOffset?: number; count: number };
    const length = bytes.readUInt32LE(12),
      doc = JSON.parse(bytes.subarray(20, 20 + length).toString()) as {
        nodes: { name: string; mesh: number; translation?: number[] }[];
        meshes: {
          primitives: { attributes: { POSITION: number }; indices: number }[];
        }[];
        accessors: Accessor[];
        bufferViews: { byteOffset?: number }[];
      };
    const binary = bytes.subarray(28 + length),
      geometries = await createCompactRockCollisionGeometry();
    for (const [variant, geometry] of geometries) {
      owned.push(geometry);
      const node = doc.nodes.find(
        (n) => n.name === `compact-outcrop-${variant}-lod0`,
      )!;
      const p = doc.meshes[node.mesh].primitives[0],
        pa = doc.accessors[p.attributes.POSITION],
        ia = doc.accessors[p.indices];
      const po =
        (doc.bufferViews[pa.bufferView].byteOffset ?? 0) + (pa.byteOffset ?? 0);
      const io =
        (doc.bufferViews[ia.bufferView].byteOffset ?? 0) + (ia.byteOffset ?? 0);
      const positions = Float32Array.from(
        { length: pa.count * 3 },
        (_, i) =>
          binary.readFloatLE(po + i * 4) + (node.translation?.[i % 3] ?? 0),
      );
      const indices = Uint16Array.from({ length: ia.count }, (_, i) =>
        binary.readUInt16LE(io + i * 2),
      );
      expect(geometry.getAttribute("position").array).toEqual(positions);
      expect(geometry.index!.array).toEqual(indices);
      expect(geometry.boundingBox!.min.y).toBeGreaterThan(-0.35);
      expect(geometry.boundingBox!.max.y).toBeLessThan(1.1);
    }
    expect(geometries.size).toBe(3);
    const footprints = createCompactLandscapeRockFootprints(descriptor);
    let verticesChecked = 0,
      maximumOutsideDistance = 0;
    for (const p of descriptor.rocks) {
      const polygon = footprints.find((f) => f.id === p.id)!;
      const transform = new THREE.Matrix4()
        .makeRotationY(p.yaw)
        .scale(new THREE.Vector3(p.scale, p.scale, p.scale))
        .setPosition(p.x, 0, p.z);
      for (let lod = 0; lod < 3; lod++) {
        const node = doc.nodes.find(
          (n) => n.name === `compact-outcrop-${p.variant}-lod${lod}`,
        )!;
        const accessor =
          doc.accessors[
            doc.meshes[node.mesh].primitives[0].attributes.POSITION
          ];
        const offset =
          (doc.bufferViews[accessor.bufferView].byteOffset ?? 0) +
          (accessor.byteOffset ?? 0);
        for (let i = 0; i < accessor.count; i++) {
          const point = new THREE.Vector3(
            binary.readFloatLE(offset + i * 12) + (node.translation?.[0] ?? 0),
            0,
            binary.readFloatLE(offset + i * 12 + 8) +
              (node.translation?.[2] ?? 0),
          ).applyMatrix4(transform);
          verticesChecked++;
          for (let edge = 0; edge < polygon.vertices.length; edge++) {
            const a = polygon.vertices[edge],
              b = polygon.vertices[(edge + 1) % polygon.vertices.length];
            const side =
              (b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x);
            maximumOutsideDistance = Math.max(
              maximumOutsideDistance,
              -side / Math.hypot(b.x - a.x, b.z - a.z),
            );
          }
        }
      }
    }
    expect(verticesChecked).toBeGreaterThan(80000);
    expect(maximumOutsideDistance).toBeLessThan(1e-10);
  });

  it("validates a detached frozen manifest and rejects malformed, unauthorized or unbounded placements", () => {
    expect(descriptor.rocks).toHaveLength(17);
    const value = validateCompactLandscapeRocks(descriptor, profile)!;
    expect(value).toEqual(descriptor);
    expect(value).not.toBe(descriptor);
    expect(Object.isFrozen(value.rocks[0])).toBe(true);
    expect(validateCompactLandscapeRocks(undefined, profile)).toBeUndefined();
    for (const bad of [
      null,
      {},
      [],
      { ...descriptor, extra: true },
      { ...descriptor, sourceSha256: "stale" },
      { ...descriptor, rocks: [] },
      { ...descriptor, rocks: [descriptor.rocks[0], descriptor.rocks[0]] },
      {
        ...descriptor,
        get rocks() {
          throw new Error("getter must not run");
        },
      },
      ...[
        { x: 400 },
        { scale: 2 },
        { yaw: NaN },
        { variant: "unknown" },
        { id: "../outside" },
        { y: 28 },
      ].map((fields) => ({
        ...descriptor,
        rocks: [{ ...descriptor.rocks[0], ...fields }],
      })),
    ])
      expect(() => validateCompactLandscapeRocks(bad, profile)).toThrow();
    expect(() =>
      validateCompactLandscapeRocks(descriptor, {
        ...profile,
        id: "unqualified",
      }),
    ).toThrow();
  });

  it("admits only the explicit bounded coastal layout while preserving all historical v1 rows", () => {
    const before = JSON.stringify(descriptor);
    const candidate = coastalDescriptor();
    const admitted = validateCompactLandscapeRocks(candidate, profile)!;
    expect(admitted.layoutId).toBe("compact-preparation-coastal-rocks-v2");
    expect(admitted.rocks).toHaveLength(20);
    expect(admitted.rocks.slice(0, 17)).toEqual(descriptor.rocks);
    expect(admitted.rocks.slice(17)).toEqual(coastalRows);
    expect(admitted).not.toBe(candidate);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.rocks)).toBe(true);
    expect(admitted.rocks.every(Object.isFrozen)).toBe(true);
    expect(validateCompactLandscapeRocks(descriptor, profile)).toEqual(
      descriptor,
    );
    expect(descriptor.layoutId).toBe("compact-preparation-rocks-v1");
    expect(JSON.stringify(descriptor)).toBe(before);
    expect(() =>
      validateCompactLandscapeRocks(
        { ...candidate, layoutId: descriptor.layoutId },
        profile,
      ),
    ).toThrow();
    for (const [x, z] of [
      [399, 468],
      [399, 474],
      [405, 468],
      [405, 474],
    ]) {
      expect(
        validateCompactLandscapeRocks(
          { ...candidate, rocks: [{ ...coastalRows[0], x, z }] },
          profile,
        )?.rocks[0],
      ).toMatchObject({ x, z });
    }
    for (const bad of [
      { ...candidate, layoutId: "compact-preparation-coastal-rocks-v3" },
      {
        ...candidate,
        rocks: [
          ...candidate.rocks,
          { ...coastalRows[0], id: "coastal-fourth" },
        ],
      },
      {
        ...candidate,
        rocks: Array.from({ length: 25 }, (_, i) => ({
          ...descriptor.rocks[0],
          id: `budget-${i}`,
        })),
      },
      ...[
        { x: 398.999 },
        { x: 405.001 },
        { z: 467.999 },
        { z: 474.001 },
        { scale: 0.499 },
        { scale: 1.501 },
        { x: NaN },
        { yaw: -0.1 },
        { variant: "unknown" },
      ].map((change) => ({
        ...candidate,
        rocks: [{ ...coastalRows[0], ...change }],
      })),
    ])
      expect(() => validateCompactLandscapeRocks(bad, profile)).toThrow();
  });

  it("grounds the authored groups on actual terrain and bounds their support work and occupancy", async () => {
    const { terrain } = await fixture(),
      geometry = await createCompactRockCollisionGeometry();
    owned.push(...geometry.values());
    const rows = descriptor.rocks.map((p) => {
      try {
        return groundCompactLandscapeRocks(
          { ...descriptor, rocks: [p] },
          geometry,
          (x, z) => terrain.getHeightAt(x, z),
        );
      } catch (error) {
        throw new Error(p.id + ": " + String(error));
      }
    });
    const record = groundCompactLandscapeRocks(descriptor, geometry, (x, z) =>
      terrain.getHeightAt(x, z),
    );
    expect(record.placements).toHaveLength(17);
    expect(record.blockingTiles.length).toBeLessThanOrEqual(256);
    expect(new Set(record.blockingTiles.map((p) => `${p.x},${p.z}`)).size).toBe(
      record.blockingTiles.length,
    );
    expect(record.placements).toEqual(rows.flatMap((r) => r.placements));
    for (const row of record.support) {
      expect(row.samples).toBeGreaterThan(10);
      expect(row.samples).toBeLessThanOrEqual(1024);
      expect(row.buriedBandTop).toBeCloseTo(row.minimum - 0.08, 10);
    }
    console.log(
      JSON.stringify({
        rocks: record.placements.length,
        tiles: record.blockingTiles.length,
        queries: record.support.reduce((n, r) => n + r.samples, 0),
        support: record.support.map((r) => ({
          id: r.id,
          relief: r.maximum - r.minimum,
        })),
      }),
    );
  });

  it("matches scaled and rotated native triangle collision to the rendered near geometry and releases all ownership", async () => {
    for (let lifetime = 0; lifetime < 3; lifetime++) {
      const { world, owner } = await fixture();
      const physx = getPhysX()!,
        types = new physx.PxActorTypeFlags(
          physx.PxActorTypeFlagEnum.eRIGID_STATIC,
        );
      const count = world.physics.scene!.getNbActors(types);
      const geometry = await createCompactRockCollisionGeometry();
      owned.push(...geometry.values());
      await owner.start();
      const record = owner.getRocks()!;
      expect(owner.getDiagnostics()).toMatchObject({
        physicsActors: 17,
        physicsShapes: 17,
        collisionGeometries: 3,
        collisionTriangles: 23928,
      });
      expect(world.physics.scene!.getNbActors(types)).toBe(count + 17);
      const handles = owner["colliders"].map((c) => c.pmesh);
      expect(handles.every((handle) => handle instanceof PMeshHandle)).toBe(
        true,
      );
      expect(new Set(handles.map((handle) => handle!.value)).size).toBe(3);
      await owner.start();
      expect(world.physics.scene!.getNbActors(types)).toBe(count + 17);
      for (const tile of record.blockingTiles)
        expect(world.collision.isWalkable(tile.x, tile.z)).toBe(false);
      const material = new THREE.MeshBasicMaterial();
      owned.push(material);
      const meshes = record.placements.map((p) => {
        const mesh = new THREE.Mesh(geometry.get(p.variant)!, material);
        mesh.position.set(p.x, p.y, p.z);
        mesh.rotation.y = p.yaw;
        mesh.scale.setScalar(p.scale);
        mesh.updateMatrixWorld(true);
        return mesh;
      });
      let hits = 0,
        misses = 0,
        maximumSurfaceError = 0,
        maximumVerticalError = 0;
      const ray = new THREE.Raycaster(),
        direction = new THREE.Vector3(0, -1, 0),
        origin = new THREE.Vector3(),
        normal = new THREE.Vector3();
      for (const row of record.support)
        for (let iz = 0; iz <= 8; iz++)
          for (let ix = 0; ix <= 8; ix++) {
            origin.set(
              Math.fround(
                row.bounds.minX +
                  ((row.bounds.maxX - row.bounds.minX) * ix) / 8,
              ),
              50,
              Math.fround(
                row.bounds.minZ +
                  ((row.bounds.maxZ - row.bounds.minZ) * iz) / 8,
              ),
            );
            // PhysX receives float32 origins. Compare the identical ray, not a
            // double-precision neighbor on a steep scanned triangle.
            ray.set(origin, direction);
            ray.far = 50;
            const visible = ray.intersectObjects(meshes, false)[0],
              actual = world.physics.raycast(origin, direction, 50);
            if (visible) {
              expect(actual).not.toBeNull();
              // The actor pose, mesh scale, query and intersection arithmetic
              // cross float32 WASM boundaries. A vertical difference alone
              // magnifies tiny horizontal pose rounding on steep triangles.
              // Bound normal-to-surface error to eight world-coordinate ULPs
              // (0.244mm at this island), independently of triangle slope.
              normal
                .copy(visible.face!.normal)
                .transformDirection(visible.object.matrixWorld);
              const error = new THREE.Vector3()
                .copy(actual!.point)
                .sub(visible.point);
              const surfaceError = Math.abs(error.dot(normal));
              const worldMagnitude = Math.max(
                Math.abs(origin.x),
                Math.abs(origin.y),
                Math.abs(origin.z),
              );
              const ulp = 2 ** (Math.floor(Math.log2(worldMagnitude)) - 23);
              if (surfaceError > 8 * ulp) {
                // Failure diagnostics only: retain the exact ray and bound.
                // Find the nearest actual source face, not just its plane.
                const mesh = visible.object as THREE.Mesh,
                  positions = mesh.geometry.attributes.position,
                  indices = mesh.geometry.index!,
                  triangle = new THREE.Triangle(),
                  closest = new THREE.Vector3(),
                  faceNormal = new THREE.Vector3();
                let nearestDistance = Infinity;
                let nearest: object | undefined;
                for (let face = 0; face < indices.count / 3; face++) {
                  [triangle.a, triangle.b, triangle.c].forEach((v, corner) =>
                    v
                      .fromBufferAttribute(
                        positions,
                        indices.getX(face * 3 + corner),
                      )
                      .applyMatrix4(mesh.matrixWorld),
                  );
                  triangle.closestPointToPoint(actual!.point, closest);
                  const distance = closest.distanceTo(actual!.point);
                  if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearest = {
                      face,
                      distance,
                      point: closest.toArray(),
                      normal: triangle.getNormal(faceNormal).toArray(),
                      vertices: [
                        triangle.a.toArray(),
                        triangle.b.toArray(),
                        triangle.c.toArray(),
                      ],
                    };
                  }
                }
                const result = world.physics.raycastResult!;
                const native = Array.from(
                  { length: result.getNbAnyHits() },
                  (_, i) => {
                    const hit = result.getAnyHit(i);
                    return {
                      faceIndex: hit.faceIndex,
                      u: hit.u,
                      v: hit.v,
                      distance: hit.distance,
                    };
                  },
                );
                console.info(
                  JSON.stringify({
                    rockRayFailureDiagnostic: { nearest, native },
                  }),
                );
              }
              const actualHandle = actual!.handle;
              expect(
                surfaceError,
                JSON.stringify({
                  sampledBounds: row.id,
                  visibleRock:
                    record.placements[
                      meshes.findIndex((mesh) => mesh === visible.object)
                    ]?.id,
                  origin: origin.toArray(),
                  visiblePoint: visible.point.toArray(),
                  actualPoint: actual!.point.toArray(),
                  actualNormal: actual!.normal.toArray(),
                  actualRock:
                    typeof actualHandle === "object" &&
                    actualHandle !== null &&
                    "tag" in actualHandle &&
                    typeof actualHandle.tag === "string"
                      ? actualHandle.tag
                      : undefined,
                  visibleFaceIndex: visible.faceIndex,
                  visibleNormal: normal.toArray(),
                  surfaceError,
                }),
              ).toBeLessThanOrEqual(8 * ulp);
              maximumSurfaceError = Math.max(maximumSurfaceError, surfaceError);
              maximumVerticalError = Math.max(
                maximumVerticalError,
                Math.abs(error.y),
              );
              hits++;
            } else {
              expect(actual).toBeNull();
              misses++;
            }
          }
      expect(hits).toBeGreaterThan(500);
      expect(misses).toBeGreaterThan(100);
      console.log(
        JSON.stringify({
          lifetime,
          hits,
          misses,
          maximumSurfaceError,
          maximumVerticalError,
        }),
      );
      const shared = record.blockingTiles[0],
        other = world.collision.acquireStaticFootprint([shared]);
      owner.destroy();
      owner.destroy();
      for (const handle of handles) {
        expect((handle as unknown as PMeshHandle).released).toBe(true);
        expect((handle as unknown as PMeshHandle).item.refs).toBe(0);
        expect(handle!.value).toBeNull();
      }
      expect(owner.getRocks()).toBeNull();
      expect(world.physics.scene!.getNbActors(types)).toBe(count);
      for (const tile of record.blockingTiles.slice(1))
        expect(world.collision.isWalkable(tile.x, tile.z)).toBe(true);
      expect(world.collision.isWalkable(shared.x, shared.z)).toBe(false);
      other.release();
      expect(world.collision.isWalkable(shared.x, shared.z)).toBe(true);
      physx.destroy(types);
    }
  }, 60000);

  it.runIf(coastalCandidate)(
    "uses canonical v2 grounding despite a real resident terrain cache and owns coastal native collision and grass footprints",
    async () => {
      expect(process.env.ASSETS_DIR).toContain(
        "terrain-pond-review52-UNQUALIFIED/assets",
      );
      // The third preliminary pose fails the unchanged production burial gate.
      // Retain that witness; only the two measured supported poses are installed.
      const candidate: CompactLandscapeRocksManifest = {
        ...coastalDescriptor(),
        rocks: [...descriptor.rocks, ...coastalRows.slice(0, 2)],
      };
      admitDescriptor(candidate);
      const { world, terrain, owner } = await fixture(true);
      const geometry = await createCompactRockCollisionGeometry();
      owned.push(...geometry.values());
      expect(() =>
        groundCompactLandscapeRocks(
          { ...candidate, rocks: [coastalRows[2]] },
          geometry,
          (x, z) => terrain.getResourceGroundHeight(x, z),
        ),
      ).toThrow("excessively buried");
      const expected = groundCompactLandscapeRocks(
        candidate,
        geometry,
        (x, z) => terrain.getResourceGroundHeight(x, z),
      );
      const canonicalBefore = coastalRows.map((p) =>
        terrain.getResourceGroundHeight(p.x, p.z),
      );
      const tile = terrain["generateTile"](4, 5, false);
      expect(tile.heightData!.length).toBeGreaterThan(0);
      // Populate the real cached query with its actual generated height data;
      // no synthetic cache heights or replacements of terrain methods.
      terrain.getHeightAt(200, 200);
      const cached = coastalRows.map((p) => terrain.getHeightAt(p.x, p.z));
      expect(
        cached.some((h, i) => Math.abs(h - canonicalBefore[i]) > 1e-6),
      ).toBe(true);
      expect(
        coastalRows.map((p) => terrain.getResourceGroundHeight(p.x, p.z)),
      ).toEqual(canonicalBefore);
      expect(
        groundCompactLandscapeRocks(candidate, geometry, (x, z) =>
          terrain.getResourceGroundHeight(x, z),
        ),
      ).toEqual(expected);
      expect(
        expected.placements.slice(0, 17).map(({ y: _y, ...p }) => p),
      ).toEqual(descriptor.rocks);
      expect(
        expected.support.every(
          (row) => row.samples <= 1024 && row.maximum - row.minimum <= 1.5,
        ),
      ).toBe(true);
      expect(expected.blockingTiles.length).toBeLessThanOrEqual(256);
      const worker = terrain["buildGrassWorkerSetup"]();
      const grass = worker.getTerrainSurfaceForRegion(200, 200, 500, 500);
      expect(grass.exclusionPolygons).toEqual(
        createCompactLandscapeRockFootprints(candidate),
      );
      expect(grass.exclusionPolygons).toHaveLength(19);
      const physx = getPhysX()!,
        types = new physx.PxActorTypeFlags(
          physx.PxActorTypeFlagEnum.eRIGID_STATIC,
        );
      const beforeActors = world.physics.scene!.getNbActors(types);
      const beforeFlags = expected.blockingTiles.map((p) =>
        world.collision.getFlags(p.x, p.z),
      );
      try {
        await owner.start();
        expect(owner.getRocks()).toEqual(expected);
        expect(owner.getDiagnostics()).toMatchObject({
          layoutId: candidate.layoutId,
          physicsActors: 19,
          physicsShapes: 19,
          collisionGeometries: 3,
        });
        expect(world.physics.scene!.getNbActors(types)).toBe(beforeActors + 19);
        for (const p of expected.blockingTiles)
          expect(world.collision.isWalkable(p.x, p.z)).toBe(false);
        const material = new THREE.MeshBasicMaterial();
        owned.push(material);
        const meshes = expected.placements.slice(17).map((p) => {
          const mesh = new THREE.Mesh(geometry.get(p.variant)!, material);
          mesh.position.set(p.x, p.y, p.z);
          mesh.rotation.y = p.yaw;
          mesh.scale.setScalar(p.scale);
          mesh.updateMatrixWorld(true);
          return mesh;
        });
        const direction = new THREE.Vector3(0, -1, 0),
          ray = new THREE.Raycaster(),
          origin = new THREE.Vector3(),
          normal = new THREE.Vector3();
        let hits = 0,
          maximumSurfaceError = 0;
        for (const support of expected.support.slice(17)) {
          for (let iz = 0; iz <= 8; iz++)
            for (let ix = 0; ix <= 8; ix++) {
              origin.set(
                Math.fround(
                  support.bounds.minX +
                    ((support.bounds.maxX - support.bounds.minX) * ix) / 8,
                ),
                50,
                Math.fround(
                  support.bounds.minZ +
                    ((support.bounds.maxZ - support.bounds.minZ) * iz) / 8,
                ),
              );
              ray.set(origin, direction);
              ray.far = 50;
              const visible = ray.intersectObjects(meshes, false)[0];
              const actual = world.physics.raycast(origin, direction, 50);
              if (!visible) {
                expect(actual).toBeNull();
                continue;
              }
              expect(actual).not.toBeNull();
              normal
                .copy(visible.face!.normal)
                .transformDirection(visible.object.matrixWorld);
              const error = Math.abs(
                new THREE.Vector3()
                  .copy(actual!.point)
                  .sub(visible.point)
                  .dot(normal),
              );
              const ulp =
                2 **
                (Math.floor(
                  Math.log2(Math.max(...origin.toArray().map(Math.abs))),
                ) -
                  23);
              expect(error).toBeLessThanOrEqual(8 * ulp);
              maximumSurfaceError = Math.max(maximumSurfaceError, error);
              hits++;
            }
        }
        expect(hits).toBeGreaterThan(50);
        console.log(
          JSON.stringify({
            coastalNative: {
              hits,
              maximumSurfaceError,
              cachedCenterHeights: cached,
              canonicalCenterHeights: canonicalBefore,
              support: expected.support.slice(17),
              blockedCells: expected.blockingTiles.length,
            },
          }),
        );
        owner.destroy();
        owner.destroy();
        expect(world.physics.scene!.getNbActors(types)).toBe(beforeActors);
        expect(
          expected.blockingTiles.map((p) => world.collision.getFlags(p.x, p.z)),
        ).toEqual(beforeFlags);
        expect(owner.getRocks()).toBeNull();
      } finally {
        physx.destroy(types);
      }
    },
    60000,
  );

  it("cancels async startup without publishing collision or navigation ownership", async () => {
    const { world, owner } = await fixture();
    const physx = getPhysX()!,
      types = new physx.PxActorTypeFlags(
        physx.PxActorTypeFlagEnum.eRIGID_STATIC,
      );
    try {
      const before = world.physics.scene!.getNbActors(types);
      const pending = owner.start();
      owner.destroy();
      await pending;
      expect(owner.getRocks()).toBeNull();
      expect(owner.getDiagnostics()).toBeNull();
      expect(world.physics.scene!.getNbActors(types)).toBe(before);
    } finally {
      physx.destroy(types);
    }
  });
});
