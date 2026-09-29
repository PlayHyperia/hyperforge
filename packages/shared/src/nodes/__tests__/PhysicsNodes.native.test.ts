import { beforeAll, describe, expect, it } from "vitest";
import { World } from "../../core/World";
import { BoxGeometry, Quaternion, Vector3 } from "../../extras/three/three";
import { PMeshHandle } from "../../extras/three/geometryToPxMesh";
import { getPhysX, loadPhysX } from "../../physics/PhysXManager";
import type { PhysicsHandle, PhysXModule } from "../../types/systems/physics";
import { Collider } from "../Collider";
import { RigidBody } from "../RigidBody";

type NativeRuntime = PhysXModule & {
  getCache(constructor: unknown): Record<number, unknown>;
};
let px: NativeRuntime;

beforeAll(async () => {
  // Use the real resolved package WASM, never a CDN or fake physics world.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await loadPhysX();
    px = getPhysX() as NativeRuntime;
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

const constructorNames = [
  "PxTransform",
  "PxVec3",
  "PxQuat",
  "PxMeshScale",
  "PxTriangleMeshGeometry",
  "PxBoxGeometry",
  "PxSphereGeometry",
  "PxShapeFlags",
  "PxFilterData",
] as const;

// Transparent construction receipts: every constructor still invokes the
// original native implementation with its actual args and returns its actual
// object. No fake actors, shapes, promises, or geometry are supplied. In
// particular, pose.p/q borrowed member wrappers are NOT counted as ownership.
function observeOwnedConstructors() {
  const owned: Array<{
    name: string;
    value: { ptr: number };
    constructor: unknown;
  }> = [];
  const restore: Array<() => void> = [];
  for (const name of constructorNames) {
    const original = px[name];
    const descriptor = Object.getOwnPropertyDescriptor(px, name)!;
    const replacement = new Proxy(original, {
      construct(target, args, newTarget) {
        const value = Reflect.construct(target, args, newTarget) as {
          ptr: number;
        };
        owned.push({ name, value, constructor: original });
        return value;
      },
    });
    Object.defineProperty(px, name, { ...descriptor, value: replacement });
    restore.push(() => Object.defineProperty(px, name, descriptor));
  }
  return {
    owned,
    retained: () =>
      owned
        .filter(
          (entry) =>
            px.getCache(entry.constructor)[entry.value.ptr] === entry.value,
        )
        .map((entry) => entry.name),
    restore: () => {
      for (const undo of restore.reverse()) undo();
    },
  };
}

async function fixture(count = 5) {
  const world = new World();
  await world.physics.init();
  const geometry = new BoxGeometry(2, 3, 1);
  const body = new RigidBody({ type: "static" });
  const colliders = Array.from({ length: count }, (_, index) => {
    const collider = new Collider({
      type: "geometry",
      geometry,
      convex: false,
    });
    collider.position.x = index * 3;
    body.add(collider);
    return collider;
  });
  const actorTypes = new px.PxActorTypeFlags(
    px.PxActorTypeFlagEnum.eRIGID_STATIC,
  );
  const actorCount = () => world.physics.scene!.getNbActors(actorTypes);
  return {
    world,
    geometry,
    body,
    colliders,
    actorCount,
    async dispose() {
      body.deactivate();
      geometry.dispose();
      px.destroy(actorTypes);
      await world.destroy();
    },
  };
}

function cooked(collider: Collider): PMeshHandle {
  expect(collider.pmesh).toBeInstanceOf(PMeshHandle);
  return collider.pmesh as PMeshHandle;
}

describe("real PhysX static body / geometry collider ownership", () => {
  it("preserves ordinary native box and sphere shapes without retaining their constructor values", async () => {
    const f = await fixture(0);
    const receipt = observeOwnedConstructors();
    try {
      f.body.add(new Collider({ type: "box", width: 2, height: 3, depth: 4 }));
      f.body.add(new Collider({ type: "sphere", radius: 2 }));
      f.body.activate(f.world);
      expect(f.body.actor!.getNbShapes()).toBe(2);
      f.body.deactivate();
      expect(receipt.retained()).toEqual([]);
    } finally {
      try {
        await f.dispose();
      } finally {
        receipt.restore();
      }
    }
  });

  it("does not allocate a target or access a retired actor for an unmounted kinematic body", () => {
    const body = new RigidBody({ type: "kinematic" });
    const receipt = observeOwnedConstructors();
    try {
      body.setKinematicTarget(new Vector3(1, 2, 3), new Quaternion());
      expect(body._tm).toBeNull();
      expect(receipt.owned).toEqual([]);
    } finally {
      body.unmount();
      receipt.restore();
    }
  });

  it("releases all directly constructed native values across five-shape mount/deactivate cycles", async () => {
    const f = await fixture();
    const receipt = observeOwnedConstructors();
    const baseline = f.actorCount();
    const position = f.geometry.getAttribute("position");
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        f.body.activate(f.world);
        expect(f.actorCount()).toBe(baseline + 1);
        expect(f.body.actor!.getNbShapes()).toBe(5);
        const handles = f.colliders.map(cooked);
        expect(new Set(handles.map((h) => h.item)).size).toBe(1);
        expect(handles[0].item.refs).toBe(5);
        f.body.deactivate();
        expect(f.actorCount()).toBe(baseline);
        expect(f.body.actor).toBeNull();
        expect(f.body.actorHandle).toBeNull();
        expect(f.body.transform).toBeNull();
        expect(f.body._tm).toBeNull();
        expect(f.body.shapes.size).toBe(0);
        expect(handles[0].item.refs).toBe(0);
        expect(handles.every((h) => h.released && h.value === null)).toBe(true);
        expect(receipt.retained()).toEqual([]);
        expect(f.geometry.getAttribute("position")).toBe(position);
        f.body.deactivate(); // native destruction must remain idempotent
      }
      expect(receipt.owned.filter((v) => v.name === "PxVec3")).toHaveLength(15);
      expect(receipt.owned.filter((v) => v.name === "PxQuat")).toHaveLength(15);
    } finally {
      try {
        await f.dispose();
      } finally {
        receipt.restore();
      }
    }
  });

  it("retains shared cooked geometry and the other live shape when one collider retires", async () => {
    const f = await fixture(2);
    const receipt = observeOwnedConstructors();
    let geometryDisposals = 0;
    f.geometry.addEventListener("dispose", () => geometryDisposals++);
    try {
      f.body.activate(f.world);
      const first = cooked(f.colliders[0]);
      const second = cooked(f.colliders[1]);
      expect(first.item).toBe(second.item);
      f.body.remove(f.colliders[0]);
      expect(first.released).toBe(true);
      expect(second.released).toBe(false);
      expect(second.value).not.toBeNull();
      expect(second.item.refs).toBe(1);
      expect(f.body.actor!.getNbShapes()).toBe(1);
      expect(geometryDisposals).toBe(0);
      f.body.deactivate();
      expect(second.item.refs).toBe(0);
      expect(receipt.retained()).toEqual([]);
      expect(geometryDisposals).toBe(0);
    } finally {
      try {
        await f.dispose();
      } finally {
        receipt.restore();
      }
    }
  });

  it("rebuilds the body while preserving live collider ownership and shared mesh references", async () => {
    const f = await fixture(2);
    const receipt = observeOwnedConstructors();
    try {
      f.body.activate(f.world);
      const handles = f.colliders.map(cooked);
      const shapes = f.colliders.map((c) => c.shape);
      f.body.mass = 2; // actual node setter requests a body rebuild
      f.body.commit(false);
      expect(f.body.actor!.getNbShapes()).toBe(2);
      expect(f.colliders.map((c) => c.shape)).toEqual(shapes);
      expect(f.colliders.map((c) => c.pmesh)).toEqual(handles);
      expect(handles[0].item.refs).toBe(2);
      f.body.deactivate();
      expect(handles[0].item.refs).toBe(0);
      expect(receipt.retained()).toEqual([]);
    } finally {
      try {
        await f.dispose();
      } finally {
        receipt.restore();
      }
    }
  });

  it("releases cooked-mesh and temporary ownership on a real post-cook admission failure", async () => {
    const f = await fixture(1);
    const receipt = observeOwnedConstructors();
    const baseline = f.actorCount();
    try {
      // Explicit corrupt-node fault, not an admitted constructor option and not
      // a mocked PhysX call. The actual layer check throws after real cooking.
      f.colliders[0]._layer = "invalid-native-lifecycle-test";
      expect(() => f.body.activate(f.world)).toThrow("layer not found");
      expect(f.colliders[0].shape).toBeUndefined();
      expect(f.colliders[0].pmesh).toBeUndefined();
      expect(f.body.shapes.size).toBe(0);
      // Node.activate does not roll back already-mounted ancestors. Its owner
      // must deactivate on failure; the lodge owner uses that existing boundary.
      f.body.deactivate();
      expect(f.actorCount()).toBe(baseline);
      expect(receipt.retained()).toEqual([]);
      f.colliders[0].layer = "environment";
      f.body.activate(f.world);
      expect(cooked(f.colliders[0]).item.refs).toBe(1);
      f.body.deactivate();
      expect(receipt.retained()).toEqual([]);
    } finally {
      try {
        await f.dispose();
      } finally {
        receipt.restore();
      }
    }
  });
});

