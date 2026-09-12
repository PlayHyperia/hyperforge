import { beforeAll, describe, expect, it } from "vitest";
import { World } from "../../core/World";
import { BoxGeometry, Quaternion, Vector3 } from "../../extras/three/three";
import { PMeshHandle } from "../../extras/three/geometryToPxMesh";
import { getPhysX, loadPhysX } from "../../physics/PhysXManager";
import type { PhysXModule } from "../../types/systems/physics";
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
