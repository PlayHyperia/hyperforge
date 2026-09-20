import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createOpenWorkshop } from "@hyperforge/procgen/building";
import * as THREE from "../../../extras/three/three";
import { CompactRoofCutaway } from "../CompactRoofCutaway";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function fixture(architecturalFinish?: "haven-v1") {
  const geometry = createOpenWorkshop(
    Array.from({ length: 4 }, () => ({ bottom: -0.08, top: 0.22 })),
    { architecturalFinish },
  );
  const material = new THREE.MeshBasicMaterial();
  cleanup.push(() => {
    geometry.dispose();
    material.dispose();
  });
  const root = new THREE.Group();
  root.position.set(336.5, 28.419301523097687, 337.5);
  const roof = new THREE.Mesh(geometry.roof, material),
    timber = new THREE.Mesh(geometry.timber, material);
  root.add(timber, roof);
  root.updateMatrixWorld(true);
  const cutaway = new CompactRoofCutaway(root, roof, timber);
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 1000);
  // Exact native76 anvil camera, not a replacement framing that avoids the roof.
  camera.position.set(344, 33.51930152309769, 342);
  camera.quaternion.set(
    -0.20184808544201338,
    0.37343844990838587,
    0.08360821452912522,
    0.9015601704804108,
  );
  camera.updateMatrixWorld(true);
  return { root, roof, timber, geometry, camera, cutaway };
}
function settle(cutaway: CompactRoofCutaway, camera: THREE.Camera, start = 0) {
  for (let ms = start; ms <= start + 300; ms += 20) cutaway.update(camera, ms);
}

function bankFixture() {
  const geometry = createOpenWorkshop(
    Array.from({ length: 4 }, () => ({ bottom: -0.08, top: 0.22 })),
    { recipe: "bank-pavilion-v1", architecturalFinish: "haven-v1" },
  );
  const material = new THREE.MeshBasicMaterial();
  cleanup.push(() => {
    geometry.dispose();
    material.dispose();
  });
  const root = new THREE.Group();
  root.position.set(350, 28, 320);
  const roof = new THREE.Mesh(geometry.roof, material),
    timber = new THREE.Mesh(geometry.timber, material);
  root.add(timber, roof);
  root.updateMatrixWorld(true);
  const cutaway = new CompactRoofCutaway(root, roof, timber, "bank");
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 1000);
  const pose = (eye: THREE.Vector3, target: THREE.Vector3) => {
    camera.position.copy(root.localToWorld(eye));
    camera.lookAt(root.localToWorld(target));
    camera.updateMatrixWorld(true);
  };
  return { geometry, root, roof, timber, cutaway, camera, pose };
}

