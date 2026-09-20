import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createOpenWorkshop,
  BANK_PAVILION_POSTS,
  OPEN_WORKSHOP_POSTS,
} from "@hyperforge/procgen/building";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import type { WorldConfigManifest } from "../../../../types/world/world-types";
import { getPhysX, loadPhysX } from "../../../../physics/PhysXManager";
import {
  Vector3,
  Raycaster,
  Mesh,
  MeshBasicMaterial,
} from "../../../../extras/three/three";
import { TerrainSystem } from "../TerrainSystem";
import {
  COMPACT_SERVICE_COURT,
  COMPACT_BANK_PAVILION,
  COMPACT_SERVICE_COURT_LEGACY_FIXTURE,
  createCompactServiceCourtGrassExclusions,
  groundCompactServiceCourt,
  validateCompactServiceCourt,
  validateCompactBankPavilion,
} from "../CompactServiceCourt";
import {
  COMPACT_SERVICE_COURT_SYSTEM,
  CompactServiceCourtSystem,
} from "../CompactServiceCourtSystem";
import {
  COMPACT_SERVICE_COURT_VISUAL_SYSTEM,
  CompactServiceCourtVisualsSystem,
  registerCompactServiceCourtVisuals,
} from "../../../client/CompactServiceCourtVisualsSystem";
import { CollisionFlag } from "../../movement/CollisionFlags";
import { createGrassTerrainSurfaceOperations } from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";

const saved = {
  config: DataManager["worldConfig"],
  profile: DataManager["worldTerrainProfile"],
  identity: DataManager["worldContentIdentity"],
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
});
async function fixture(bank = false, smithy = true) {
  DataManager["worldContentIdentity"] = null;
  const config: WorldConfigManifest = {
    ...structuredClone(saved.config!),
    compactServiceCourt: structuredClone(COMPACT_SERVICE_COURT),
  };
  delete config.compactBankPavilion;
  if (!smithy) {
    delete config.compactServiceCourt;
    delete config.compactServicePlanting;
  }
  if (bank) {
    delete config.compactPreparationLodge;
    config.compactBankPavilion = structuredClone(COMPACT_BANK_PAVILION);
  }
  DataManager.setWorldConfig(config);
  const world = new World();
  worlds.push(world);
  await world.physics.init();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  await terrain.init();
  // The real startup calls these at TerrainSystem.start, before court.start.
  const ground = terrain as unknown as {
    loadWaterBodiesFromManifest(): void;
    loadFlatZonesFromManifest(): void;
  };
  ground.loadWaterBodiesFromManifest();
  ground.loadFlatZonesFromManifest();
  registerCompactServiceCourtVisuals(world);
  const owner =
    world.getSystem<CompactServiceCourtSystem>(COMPACT_SERVICE_COURT_SYSTEM) ??
    world.register(COMPACT_SERVICE_COURT_SYSTEM, CompactServiceCourtSystem);
  if (!(owner instanceof CompactServiceCourtSystem))
    throw new Error("Expected the actual compact service court owner");
  const visual = world.getSystem<CompactServiceCourtVisualsSystem>(
    COMPACT_SERVICE_COURT_VISUAL_SYSTEM,
  )!;
  return { world, terrain, owner, visual };
}

