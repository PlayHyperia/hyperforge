import { afterEach, describe, expect, it } from "vitest";
import { createOpenWorkshop } from "@hyperforge/procgen/building";
import * as THREE from "../../../extras/three/three";
import { CompactRoofCutaway } from "../CompactRoofCutaway";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function fixture() {
  const geometry = createOpenWorkshop(
    Array.from({ length: 4 }, () => ({ bottom: -0.08, top: 0.22 })),
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

describe("compact smithy cutaway policy (CPU geometry, not visual/GPU acceptance)", () => {
  it("reveals the workshop from the unchanged native anvil camera without mutating prepared transforms", () => {
    const { root, camera, cutaway } = fixture();
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
    const { camera, cutaway, root } = fixture();
    settle(cutaway, camera);
    camera.lookAt(root.position.x + 20, root.position.y + 1.2, root.position.z);
    camera.updateMatrixWorld(true);
    cutaway.update(camera, 10000);
    expect(cutaway.desired).toBe(false);
    expect(cutaway.value).toBeCloseTo(1 - 0.05 / 0.22, 10);
    settle(cutaway, camera, 10020);
    expect(cutaway.value).toBe(0);
    expect(cutaway.decisionCount).toBe(2);
  });

  it("uses a transformed parent camera and does not hide the roof for a distant overview", () => {
    const { camera, cutaway, root } = fixture();
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
    const { root, roof, timber, camera, cutaway } = fixture();
    cutaway.installPointerFilter(roof);
    cutaway.installPointerFilter(timber);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(root.position.x, root.position.y + 9, root.position.z),
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
    const { geometry } = fixture();
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
    const { geometry } = fixture();
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

  it("rejects invalid clocks and keeps endpoints bounded for backward time", () => {
    const { camera, cutaway } = fixture();
    expect(() => cutaway.update(camera, NaN)).toThrow(/finite clock/);
    cutaway.update(camera, 100);
    cutaway.update(camera, 0);
    expect(cutaway.value).toBe(0);
    settle(cutaway, camera, 120);
    expect(cutaway.value).toBe(1);
  });
});