describe("real PhysX raycast group filtering", () => {
  async function rayFixture(group: "player" | "terrain" = "player") {
    const world = new World();
    await world.physics.init();
    const origin = new Vector3(0, 10, 0);
    const direction = new Vector3(0, 0, 1);
    const geometry = new BoxGeometry(0.24, 3, 0.24);
    const post = new RigidBody({
      type: "static",
      tag: "camera-environment-post",
      position: [0, 10, 3],
    });
    post.add(
      new Collider({
        type: "geometry",
        geometry,
        convex: false,
        layer: "environment",
      }),
    );
    const pose = new px.PxTransform(px.PxIDENTITYEnum.PxIdentity);
    pose.p.y = origin.y;
    const capsuleGeometry = new px.PxCapsuleGeometry(0.3, 0.8);
    const material = world.physics.physics!.createMaterial(0.4, 0.4, 0.1);
    const capsule = world.physics.physics!.createRigidDynamic(pose);
    const shape = world.physics.physics!.createShape(
      capsuleGeometry,
      material,
      false,
    );
    // PlayerLocal and the native terrain hit both use a group in word0 with
    // an all-bits word1. This real capsule supplies an initial overlap; it
    // does not assert that the observed terrain actor used capsule geometry.
    const filter = new px.PxFilterData(
      world.createLayerMask(group),
      0xffffffff,
      0,
      0,
    );
    shape.setQueryFilterData(filter);
    shape.setSimulationFilterData(filter);
    capsule.attachShape(shape);
    capsule.setRigidBodyFlag(px.PxRigidBodyFlagEnum.eKINEMATIC, true);
    world.physics.addActor(capsule, {
      tag: group,
      playerId: "camera-ray-filter-regression",
      contactedHandles: new Set<PhysicsHandle>(),
      triggeredHandles: new Set<PhysicsHandle>(),
    });
    post.activate(world);
    return {
      world,
      origin,
      direction,
      post,
      async dispose() {
        post.deactivate();
        world.physics.removeActor(capsule);
        capsule.release();
        shape.release();
        material.release();
        px.destroy(filter);
        px.destroy(capsuleGeometry);
        px.destroy(pose);
        geometry.dispose();
        await world.destroy();
      },
    };
  }

  it.each(["player", "terrain"] as const)(
    "excludes an initial-overlap %s-group capsule and finds the environment triangle post behind it",
    async (group) => {
      const f = await rayFixture(group);
      try {
        const mask = f.world.createLayerMask(
          "environment",
          "prop",
          "building",
          "obstacle",
        );
        const self = f.world.raycast(
          f.origin,
          f.direction,
          6,
          f.world.createLayerMask(group),
        );
        expect(self?.distance).toBe(0);
        expect(self?.point.toArray()).toEqual(f.origin.toArray());
        const hit = f.world.raycast(f.origin, f.direction, 6, mask);
        expect(hit?.distance).toBeCloseTo(2.88, 5);
        expect(hit?.point.z).toBeCloseTo(2.88, 5);
        expect(hit?.normal.z).toBeCloseTo(-1, 5);
        // Retiring the actual obstacle leaves no hit in the requested groups.
        f.post.deactivate();
        expect(f.world.raycast(f.origin, f.direction, 6, mask)).toBeNull();
      } finally {
        await f.dispose();
      }
    },
  );

  it("retains explicit player, combined-group and omitted-mask initial-overlap hits", async () => {
    const f = await rayFixture();
    try {
      for (const mask of [
        f.world.createLayerMask("player"),
        f.world.createLayerMask("player", "environment"),
        undefined,
      ]) {
        expect(f.world.raycast(f.origin, f.direction, 6, mask)?.distance).toBe(
          0,
        );
      }
      expect(
        f.world.raycast(
          f.origin,
          f.direction,
          6,
          f.world.createLayerMask("prop"),
        ),
      ).toBeNull();
    } finally {
      await f.dispose();
    }
  });

  it("treats an explicit empty group mask as no hits rather than disabling native filtering", async () => {
    const f = await rayFixture();
    try {
      expect(f.world.raycast(f.origin, f.direction, 6, 0)).toBeNull();
      expect(
        f.world.physics.raycastWithMask(f.origin, f.direction, 6, 0),
      ).toBeNull();
    } finally {
      await f.dispose();
    }
  });

  it("reestablishes group-only ray filtering after a sweep uses the shared query object", async () => {
    const f = await rayFixture();
    const sphere = new px.PxSphereGeometry(0.01);
    try {
      f.world.physics.sweep(
        sphere,
        f.origin,
        f.direction,
        6,
        f.world.createLayerMask("environment"),
      );
      const hit = f.world.physics.raycastWithMask(
        f.origin,
        f.direction,
        6,
        f.world.createLayerMask("environment"),
      );
      expect(hit?.distance).toBeCloseTo(2.88, 5);
      const data = f.world.physics.queryFilterData!.data;
      expect([data.word0, data.word1, data.word2, data.word3]).toEqual([
        f.world.createLayerMask("environment"),
        0,
        0,
        0,
      ]);
    } finally {
      px.destroy(sphere);
      await f.dispose();
    }
  });
});