describe("bank pavilion cutaway with actual recipe bounds (not GPU acceptance)", () => {
  it("reveals an outward-looking interior camera and preserves lower-frame labels", () => {
    const { geometry, cutaway, camera, pose } = bankFixture();
    pose(new THREE.Vector3(0, 1.7, 3.8), new THREE.Vector3(0, 1.7, 12));
    const before = camera.matrixWorld.toArray();
    settle(cutaway, camera);
    expect(cutaway.desired).toBe(true);
    expect(cutaway.value).toBe(1);
    expect(camera.matrixWorld.toArray()).toEqual(before);
    expect(cutaway.upperWallY).toBeNull();
    const mask = geometry.timber.getAttribute("courtRoof");
    for (let i = 0; i < mask.count; i += 3) {
      expect(mask.getX(i)).toBe(mask.getX(i + 1));
      expect(mask.getX(i)).toBe(mask.getX(i + 2));
      // Each corner emits one post followed by two upper knee braces.
      // The braces now follow the roof cutaway; only the four posts remain.
      const isPermanentPost = i < 12 * 84 && Math.floor(i / 84) % 3 === 0;
      expect(mask.getX(i)).toBe(isPermanentPost ? 0 : 1);
    }
  });

  it("uses the larger actual bank footprint for an above-roof oblique ray", () => {
    const { cutaway, camera, pose } = bankFixture();
    pose(new THREE.Vector3(0, 9, 4.2), new THREE.Vector3(0, 1.2, 3.5));
    settle(cutaway, camera);
    expect(cutaway.value).toBe(1);
    pose(new THREE.Vector3(0, 9, 4.2), new THREE.Vector3(0, 1.2, 12));
    settle(cutaway, camera, 320);
    expect(cutaway.value).toBe(0);
    pose(new THREE.Vector3(0, 40, 60), new THREE.Vector3(0, 1.2, 0));
    settle(cutaway, camera, 640);
    expect(cutaway.value).toBe(0);
  });

  it("reads transformed bank and camera parents without updating their authority", () => {
    const { root, cutaway, camera, pose } = bankFixture();
    const parent = new THREE.Group();
    parent.position.set(10, 3, -7);
    parent.rotation.y = 0.4;
    parent.add(root);
    parent.updateMatrixWorld(true);
    pose(new THREE.Vector3(0, 9, 4.2), new THREE.Vector3(0, 1.2, 3.5));
    const cameraParent = new THREE.Group();
    cameraParent.position.set(7, 2, 3);
    camera.position.sub(cameraParent.position);
    cameraParent.add(camera);
    cameraParent.updateMatrixWorld(true);
    const beforeRoot = root.matrixWorld.toArray(),
      beforeCamera = camera.matrixWorld.toArray();
    settle(cutaway, camera);
    expect(cutaway.value).toBe(1);
    expect(root.matrixWorld.toArray()).toEqual(beforeRoot);
    expect(camera.matrixWorld.toArray()).toEqual(beforeCamera);
  });

  it("keeps outside access open and filters only fully faded upper geometry", () => {
    const { root, roof, timber, cutaway, camera, pose } = bankFixture();
    cutaway.installPointerFilter(roof);
    cutaway.installPointerFilter(timber);
    pose(new THREE.Vector3(0, 1.7, 0), new THREE.Vector3(0, 1.7, 10));
    const ray = new THREE.Raycaster(
      root.position.clone().add(new THREE.Vector3(0, 9, 0)),
      new THREE.Vector3(0, -1, 0),
      0,
      12,
    );
    const original = ray.intersectObject(root);
    expect(original.some((hit) => cutaway.isUpperHit(hit))).toBe(true);
    cutaway.update(camera, 0);
    cutaway.update(camera, 20);
    expect(cutaway.value).toBeGreaterThan(0);
    expect(cutaway.value).toBeLessThan(1);
    expect(ray.intersectObject(root).length).toBe(original.length);
    settle(cutaway, camera, 40);
    expect(
      ray.intersectObject(root).every((hit) => !cutaway.isUpperHit(hit)),
    ).toBe(true);
    const physical: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(roof, ray, physical);
    expect(physical.length).toBeGreaterThan(0);
    ray.ray.origin.copy(root.position).add(new THREE.Vector3(-6, 1, -3.5));
    ray.ray.direction.set(1, 0, 0);
    ray.far = 3;
    expect(ray.intersectObject(timber).length).toBeGreaterThan(0);
    pose(new THREE.Vector3(7, 1.7, 0), new THREE.Vector3(10, 1.7, 0));
    settle(cutaway, camera, 400);
    expect(cutaway.value).toBe(0);
  });

  it("does not share fading with shadow/reflection cameras or advance twice in a frame", () => {
    const { cutaway, camera, pose } = bankFixture();
    pose(new THREE.Vector3(0, 1.7, 0), new THREE.Vector3(0, 1.7, 10));
    for (let frame = 0; frame <= 15; frame++)
      cutaway.valueForPass(camera, camera, frame, frame * 20);
    const other = new THREE.PerspectiveCamera();
    expect(cutaway.valueForPass(other, camera, 15, 320)).toBe(0);
    expect(cutaway.valueForPass(camera, camera, 15, 340)).toBe(1);
    expect(cutaway.decisionCount).toBe(1);
  });

  it("fails closed without actual bounded roof geometry or authored upper-frame labels", () => {
    const { root, roof, timber } = bankFixture();
    const bounds = roof.geometry.boundingBox;
    roof.geometry.boundingBox = null;
    expect(() => new CompactRoofCutaway(root, roof, timber, "bank")).toThrow(
      /actual local roof/,
    );
    roof.geometry.boundingBox = bounds;
    const mask = timber.geometry.getAttribute("courtRoof");
    timber.geometry.deleteAttribute("courtRoof");
    expect(() => new CompactRoofCutaway(root, roof, timber, "bank")).toThrow(
      /actual local roof/,
    );
    timber.geometry.setAttribute("courtRoof", mask);
  });
});