describe("compact service court actual geometry and native PhysX (not rendered acceptance)", () => {
  it("admits only the exact detached bank manifest without broadening smithy admission", () => {
    const profile = saved.profile!;
    expect(validateCompactBankPavilion(undefined, profile)).toBeUndefined();
    const input = structuredClone(COMPACT_BANK_PAVILION);
    const admitted = validateCompactBankPavilion(input, profile)!;
    expect(admitted).toEqual(COMPACT_BANK_PAVILION);
    expect(admitted).not.toBe(input);
    expect(admitted.position).not.toBe(input.position);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.position)).toBe(true);
    for (const bad of [
      null,
      {},
      COMPACT_SERVICE_COURT,
      { ...input, schemaVersion: 2 },
      { ...input, layoutId: "compact-service-court-v1" },
      { ...input, recipeId: "bank-pavilion-v1" },
      { ...input, recipeId: "open-timber-bank-haven-v1" },
      { ...input, terrainProfileId: "compact-duel-island-v5" },
      { ...input, position: { x: 350, z: 321 } },
      { ...input, rotation: Math.PI },
      { ...input, extra: true },
      { ...input, position: { ...input.position, y: 28 } },
      {
        ...input,
        get rotation() {
          throw new Error("getter must not run");
        },
      },
      { ...input, [Symbol("hidden")]: 1 },
    ])
      expect(() => validateCompactBankPavilion(bad, profile)).toThrow();
    for (const badProfile of [
      { ...profile, id: "unqualified" },
      { ...profile, algorithm: "compact-island-sculpt-v4" as const },
      { ...profile, terrainTileSize: 200 },
    ])
      expect(() => validateCompactBankPavilion(input, badProfile)).toThrow();
    expect(() => validateCompactServiceCourt(input, profile)).toThrow();
  });

  it("owns both courts independently with eight exact supports and no bank floor or walls", async () => {
    const { world, terrain, owner } = await fixture(true);
    const px = getPhysX()!;
    const types = new px.PxActorTypeFlags(px.PxActorTypeFlagEnum.eRIGID_STATIC);
    const actorCount = () => world.physics.scene!.getNbActors(types);
    const beforeActors = actorCount();
    const surface = () =>
      terrain["getTerrainSurfaceForRegion"](328, 313, 356, 343);
    const beforeSurface = surface();
    const heights = () =>
      BANK_PAVILION_POSTS.flatMap((post) =>
        [-0.15, 0, 0.15].flatMap((dx) =>
          [-0.15, 0, 0.15].map((dz) =>
            terrain.getHeightAt(350 + post.x + dx, 320 + post.z + dz),
          ),
        ),
      );
    const beforeHeights = heights();
    const foreign = world.collision.acquireStaticFootprint([
      { x: 346, z: 316 },
    ]);
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        await owner.init();
        await owner.start();
        await owner.start();
        const records = owner.getCourts();
        expect(Object.isFrozen(records)).toBe(true);
        expect(records.map((r) => r.descriptor.layoutId)).toEqual([
          COMPACT_SERVICE_COURT.layoutId,
          COMPACT_BANK_PAVILION.layoutId,
        ]);
        expect(owner.getCourt()).toBe(records[0]);
        expect(owner.getDiagnostics()).toEqual(owner.getAllDiagnostics()[0]);
        expect(
          owner
            .getAllDiagnostics()
            .map((r) => [r.physicsActor, r.physicsShapes]),
        ).toEqual([
          [true, 3],
          [true, 3],
        ]);
        expect(actorCount()).toBe(beforeActors + 2);
        const disposals = new Map<object, number>();
        for (const owned of owner["resources"]) {
          expect(owned.geometry).not.toBeNull();
          for (const geometry of [
            owned.geometry!.timber,
            owned.geometry!.roof,
            owned.geometry!.footings,
            ...owned.indexedViews,
          ]) {
            expect(disposals.has(geometry)).toBe(false);
            disposals.set(geometry, 0);
            geometry.addEventListener("dispose", () =>
              disposals.set(geometry, disposals.get(geometry)! + 1),
            );
          }
        }
        expect(disposals.size).toBe(12);
        const bank = records[1];
        if (cycle === 0) {
          const geometry = owner["resources"][1].geometry!;
          const meshes = [
            geometry.timber,
            geometry.roof,
            geometry.footings,
          ].map((batch) => {
            const mesh = new Mesh(batch, new MeshBasicMaterial());
            mesh.position.set(
              bank.position.x,
              bank.position.y,
              bank.position.z,
            );
            mesh.updateMatrixWorld(true);
            return mesh;
          });
          const ray = new Raycaster();
          ray.far = 0.005;
          let checked = 0;
          try {
            for (const mesh of meshes) {
              const position = mesh.geometry.getAttribute("position");
              const normal = mesh.geometry.getAttribute("normal");
              const index = mesh.geometry.index;
              const count = index?.count ?? position.count;
              for (let i = 0; i < count; i += 3) {
                const ids = [0, 1, 2].map((n) => index?.getX(i + n) ?? i + n);
                const center = new Vector3();
                for (const id of ids)
                  center.add(new Vector3().fromBufferAttribute(position, id));
                center.multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld);
                const outward = new Vector3()
                  .fromBufferAttribute(normal, ids[0])
                  .transformDirection(mesh.matrixWorld);
                ray.ray.origin.copy(center).addScaledVector(outward, 0.002);
                ray.ray.direction.copy(outward).negate();
                const rendered = ray.intersectObjects(meshes, false)[0];
                const native = world.physics.raycast(
                  ray.ray.origin,
                  ray.ray.direction,
                  ray.far,
                );
                expect(rendered, `bank triangle ${checked}`).toBeDefined();
                expect(native, `bank triangle ${checked}`).not.toBeNull();
                expect(native!.point.distanceTo(rendered.point)).toBeLessThan(
                  0.0001,
                );
                checked++;
              }
            }
            expect(checked).toBe(1492);
          } finally {
            // Only these CPU raycaster materials are test-owned. The real
            // owner retains and disposes all geometry (asserted below).
            for (const mesh of meshes) mesh.material.dispose();
          }
        }
        expect(bank.blockingTiles).toEqual([
          { x: 346, z: 316 },
          { x: 353, z: 316 },
          { x: 346, z: 323 },
          { x: 353, z: 323 },
        ]);
        const polygons = records.flatMap((r, i) =>
          createCompactServiceCourtGrassExclusions(
            r,
            i === 0 ? OPEN_WORKSHOP_POSTS : BANK_PAVILION_POSTS,
          ),
        );
        expect(polygons).toHaveLength(8);
        expect(new Set(polygons.map((p) => p.id)).size).toBe(8);
        expect(surface().exclusionPolygons).toEqual([
          ...(beforeSurface.exclusionPolygons ?? []),
          ...polygons,
        ]);
        expect(heights()).toEqual(beforeHeights);
        for (const tile of records.flatMap((r) => r.blockingTiles))
          expect(world.collision.isWalkable(tile.x, tile.z)).toBe(false);
        for (let z = 317; z <= 322; z++)
          for (let x = 347; x <= 352; x++)
            expect(world.collision.isWalkable(x, z)).toBe(true);
        for (const [i, post] of BANK_PAVILION_POSTS.entries()) {
          const foot = bank.feet[i];
          for (const dx of [-0.15, 0, 0.15])
            for (const dz of [-0.15, 0, 0.15]) {
              const h = terrain.getHeightAt(
                350 + post.x + dx,
                320 + post.z + dz,
              );
              expect(bank.position.y + foot.bottom).toBeLessThan(h);
              expect(bank.position.y + foot.top).toBeGreaterThan(h);
            }
          const hit = world.physics.raycast(
            new Vector3(350 + post.x - 1, bank.position.y + 1, 320 + post.z),
            new Vector3(1, 0, 0),
            2,
          );
          expect(hit).not.toBeNull();
          expect(hit!.point.x).toBeCloseTo(350 + post.x - 0.12, 4);
        }
        for (const offset of [-2, 0, 2]) {
          expect(
            world.physics.raycast(
              new Vector3(350 + offset, bank.position.y + 1.5, 315),
              new Vector3(0, 0, 1),
              10,
            ),
          ).toBeNull();
          expect(
            world.physics.raycast(
              new Vector3(345, bank.position.y + 1.5, 320 + offset),
              new Vector3(1, 0, 0),
              10,
            ),
          ).toBeNull();
        }
        expect(
          world.physics.raycast(
            new Vector3(350, bank.position.y + 1, 320),
            new Vector3(0, -1, 0),
            2,
          ),
        ).toBeNull();
        expect(
          world.physics.raycast(
            new Vector3(350, bank.position.y + 8, 320),
            new Vector3(0, -1, 0),
            5,
          ),
        ).not.toBeNull();
        owner.destroy();
        owner.destroy();
        expect([...disposals.values()]).toEqual(Array(12).fill(1));
        expect(actorCount()).toBe(beforeActors);
        expect(owner.getCourts()).toEqual([]);
        expect(owner.getAllDiagnostics()).toEqual([]);
        expect(surface()).toEqual(beforeSurface);
        expect(heights()).toEqual(beforeHeights);
        expect(world.collision.isWalkable(346, 316)).toBe(false);
        expect(world.collision.isWalkable(353, 316)).toBe(true);
      }
    } finally {
      foreign.release();
      px.destroy(types);
    }
  });

  it("rolls back the first court and partial second court when bank grass admission fails", async () => {
    const { world, terrain, owner } = await fixture(true);
    const bank = groundCompactServiceCourt(
      COMPACT_BANK_PAVILION,
      BANK_PAVILION_POSTS,
      (x, z) => terrain.getHeightAt(x, z),
    );
    const foreign = terrain.acquireGrassExclusionPolygons(
      createCompactServiceCourtGrassExclusions(bank, BANK_PAVILION_POSTS),
    );
    const surface = () =>
      terrain["getTerrainSurfaceForRegion"](328, 313, 356, 343);
    const before = surface();
    const px = getPhysX()!;
    const types = new px.PxActorTypeFlags(px.PxActorTypeFlagEnum.eRIGID_STATIC);
    const beforeActors = world.physics.scene!.getNbActors(types);
    try {
      await owner.init();
      await expect(owner.start()).rejects.toThrow();
      expect(owner.getCourts()).toEqual([]);
      expect(owner.getAllDiagnostics()).toEqual([]);
      expect(owner.getCourt()).toBeNull();
      expect(world.physics.scene!.getNbActors(types)).toBe(beforeActors);
      expect(surface()).toEqual(before);
      for (const tile of [{ x: 331, z: 335 }, ...bank.blockingTiles])
        expect(world.collision.isWalkable(tile.x, tile.z)).toBe(true);
      foreign.release();
      await owner.start();
      expect(owner.getCourts()).toHaveLength(2);
      owner.destroy();
      expect(world.physics.scene!.getNbActors(types)).toBe(beforeActors);
    } finally {
      foreign.release();
      px.destroy(types);
    }
  });

  it("supports bank-only and absent configurations without aliasing legacy smithy accessors", async () => {
    const { owner } = await fixture(true, false);
    await owner.init();
    await owner.start();
    expect(owner.getCourts()).toHaveLength(1);
    expect(owner.getCourts()[0].descriptor).toEqual(COMPACT_BANK_PAVILION);
    expect(owner.getCourt()).toBeNull();
    expect(owner.getDiagnostics()).toBeNull();
    owner.destroy();
    const empty = await fixture(false, false);
    await empty.owner.init();
    await empty.owner.start();
    expect(empty.owner.getCourts()).toEqual([]);
    expect(empty.owner.getAllDiagnostics()).toEqual([]);
  });

  it("admits only a detached frozen descriptor and rejects extra fields, getters and wrong profiles", () => {
    const profile = saved.profile!;
    expect(validateCompactServiceCourt(undefined, profile)).toBeUndefined();
    const input = structuredClone(COMPACT_SERVICE_COURT);
    expect(input.recipeId).toBe("open-timber-smithy-haven-v3");
    const descriptor = validateCompactServiceCourt(input, profile)!;
    expect(descriptor).toEqual(input);
    expect(descriptor).not.toBe(input);
    expect(Object.isFrozen(descriptor.position)).toBe(true);
    const legacy = validateCompactServiceCourt(
      structuredClone(COMPACT_SERVICE_COURT_LEGACY_FIXTURE),
      profile,
    )!;
    expect(legacy.recipeId).toBe("open-timber-smithy-v2");
    expect({ ...descriptor, recipeId: legacy.recipeId }).toEqual(legacy);
    for (const bad of [
      { ...input, extra: true },
      { ...input, recipeId: "open-timber-smithy-v1" },
      { ...input, position: { x: 337, z: 337.5 } },
      {
        ...input,
        get rotation() {
          throw new Error("getter must not run");
        },
      },
      { ...input, rotation: NaN },
    ])
      expect(() => validateCompactServiceCourt(bad, profile)).toThrow();
    expect(() =>
      validateCompactServiceCourt(input, { ...profile, id: "unqualified" }),
    ).toThrow();
  });

  it("has finite nondegenerate deterministic geometry and privately disposes every batch once", () => {
    const feet = Array.from({ length: 4 }, (_, i) => ({
      bottom: -0.08 + i * 0.02,
      top: 0.22 + i * 0.02,
    }));
    const a = createOpenWorkshop(feet),
      b = createOpenWorkshop(feet);
    const disposal = new Map<string, number>();
    try {
      let triangles = 0;
      for (const role of ["timber", "roof", "footings"] as const) {
        const geometry = a[role],
          position = geometry.getAttribute("position"),
          index = geometry.index;
        expect(geometry).not.toBe(b[role]);
        expect(position.array).toEqual(b[role].getAttribute("position").array);
        geometry.addEventListener("dispose", () =>
          disposal.set(role, (disposal.get(role) ?? 0) + 1),
        );
        const count = index?.count ?? position.count;
        triangles += count / 3;
        for (let i = 0; i < count; i += 3) {
          const vertices = [0, 1, 2].map((n) =>
            new Vector3().fromBufferAttribute(
              position,
              index?.getX(i + n) ?? i + n,
            ),
          );
          expect(
            vertices[1]
              .sub(vertices[0])
              .cross(vertices[2].sub(vertices[0]))
              .lengthSq(),
            `${role} triangle ${i / 3}`,
          ).toBeGreaterThan(1e-12);
        }
      }
      expect(triangles).toBe(1184);
    } finally {
      a.dispose();
      a.dispose();
      b.dispose();
    }
    expect([...disposal.values()]).toEqual([1, 1, 1]);
    expect(() => createOpenWorkshop([])).toThrow();
    expect(() =>
      createOpenWorkshop([{ bottom: NaN, top: 0.2 }, ...feet.slice(1)]),
    ).toThrow();
  });

  it("derives four CCW grass-only rectangles aligned with both actual footing recipes", () => {
    // Pure flat-height input to the real support and geometry generators, not
    // a simulated World or a claim of newly rendered/native GPU evidence.
    const record = groundCompactServiceCourt(
      COMPACT_SERVICE_COURT,
      OPEN_WORKSHOP_POSTS,
      () => 28,
    );
    const polygons = createCompactServiceCourtGrassExclusions(
      record,
      OPEN_WORKSHOP_POSTS,
    );
    const operations = createGrassTerrainSurfaceOperations();
    operations.validateSnapshot({
      schemaVersion: 1,
      zones: [],
      arenaFloorIds: [],
      arenaGradeHeight: null,
      waterBodies: [],
      exclusionPolygons: polygons,
    });
    expect(polygons).toHaveLength(4);
    for (const [i, post] of OPEN_WORKSHOP_POSTS.entries()) {
      const x = record.position.x + post.x,
        z = record.position.z + post.z,
        polygon = polygons[i];
      expect(polygon).toEqual({
        id: `compact-service-court-v1-footing-${i}`,
        minX: x - 0.15,
        maxX: x + 0.15,
        minZ: z - 0.15,
        maxZ: z + 0.15,
        vertices: [
          { x: x - 0.15, z: z - 0.15 },
          { x: x + 0.15, z: z - 0.15 },
          { x: x + 0.15, z: z + 0.15 },
          { x: x - 0.15, z: z + 0.15 },
        ],
      });
      expect(
        operations.isGrassExcluded({ exclusionPolygons: polygons }, x, z),
      ).toBe(true);
      for (const vertex of polygon.vertices)
        expect(
          operations.isGrassExcluded(
            { exclusionPolygons: polygons },
            vertex.x,
            vertex.z,
          ),
        ).toBe(true);
      expect(
        operations.isGrassExcluded(
          { exclusionPolygons: polygons },
          x + 0.15001,
          z,
        ),
      ).toBe(false);
    }
    // The open roof/working area is not turned into an exclusion rectangle.
    expect(
      operations.isGrassExcluded(
        { exclusionPolygons: polygons },
        record.position.x,
        record.position.z,
      ),
    ).toBe(false);
    for (const architecturalFinish of [undefined, "haven-v1"] as const) {
      const geometry = createOpenWorkshop(record.feet, { architecturalFinish });
      try {
        const position = geometry.footings.getAttribute("position");
        const bounds = OPEN_WORKSHOP_POSTS.map(() => ({
          minX: Infinity,
          maxX: -Infinity,
          minZ: Infinity,
          maxZ: -Infinity,
          count: 0,
        }));
        for (let i = 0; i < position.count; i++) {
          const x = position.getX(i),
            z = position.getZ(i);
          const index = OPEN_WORKSHOP_POSTS.findIndex(
            (post) => Math.abs(x - post.x) < 0.2 && Math.abs(z - post.z) < 0.2,
          );
          expect(index).toBeGreaterThanOrEqual(0);
          const b = bounds[index];
          b.minX = Math.min(b.minX, x);
          b.maxX = Math.max(b.maxX, x);
          b.minZ = Math.min(b.minZ, z);
          b.maxZ = Math.max(b.maxZ, z);
          b.count++;
        }
        for (const [i, b] of bounds.entries()) {
          expect(b.count).toBeGreaterThan(0);
          for (const key of ["minX", "maxX", "minZ", "maxZ"] as const) {
            const origin = key.endsWith("X")
              ? record.position.x
              : record.position.z;
            const exactLocal = polygons[i][key] - origin;
            // A stored Float32 endpoint may differ by half an ulp. No broad
            // geometry tolerance or new golden output is used for alignment.
            const halfUlp =
              2 ** (Math.floor(Math.log2(Math.abs(exactLocal))) - 24);
            expect(Math.abs(b[key] - exactLocal)).toBeLessThanOrEqual(halfUlp);
          }
        }
      } finally {
        geometry.dispose();
      }
    }
    const detached = createCompactServiceCourtGrassExclusions(
      record,
      OPEN_WORKSHOP_POSTS,
    );
    detached[0].vertices[0].x += 1;
    expect(polygons[0].vertices[0].x).not.toBe(detached[0].vertices[0].x);
    expect(() =>
      createCompactServiceCourtGrassExclusions(record, []),
    ).toThrow();
    expect(() =>
      createCompactServiceCourtGrassExclusions(
        record,
        OPEN_WORKSHOP_POSTS.map((p, i) => (i ? p : { x: NaN, z: p.z })),
      ),
    ).toThrow();
    expect(() =>
      createCompactServiceCourtGrassExclusions(
        record,
        OPEN_WORKSHOP_POSTS.map((p, i) => (i ? p : { x: p.x + 0.1, z: p.z })),
      ),
    ).toThrow();
  });

  it("grounds all feet independently, preserves passage and exact native/render surfaces across three lifetimes", async () => {
    const { world, terrain, owner, visual } = await fixture();
    const px = getPhysX()!;
    const types = new px.PxActorTypeFlags(px.PxActorTypeFlagEnum.eRIGID_STATIC);
    const before = world.physics.scene!.getNbActors(types),
      children = world.stage.scene.children.length;
    const surface = () =>
      terrain["getTerrainSurfaceForRegion"](328, 333, 345, 343);
    const beforeSurface = surface();
    const sampleHeights = () =>
      OPEN_WORKSHOP_POSTS.flatMap((post) =>
        [-0.15, 0, 0.15].flatMap((dx) =>
          [-0.15, 0, 0.15].map((dz) =>
            terrain.getHeightAt(336.5 + post.x + dx, 337.5 + post.z + dz),
          ),
        ),
      );
    const beforeHeights = sampleHeights();
    const baseFlag = { x: 331, z: 335 };
    world.collision.addFlags(baseFlag.x, baseFlag.z, CollisionFlag.WATER);
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        await owner.init();
        expect(owner.getCourt()).toBeNull();
        await owner.start();
        await owner.start();
        await visual.init({});
        visual.start();
        visual.start();
        const record = owner.getCourt()!;
        const expectedPolygons = createCompactServiceCourtGrassExclusions(
          record,
          OPEN_WORKSHOP_POSTS,
        );
        expect(surface()).toEqual({
          ...beforeSurface,
          exclusionPolygons: [
            ...(beforeSurface.exclusionPolygons ?? []),
            ...expectedPolygons,
          ],
        });
        expect(sampleHeights()).toEqual(beforeHeights);
        expect(owner.getDiagnostics()).toMatchObject({
          physicsActor: true,
          physicsShapes: 3,
        });
        expect(visual.getDiagnostics()).toMatchObject({
          meshes: 3,
          materials: 3,
          triangles: 1300,
        });
        expect(world.physics.scene!.getNbActors(types)).toBe(before + 1);
        for (let i = 0; i < 4; i++) {
          const post = OPEN_WORKSHOP_POSTS[i],
            foot = record.feet[i];
          for (const dx of [-0.15, 0, 0.15])
            for (const dz of [-0.15, 0, 0.15]) {
              const height = terrain.getHeightAt(
                record.position.x + post.x + dx,
                record.position.z + post.z + dz,
              );
              expect(record.position.y + foot.bottom).toBeLessThan(height);
              expect(record.position.y + foot.top).toBeGreaterThan(height);
            }
          expect(
            world.collision.isWalkable(
              record.blockingTiles[i].x,
              record.blockingTiles[i].z,
            ),
          ).toBe(false);
          const hit = world.physics.raycast(
            new Vector3(
              record.position.x + post.x - 1,
              record.position.y + 1,
              record.position.z + post.z,
            ),
            new Vector3(1, 0, 0),
            2,
          );
          expect(hit).not.toBeNull();
          expect(hit!.point.x).toBeCloseTo(
            record.position.x + post.x - 0.12,
            4,
          );
        }
        // Front, rear and side routes at human torso height; no synthetic ground slab.
        // Both gables are genuinely open in native collision as well as render
        // geometry. A ray below the rafters and above the braces passes through.
        for (const x of [-2, 2])
          expect(
            world.physics.raycast(
              new Vector3(
                record.position.x + x,
                record.position.y + 4.1,
                record.position.z - 4,
              ),
              new Vector3(0, 0, 1),
              8,
            ),
          ).toBeNull();
        const kingPost = world.physics.raycast(
          new Vector3(
            record.position.x,
            record.position.y + 4.2,
            record.position.z - 4,
          ),
          new Vector3(0, 0, 1),
          8,
        );
        expect(kingPost).not.toBeNull();
        expect(kingPost!.point.z).toBeCloseTo(record.position.z - 2.11, 4);
        for (const x of [334, 336.5, 339])
          expect(
            world.physics.raycast(
              new Vector3(x, record.position.y + 1.5, 333),
              new Vector3(0, 0, 1),
              9,
            ),
          ).toBeNull();
        expect(
          world.physics.raycast(
            new Vector3(330, record.position.y + 1.5, 338),
            new Vector3(1, 0, 0),
            13,
          ),
        ).toBeNull();
        expect(
          world.physics.raycast(
            new Vector3(336.5, record.position.y + 1, 338),
            new Vector3(0, -1, 0),
            2,
          ),
        ).toBeNull();
        expect(
          world.physics.raycast(
            new Vector3(336.5, record.position.y + 8, 338),
            new Vector3(0, -1, 0),
            5,
          ),
        ).not.toBeNull();
        const root = world.stage.scene.getObjectByName(
          COMPACT_SERVICE_COURT.layoutId,
        )!;
        const ray = new Raycaster();
        ray.layers.enableAll();
        ray.far = 0.005;
        let checked = 0;
        for (const mesh of root.children) {
          if (!(mesh instanceof Mesh))
            throw new Error("Unexpected court scene child");
          const position = mesh.geometry.getAttribute("position"),
            normal = mesh.geometry.getAttribute("normal"),
            index = mesh.geometry.index;
          const count = index?.count ?? position.count;
          for (let i = 0; i < count; i += 3) {
            const ids = [0, 1, 2].map((n) => index?.getX(i + n) ?? i + n);
            const center = new Vector3();
            for (const id of ids)
              center.add(new Vector3().fromBufferAttribute(position, id));
            center.multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld);
            const outward = new Vector3()
              .fromBufferAttribute(normal, ids[0])
              .transformDirection(mesh.matrixWorld);
            ray.ray.origin.copy(center).addScaledVector(outward, 0.002);
            ray.ray.direction.copy(outward).negate();
            const rendered = ray.intersectObject(root, true)[0];
            const native = world.physics.raycast(
              ray.ray.origin,
              ray.ray.direction,
              ray.far,
            );
            expect(rendered, `${mesh.name} ${i / 3}`).toBeDefined();
            expect(native, `${mesh.name} ${i / 3}`).not.toBeNull();
            expect(native!.point.distanceTo(rendered.point)).toBeLessThan(
              0.0001,
            );
            checked++;
          }
        }
        expect(checked).toBe(1300);
        visual.destroy();
        visual.destroy();
        owner.destroy();
        owner.destroy();
        expect(world.physics.scene!.getNbActors(types)).toBe(before);
        expect(world.stage.scene.children.length).toBe(children);
        expect(world.collision.getFlags(baseFlag.x, baseFlag.z)).toBe(
          CollisionFlag.WATER,
        );
        expect(owner.getCourt()).toBeNull();
        expect(surface()).toEqual(beforeSurface);
        expect(sampleHeights()).toEqual(beforeHeights);
      }
    } finally {
      px.destroy(types);
    }
  });

  it("retires pending initialization/start without publishing resources or clearing a newer owner", async () => {
    const { world, terrain, owner } = await fixture();
    const surface = () =>
      terrain["getTerrainSurfaceForRegion"](328, 333, 345, 343);
    const before = surface();
    const pending = owner.init();
    owner.destroy();
    await pending;
    expect(owner.isInitialized()).toBe(false);
    await owner.init();
    const start = owner.start();
    owner.destroy();
    await start;
    expect(owner.getCourt()).toBeNull();
    expect(surface()).toEqual(before);
    expect(world.collision.getFlags(331, 335)).toBe(0);
    await owner.init();
    await owner.start();
    expect(owner.getCourt()).not.toBeNull();
    expect(world.collision.getFlags(331, 335)).toBe(CollisionFlag.BLOCKED);
    expect(surface().exclusionPolygons).toEqual([
      ...(before.exclusionPolygons ?? []),
      ...createCompactServiceCourtGrassExclusions(
        owner.getCourt()!,
        OPEN_WORKSHOP_POSTS,
      ),
    ]);
  });

  it("unwinds native and collision admission if another real owner already holds the grass footprints", async () => {
    const { world, terrain, owner } = await fixture();
    const record = groundCompactServiceCourt(
      COMPACT_SERVICE_COURT,
      OPEN_WORKSHOP_POSTS,
      (x, z) => terrain.getHeightAt(x, z),
    );
    const surface = () =>
      terrain["getTerrainSurfaceForRegion"](328, 333, 345, 343);
    const before = surface();
    const blocker = terrain.acquireGrassExclusionPolygons(
      createCompactServiceCourtGrassExclusions(record, OPEN_WORKSHOP_POSTS),
    );
    const blocked = surface();
    const px = getPhysX()!;
    const types = new px.PxActorTypeFlags(px.PxActorTypeFlagEnum.eRIGID_STATIC);
    const beforeActors = world.physics.scene!.getNbActors(types);
    world.collision.addFlags(331, 335, CollisionFlag.WATER);
    try {
      await owner.init();
      await expect(owner.start()).rejects.toThrow();
      expect(owner.getCourt()).toBeNull();
      expect(world.physics.scene!.getNbActors(types)).toBe(beforeActors);
      expect(world.collision.getFlags(331, 335)).toBe(CollisionFlag.WATER);
      expect(surface()).toEqual(blocked);
      blocker.release();
      blocker.release();
      expect(surface()).toEqual(before);
      await owner.start();
      expect(owner.getCourt()).not.toBeNull();
      owner.destroy();
      owner.destroy();
      expect(surface()).toEqual(before);
      expect(world.physics.scene!.getNbActors(types)).toBe(beforeActors);
      expect(world.collision.getFlags(331, 335)).toBe(CollisionFlag.WATER);
    } finally {
      blocker.release();
      px.destroy(types);
    }
  });

  it("rejects nonfinite and unsupported ground before a scene or navigation allocation", async () => {
    const { terrain } = await fixture();
    const sampled: string[] = [];
    const record = groundCompactServiceCourt(
      COMPACT_SERVICE_COURT,
      OPEN_WORKSHOP_POSTS,
      (x, z) => {
        sampled.push(`${x},${z}`);
        return terrain.getHeightAt(x, z);
      },
    );
    expect(sampled).toHaveLength(37);
    for (const post of OPEN_WORKSHOP_POSTS)
      for (const dx of [-0.15, 0, 0.15])
        for (const dz of [-0.15, 0, 0.15])
          expect(sampled).toContain(
            `${336.5 + post.x + dx},${337.5 + post.z + dz}`,
          );
    expect(record.blockingTiles).toEqual([
      { x: 331, z: 335 },
      { x: 341, z: 335 },
      { x: 331, z: 340 },
      { x: 341, z: 340 },
    ]);
    expect(() =>
      groundCompactServiceCourt(
        COMPACT_SERVICE_COURT,
        OPEN_WORKSHOP_POSTS,
        () => NaN,
      ),
    ).toThrow();
    expect(() =>
      groundCompactServiceCourt(
        COMPACT_SERVICE_COURT,
        OPEN_WORKSHOP_POSTS,
        (x) => x * 10,
      ),
    ).toThrow();
  });
});
