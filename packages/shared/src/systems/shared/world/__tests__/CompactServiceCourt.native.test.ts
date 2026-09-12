import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createOpenWorkshop,
  OPEN_WORKSHOP_POSTS,
} from "@hyperforge/procgen/building";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { getPhysX, loadPhysX } from "../../../../physics/PhysXManager";
import { Vector3, Raycaster, Mesh } from "../../../../extras/three/three";
import { TerrainSystem } from "../TerrainSystem";
import {
  COMPACT_SERVICE_COURT,
  groundCompactServiceCourt,
  validateCompactServiceCourt,
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
async function fixture() {
  DataManager["worldContentIdentity"] = null;
  DataManager.setWorldConfig({
    ...structuredClone(saved.config!),
    compactServiceCourt: structuredClone(COMPACT_SERVICE_COURT),
  });
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
  const owner = world.getSystem<CompactServiceCourtSystem>(
    COMPACT_SERVICE_COURT_SYSTEM,
  )!;
  const visual = world.getSystem<CompactServiceCourtVisualsSystem>(
    COMPACT_SERVICE_COURT_VISUAL_SYSTEM,
  )!;
  return { world, terrain, owner, visual };
}

describe("compact service court actual geometry and native PhysX (not rendered acceptance)", () => {
  it("admits only a detached frozen descriptor and rejects extra fields, getters and wrong profiles", () => {
    const profile = saved.profile!;
    expect(validateCompactServiceCourt(undefined, profile)).toBeUndefined();
    const input = structuredClone(COMPACT_SERVICE_COURT);
    expect(input.recipeId).toBe("open-timber-smithy-v2");
    const descriptor = validateCompactServiceCourt(input, profile)!;
    expect(descriptor).toEqual(input);
    expect(descriptor).not.toBe(input);
    expect(Object.isFrozen(descriptor.position)).toBe(true);
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

  it("grounds all feet independently, preserves passage and exact native/render surfaces across three lifetimes", async () => {
    const { world, terrain, owner, visual } = await fixture();
    const px = getPhysX()!;
    const types = new px.PxActorTypeFlags(px.PxActorTypeFlagEnum.eRIGID_STATIC);
    const before = world.physics.scene!.getNbActors(types),
      children = world.stage.scene.children.length;
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
        expect(owner.getDiagnostics()).toMatchObject({
          physicsActor: true,
          physicsShapes: 3,
        });
        expect(visual.getDiagnostics()).toMatchObject({
          meshes: 3,
          materials: 3,
          triangles: 1184,
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
        expect(checked).toBe(1184);
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
      }
    } finally {
      px.destroy(types);
    }
  });

  it("retires pending initialization/start without publishing resources or clearing a newer owner", async () => {
    const { world, owner } = await fixture();
    const pending = owner.init();
    owner.destroy();
    await pending;
    expect(owner.isInitialized()).toBe(false);
    await owner.init();
    const start = owner.start();
    owner.destroy();
    await start;
    expect(owner.getCourt()).toBeNull();
    expect(world.collision.getFlags(331, 335)).toBe(0);
    await owner.init();
    await owner.start();
    expect(owner.getCourt()).not.toBeNull();
    expect(world.collision.getFlags(331, 335)).toBe(CollisionFlag.BLOCKED);
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