describe.each([undefined, "haven-v1"] as const)(
  "compact smithy %s cutaway policy (CPU geometry, not visual/GPU acceptance)",
  (architecturalFinish) => {
    it("reveals the workshop from the unchanged native anvil camera without mutating prepared transforms", () => {
      const { root, camera, cutaway } = fixture(architecturalFinish);
      const cameraBefore = camera.matrixWorld.toArray(),
        rootBefore = root.matrixWorld.toArray();
      camera.updateWorldMatrix = () => {
        throw new Error(
          "Camera authority must not be updated by a visibility policy",
        );
      };
      settle(cutaway, camera);
      expect(cutaway.desired).toBe(true);
      expect(cutaway.value).toBe(1);
      expect(cutaway.decisionCount).toBe(1);
      expect(camera.matrixWorld.toArray()).toEqual(cameraBefore);
      expect(root.matrixWorld.toArray()).toEqual(rootBefore);
    });

    it("restores the roof smoothly outside the workshop and clamps a long suspended frame", () => {
      const { camera, cutaway, root } = fixture(architecturalFinish);
      settle(cutaway, camera);
      camera.lookAt(
        root.position.x + 20,
        root.position.y + 1.2,
        root.position.z,
      );
      camera.updateMatrixWorld(true);
      cutaway.update(camera, 10000);
      expect(cutaway.desired).toBe(false);
      expect(cutaway.value).toBeCloseTo(1 - 0.05 / 0.22, 10);
      settle(cutaway, camera, 10020);
      expect(cutaway.value).toBe(0);
      expect(cutaway.decisionCount).toBe(2);
    });

    it("uses a transformed parent camera and does not hide the roof for a distant overview", () => {
      const { camera, cutaway, root } = fixture(architecturalFinish);
      const parent = new THREE.Group();
      parent.position.set(10, 4, -7);
      camera.position.sub(parent.position);
      parent.add(camera);
      parent.updateMatrixWorld(true);
      settle(cutaway, camera);
      expect(cutaway.value).toBe(1);
      parent.remove(camera);
      camera.position.copy(root.position).add(new THREE.Vector3(60, 50, 0));
      camera.lookAt(root.position);
      camera.updateMatrixWorld(true);
      settle(cutaway, camera, 320);
      expect(cutaway.value).toBe(0);
    });

    it("filters only fully hidden upper pointer hits, while the original physical surface stays raycastable", () => {
      const { root, roof, timber, camera, cutaway } =
        fixture(architecturalFinish);
      cutaway.installPointerFilter(roof);
      cutaway.installPointerFilter(timber);
      const ray = new THREE.Raycaster(
        new THREE.Vector3(
          root.position.x,
          root.position.y + 9,
          root.position.z,
        ),
        new THREE.Vector3(0, -1, 0),
        0,
        12,
      );
      expect(ray.intersectObject(root).length).toBeGreaterThan(0);
      settle(cutaway, camera);
      const filtered = ray.intersectObject(root);
      expect(filtered.every((hit) => !cutaway.isUpperHit(hit))).toBe(true);
      const original: THREE.Intersection[] = [];
      THREE.Mesh.prototype.raycast.call(roof, ray, original);
      expect(original.length).toBeGreaterThan(0);
      // A moved camera still queries the physical roof, not its pointer filter.
      camera.position.x += 0.001;
      camera.updateMatrixWorld(true);
      cutaway.update(camera, 320);
      expect(cutaway.desired).toBe(true);
      ray.ray.origin.set(
        root.position.x - 6,
        root.position.y + 1,
        root.position.z - 2,
      );
      ray.ray.direction.set(1, 0, 0);
      ray.far = 2;
      expect(ray.intersectObject(timber).length).toBeGreaterThan(0);
    });

    it("keeps each upper-structure label constant over a triangle and all lower posts visible", () => {
      const { geometry } = fixture(architecturalFinish);
      const mask = geometry.timber.getAttribute("courtRoof"),
        position = geometry.timber.getAttribute("position");
      expect(geometry.timber.index).toBeNull();
      expect(mask.count).toBe(position.count);
      let hidden = 0,
        lower = 0;
      for (let i = 0; i < mask.count; i += 3) {
        expect(mask.getX(i)).toBe(mask.getX(i + 1));
        expect(mask.getX(i)).toBe(mask.getX(i + 2));
        expect([0, 1]).toContain(mask.getX(i));
        if (mask.getX(i)) hidden++;
        for (let n = 0; n < 3; n++)
          if (position.getY(i + n) < 2.44) {
            expect(mask.getX(i + n)).toBe(0);
            lower++;
          }
      }
      expect(hidden).toBeGreaterThan(0);
      expect(lower).toBeGreaterThan(0);
    });

    it("aligns post plank grain with member length rather than putting transverse bands around it", () => {
      const { geometry } = fixture(architecturalFinish);
      const position = geometry.timber.getAttribute("position"),
        normal = geometry.timber.getAttribute("normal"),
        uv = geometry.timber.getAttribute("uv");
      let sideCorners = 0;
      // The first extruded post occupies 28 triangles (84 expanded corners).
      for (let i = 0; i < 84; i++)
        if (Math.abs(normal.getY(i)) < 0.5) {
          expect(uv.getX(i)).toBeCloseTo(position.getY(i) - (0.22 - 0.035), 5);
          expect(uv.getY(i)).toBeGreaterThanOrEqual(0.02999);
          expect(uv.getY(i)).toBeLessThanOrEqual(0.27001);
          sideCorners++;
        }
      expect(sideCorners).toBe(48);
    });

    it("preserves the lower frame and footings while labelling all ring beams and new trusses as upper structure", () => {
      const { geometry } = fixture(architecturalFinish);
      const expected = {
        timber:
          "45eda5936d00cb00cbeacae51f730450452b9adb676e5ac218c971dd41f9e744",
        footings:
          "974da6055e0790c65a4a2bb25eeed4baeb7260fb19afaa013033491f9ecda284",
      };
      // Recorded from the original recipe before replacing the upper structure.
      // Preserve every lower-frame/footing attribute, not the deliberately changed roof.
      for (const role of ["timber", "footings"] as const) {
        const g = geometry[role],
          hash = createHash("sha256");
        for (const name of Object.keys(g.attributes).sort()) {
          if (name === "courtRoof") continue;
          const attribute = g.getAttribute(name);
          const a =
            role === "timber"
              ? attribute.array.subarray(0, 12 * 84 * attribute.itemSize)
              : attribute.array;
          hash.update(name);
          hash.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
        }
        if (g.index) {
          const a = g.index.array;
          hash.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
        }
        expect(hash.digest("hex"), role).toBe(expected[role]);
      }
      const mask = geometry.timber.getAttribute("courtRoof");
      // Twelve 84-corner posts/braces, followed by four 84-corner ring beams.
      for (let i = 0; i < 12 * 84; i++) expect(mask.getX(i)).toBe(0);
      for (let i = 12 * 84; i < mask.count; i++) expect(mask.getX(i)).toBe(1);
    });

    it("isolates other camera passes and restores the main fade within the same renderer frame", () => {
      const { camera, cutaway } = fixture(architecturalFinish);
      const other = new THREE.PerspectiveCamera();
      for (let frame = 0; frame <= 15; frame++)
        cutaway.valueForPass(camera, camera, frame, frame * 20);
      expect(cutaway.value).toBe(1);
      expect(cutaway.valueForPass(other, camera, 15, 310)).toBe(0);
      expect(cutaway.valueForPass(camera, camera, 15, 320)).toBe(1);
      expect(cutaway.decisionCount).toBe(1);
      expect(() => cutaway.valueForPass(camera, camera, NaN, 320)).toThrow(
        /frame owner/,
      );
      expect(() => cutaway.valueForPass(camera, camera, -1, 320)).toThrow(
        /frame owner/,
      );
      expect(() => cutaway.valueForPass(camera, camera, 1.5, 320)).toThrow(
        /frame owner/,
      );
      // A new main camera at the same frame gets its own decision, without sharing visibility.
      other.updateMatrixWorld(true);
      expect(cutaway.valueForPass(other, other, 15, 320)).toBeLessThan(1);
      expect(cutaway.desired).toBe(false);
      expect(cutaway.decisionCount).toBe(2);
    });

    it("rejects invalid clocks and keeps endpoints bounded for backward time", () => {
      const { camera, cutaway } = fixture(architecturalFinish);
      expect(() => cutaway.update(camera, NaN)).toThrow(/finite clock/);
      cutaway.update(camera, 100);
      cutaway.update(camera, 0);
      expect(cutaway.value).toBe(0);
      settle(cutaway, camera, 120);
      expect(cutaway.value).toBe(1);
    });
  },
);
