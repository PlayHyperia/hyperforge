import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  inferLOD1Path,
  inferLOD2Path,
  resolveLOD1ModelPath,
  resolveLOD2ModelPath,
  projectedTreeBoundsPixels,
  selectProjectedTreeLod,
} from "../LODConfig";

describe("LODConfig path resolution", () => {
  it("infers lod1 paths when no explicit path is provided", () => {
    expect(
      resolveLOD1ModelPath(
        "asset://models/mining-rocks/coal-rock/coal-rock.glb",
        undefined,
      ),
    ).toBe("asset://models/mining-rocks/coal-rock/coal-rock_lod1.glb");
  });

  it("infers lod2 paths when no explicit path is provided", () => {
    expect(
      resolveLOD2ModelPath(
        "asset://models/mining-rocks/coal-rock/coal-rock.glb",
        undefined,
      ),
    ).toBe("asset://models/mining-rocks/coal-rock/coal-rock_lod2.glb");
  });

  it("disables inference when a manifest explicitly sets lod paths to null", () => {
    expect(
      resolveLOD1ModelPath(
        "asset://models/mining-rocks/coal-rock/coal-rock.glb",
        null,
      ),
    ).toBeNull();
    expect(
      resolveLOD2ModelPath(
        "asset://models/mining-rocks/coal-rock/coal-rock.glb",
        null,
      ),
    ).toBeNull();
  });

  it("treats empty explicit paths as disabled", () => {
    expect(resolveLOD1ModelPath("asset://models/example.glb", "")).toBeNull();
    expect(
      resolveLOD2ModelPath("asset://models/example.glb", "   "),
    ).toBeNull();
  });

  it("prefers explicit lod paths when present", () => {
    expect(
      resolveLOD1ModelPath(
        "asset://models/mining-rocks/coal-rock/coal-rock.glb",
        "asset://models/mining-rocks/coal-rock/custom_lod1.glb",
      ),
    ).toBe("asset://models/mining-rocks/coal-rock/custom_lod1.glb");
    expect(
      resolveLOD2ModelPath(
        "asset://models/mining-rocks/coal-rock/coal-rock.glb",
        "asset://models/mining-rocks/coal-rock/custom_lod2.glb",
      ),
    ).toBe("asset://models/mining-rocks/coal-rock/custom_lod2.glb");
  });

  it("keeps the raw inference helpers unchanged", () => {
    expect(inferLOD1Path("trees/oak.glb")).toBe("trees/oak_lod1.glb");
    expect(inferLOD2Path("trees/oak.glb")).toBe("trees/oak_lod2.glb");
  });
});

describe("projected tree LOD trial math (real Three objects, no rendering)", () => {
  function camera() {
    const value = new THREE.PerspectiveCamera(90, 2, 1, 1000);
    value.coordinateSystem = THREE.WebGPUCoordinateSystem;
    value.updateProjectionMatrix();
    value.updateMatrixWorld(true);
    return value;
  }
  const bounds = new THREE.Box3(
    new THREE.Vector3(-1, -2, -0.5),
    new THREE.Vector3(1, 2, 0.5),
  );

  it("uses full depth extent and native pixels, not CSS size or center distance", () => {
    const c = camera(),
      matrix = new THREE.Matrix4().makeTranslation(0, 0, -20);
    const pixels = projectedTreeBoundsPixels(bounds, matrix, c, 2000, 1000);
    expect(pixels).toBeCloseTo((4 * 500) / 19.5, 10);
    expect(projectedTreeBoundsPixels(bounds, matrix, c, 1000, 500)).toBeCloseTo(
      pixels / 2,
      10,
    );
    c.fov = 45;
    c.updateProjectionMatrix();
    expect(
      projectedTreeBoundsPixels(bounds, matrix, c, 2000, 1000),
    ).toBeGreaterThan(pixels * 2);
  });

  it("includes parent rotation/nonuniform scale, offset bounds and real camera view", () => {
    const c = camera();
    c.position.set(2, 3, 8);
    c.lookAt(0, 0, -15);
    c.updateMatrixWorld(true);
    const parent = new THREE.Group(),
      mesh = new THREE.Object3D();
    parent.position.set(3, -1, -25);
    parent.rotation.set(0.1, 0.7, 0.2);
    parent.scale.set(2, 0.75, 1.5);
    mesh.position.set(-2, 1, 0);
    mesh.rotation.y = -0.4;
    parent.add(mesh);
    parent.updateMatrixWorld(true);
    const box = new THREE.Box3(
      new THREE.Vector3(-3, -4, -2),
      new THREE.Vector3(2, 7, 1),
    );
    const before = {
      box: box.clone(),
      matrix: mesh.matrixWorld.clone(),
      camera: c.matrixWorldInverse.clone(),
    };
    const corners = Array.from({ length: 8 }, (_, i) =>
      new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      )
        .applyMatrix4(mesh.matrixWorld)
        .project(c),
    );
    const expected = Math.max(
      (Math.max(...corners.map((p) => p.x)) -
        Math.min(...corners.map((p) => p.x))) *
        1512,
      (Math.max(...corners.map((p) => p.y)) -
        Math.min(...corners.map((p) => p.y))) *
        862,
    );
    expect(
      projectedTreeBoundsPixels(box, mesh.matrixWorld, c, 3024, 1724),
    ).toBeCloseTo(expected, 9);
    expect(box.equals(before.box)).toBe(true);
    expect(mesh.matrixWorld.equals(before.matrix)).toBe(true);
    expect(c.matrixWorldInverse.equals(before.camera)).toBe(true);
  });

  it("keeps full detail at/through the near plane, behind the eye and on invalid inputs", () => {
    const c = camera();
    for (const z of [-1.5, -1, 0, 3])
      expect(
        projectedTreeBoundsPixels(
          bounds,
          new THREE.Matrix4().makeTranslation(0, 0, z),
          c,
          2000,
          1000,
        ),
      ).toBe(Infinity);
    const matrix = new THREE.Matrix4().makeTranslation(0, 0, -20);
    for (const [w, h] of [
      [0, 1000],
      [2000, 0],
      [NaN, 1000],
      [2000, Infinity],
    ])
      expect(projectedTreeBoundsPixels(bounds, matrix, c, w, h)).toBe(Infinity);
    expect(
      projectedTreeBoundsPixels(
        bounds,
        new THREE.Matrix4().makeScale(0, 0, 0),
        c,
        2000,
        1000,
      ),
    ).toBe(Infinity);
    matrix.elements[12] = NaN;
    expect(projectedTreeBoundsPixels(bounds, matrix, c, 2000, 1000)).toBe(
      Infinity,
    );
  });

  it("uses explicit 150/167 pixel hysteresis and never selects LOD2", () => {
    expect(selectProjectedTreeLod(150, 0)).toBe(1);
    expect(selectProjectedTreeLod(150.001, 0)).toBe(0);
    expect(selectProjectedTreeLod(166.999, 1)).toBe(1);
    expect(selectProjectedTreeLod(167, 1)).toBe(0);
    expect(selectProjectedTreeLod(0, 2)).toBe(1);
    for (const value of [NaN, Infinity, -1])
      expect(selectProjectedTreeLod(value, 1)).toBe(0);
  });
});
