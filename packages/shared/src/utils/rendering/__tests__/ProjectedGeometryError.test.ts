import { describe, expect, it } from "vitest";
import THREE from "../../../extras/three/three";
import { ProjectedGeometryError } from "../ProjectedGeometryError";

const bounds = new THREE.Box3(
  new THREE.Vector3(-0.9, -0.7, -0.6),
  new THREE.Vector3(0.8, 1.1, 0.5),
);

function project(
  point: THREE.Vector3,
  model: THREE.Matrix4,
  camera: THREE.Camera,
  width: number,
  height: number,
) {
  const p = point.clone().applyMatrix4(model).project(camera);
  return new THREE.Vector2(p.x * width * 0.5, p.y * height * 0.5);
}

function cameras() {
  const perspective = new THREE.PerspectiveCamera(61, 16 / 9, 0.1, 1000);
  perspective.position.set(3, 4, 12);
  perspective.lookAt(0, 1, -4);
  const offset = perspective.clone();
  offset.zoom = 1.7;
  offset.setViewOffset(2560, 1440, 830, 170, 1280, 720);
  offset.updateProjectionMatrix();
  const orthographic = new THREE.OrthographicCamera(-8, 11, 7, -5, 0.1, 1000);
  orthographic.position.set(6, 9, 14);
  orthographic.lookAt(-2, 0, -5);
  orthographic.zoom = 1.4;
  orthographic.setViewOffset(1600, 1200, 100, 170, 1000, 800);
  orthographic.updateProjectionMatrix();
  for (const camera of [perspective, offset, orthographic])
    camera.updateMatrixWorld(true);
  return [perspective, offset, orthographic];
}

function nestedModel() {
  const parent = new THREE.Group(),
    child = new THREE.Object3D();
  parent.position.set(-0.4, 0.2, -4);
  parent.rotation.set(0.3, 0.6, -0.2);
  parent.scale.set(1.4, 0.7, 1.1);
  child.position.set(1, -0.2, -0.5);
  child.rotation.set(-0.4, 0.2, 0.7);
  child.scale.set(0.6, 1.7, 0.9);
  parent.add(child);
  parent.updateMatrixWorld(true);
  return child.matrixWorld.clone();
}

describe("conservative actual-camera projected geometry bounds", () => {
  it("bounds dense real Three projections and local error shells under nested nonuniform transforms", () => {
    const helper = new ProjectedGeometryError(),
      model = nestedModel(),
      error = 0.024;
    for (const camera of cameras()) {
      const before = {
        projection: camera.projectionMatrix.elements.slice(),
        inverse: camera.matrixWorldInverse.elements.slice(),
        world: camera.matrixWorld.elements.slice(),
      };
      for (const [width, height] of [
        [1280, 720],
        [720, 1280],
        [2560, 1440],
      ]) {
        const measured = helper.measure(
          camera,
          model,
          bounds,
          error,
          width,
          height,
        );
        expect(Number.isFinite(measured.errorPixels)).toBe(true);
        let minX = Infinity,
          maxX = -Infinity,
          minY = Infinity,
          maxY = -Infinity;
        for (let ix = 0; ix <= 4; ix++)
          for (let iy = 0; iy <= 4; iy++)
            for (let iz = 0; iz <= 4; iz++) {
              const point = new THREE.Vector3(
                THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, ix / 4),
                THREE.MathUtils.lerp(bounds.min.y, bounds.max.y, iy / 4),
                THREE.MathUtils.lerp(bounds.min.z, bounds.max.z, iz / 4),
              );
              const baseline = project(point, model, camera, width, height);
              minX = Math.min(minX, baseline.x);
              maxX = Math.max(maxX, baseline.x);
              minY = Math.min(minY, baseline.y);
              maxY = Math.max(maxY, baseline.y);
              for (let x = -1; x <= 1; x++)
                for (let y = -1; y <= 1; y++)
                  for (let z = -1; z <= 1; z++) {
                    if (x === 0 && y === 0 && z === 0) continue;
                    const displaced = point
                      .clone()
                      .add(
                        new THREE.Vector3(x, y, z)
                          .normalize()
                          .multiplyScalar(error),
                      );
                    expect(
                      project(
                        displaced,
                        model,
                        camera,
                        width,
                        height,
                      ).distanceTo(baseline),
                    ).toBeLessThanOrEqual(measured.errorPixels + 1e-9);
                  }
            }
        expect(measured.extentPixels).toBeCloseTo(
          Math.max(maxX - minX, maxY - minY),
          9,
        );
      }
      expect(camera.projectionMatrix.elements).toEqual(before.projection);
      expect(camera.matrixWorldInverse.elements).toEqual(before.inverse);
      expect(camera.matrixWorld.elements).toEqual(before.world);
    }
  });

  it("uses view depth, off-axis projection, zoom and current physical viewport rather than camera distance", () => {
    const helper = new ProjectedGeometryError(),
      camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000),
      box = new THREE.Box3(
        new THREE.Vector3(-0.1, -0.1, -0.1),
        new THREE.Vector3(0.1, 0.1, 0.1),
      );
    camera.updateMatrixWorld(true);
    const center = {
      ...helper.measure(
        camera,
        new THREE.Matrix4().makeTranslation(0, 0, -10),
        box,
        0.02,
        1280,
        720,
      ),
    };
    const edge = {
      ...helper.measure(
        camera,
        new THREE.Matrix4().makeTranslation(9, 0, -4.358898943540674),
        box,
        0.02,
        1280,
        720,
      ),
    };
    expect(edge.errorPixels).toBeGreaterThan(center.errorPixels * 2);
    expect(edge.extentPixels).toBeGreaterThan(center.extentPixels * 2);
    const model = new THREE.Matrix4().makeTranslation(0, 0, -10);
    const doubled = helper.measure(camera, model, box, 0.02, 2560, 1440);
    expect(doubled.errorPixels).toBeCloseTo(center.errorPixels * 2, 12);
    expect(doubled.extentPixels).toBeCloseTo(center.extentPixels * 2, 12);
    camera.zoom = 2;
    camera.updateProjectionMatrix();
    const zoomed = helper.measure(camera, model, box, 0.02, 1280, 720);
    expect(zoomed.errorPixels).toBeCloseTo(center.errorPixels * 2, 12);
    expect(zoomed.extentPixels).toBeCloseTo(center.extentPixels * 2, 12);
  });

  it("uses orthographic projection without a spurious distance falloff", () => {
    const helper = new ProjectedGeometryError(),
      camera = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 1000);
    camera.updateMatrixWorld(true);
    const near = {
      ...helper.measure(
        camera,
        new THREE.Matrix4().makeTranslation(0, 0, -5),
        bounds,
        0.02,
        1280,
        720,
      ),
    };
    const far = helper.measure(
      camera,
      new THREE.Matrix4().makeTranslation(0, 0, -500),
      bounds,
      0.02,
      1280,
      720,
    );
    expect(far).toEqual(near);
    expect(far.errorPixels).toBeCloseTo(
      Math.hypot((0.02 * 1280) / 8, (0.02 * 720) / 6),
      12,
    );
  });

  it("bounds actual rotating Three sun-shadow cameras even when inverse homogeneous W is not exactly one", () => {
    const helper = new ProjectedGeometryError(),
      scene = new THREE.Scene(),
      sun = new THREE.DirectionalLight(),
      viewModel = new THREE.Matrix4();
    // Actual compact island light anchor and native singleton mushroom matrix.
    const anchor = new THREE.Vector3(350, 28.15, 400),
      model = new THREE.Matrix4().fromArray([
        -0.05018487572669983, 0, -0.11872151494026184, 0, 0, 0.1288926601409912,
        0, 0, 0.11872151494026184, 0, -0.05018487572669983, 0,
        382.8948669433594, 28.54891014099121, 323.546630859375, 1,
      ]),
      sourceBounds = new THREE.Box3(
        new THREE.Vector3(
          -0.9519606828689575,
          -1.0055515766143799,
          -0.9518159031867981,
        ),
        new THREE.Vector3(
          0.9496526718139648,
          1.0008939504623413,
          0.9556758999824524,
        ),
      );
    scene.add(sun, sun.target);
    sun.target.position.copy(anchor);
    const camera = sun.shadow.camera;
    camera.left = camera.bottom = -200;
    camera.right = camera.top = 200;
    camera.near = 0.5;
    camera.far = 600;
    camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
    camera.updateProjectionMatrix();
    let nonUnitInverseW = 0;
    for (let degree = 0; degree < 360; degree++) {
      const angle = THREE.MathUtils.degToRad(degree);
      sun.position.set(
        anchor.x + Math.cos(angle) * 200,
        anchor.y + 400,
        anchor.z + Math.sin(angle) * 200,
      );
      scene.updateMatrixWorld(true);
      sun.shadow.updateMatrices(sun);
      viewModel.multiplyMatrices(camera.matrixWorldInverse, model);
      if (viewModel.elements[15] !== 1) nonUnitInverseW++;
      const before = camera.matrixWorldInverse.elements.slice();
      const measured = helper.measure(
        camera,
        model,
        sourceBounds,
        0.024,
        4096,
        4096,
      );
      expect(Number.isFinite(measured.errorPixels)).toBe(true);
      expect(measured.errorPixels).toBeGreaterThan(0);
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      for (let corner = 0; corner < 8; corner++) {
        const point = new THREE.Vector3(
          corner & 1 ? sourceBounds.max.x : sourceBounds.min.x,
          corner & 2 ? sourceBounds.max.y : sourceBounds.min.y,
          corner & 4 ? sourceBounds.max.z : sourceBounds.min.z,
        );
        const baseline = project(point, model, camera, 4096, 4096);
        minX = Math.min(minX, baseline.x);
        maxX = Math.max(maxX, baseline.x);
        minY = Math.min(minY, baseline.y);
        maxY = Math.max(maxY, baseline.y);
        for (const direction of [
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(1, -1, 1).normalize(),
        ]) {
          for (const sign of [-1, 1]) {
            const displaced = point
              .clone()
              .addScaledVector(direction, 0.024 * sign);
            expect(
              project(displaced, model, camera, 4096, 4096).distanceTo(
                baseline,
              ),
            ).toBeLessThanOrEqual(measured.errorPixels + 1e-9);
          }
        }
      }
      expect(measured.extentPixels).toBeCloseTo(
        Math.max(maxX - minX, maxY - minY),
        9,
      );
      expect(camera.matrixWorldInverse.elements).toEqual(before);
    }
    expect(nonUnitInverseW).toBeGreaterThan(0);
  });

  it("preserves the projection bound and physical near-plane guard under positive constant homogeneous rescaling", () => {
    const helper = new ProjectedGeometryError(),
      box = new THREE.Box3(
        new THREE.Vector3(-0.1, -0.1, -0.1),
        new THREE.Vector3(0.1, 0.1, 0.1),
      );
    for (const camera of [
      new THREE.PerspectiveCamera(60, 1, 0.1, 100),
      new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100),
    ]) {
      camera.updateMatrixWorld(true);
      for (const z of [-10, -0.24, -0.22, 1]) {
        const model = new THREE.Matrix4().makeTranslation(0, 0, z);
        const original = {
          ...helper.measure(camera, model, box, 0.03, 720, 720),
        };
        expect(Number.isFinite(original.errorPixels)).toBe(z < -0.22);
        for (const scale of [0.25, 4, 1 - Number.EPSILON, 1 + Number.EPSILON]) {
          const actual = helper.measure(
            camera,
            model.clone().multiplyScalar(scale),
            box,
            0.03,
            720,
            720,
          );
          if (Number.isFinite(original.errorPixels)) {
            expect(actual.errorPixels).toBeCloseTo(original.errorPixels, 9);
            expect(actual.extentPixels).toBeCloseTo(original.extentPixels, 9);
          } else
            expect(actual).toEqual({
              errorPixels: Infinity,
              extentPixels: Infinity,
            });
        }
      }
      for (const w of [0, -1]) {
        const invalid = new THREE.Matrix4().makeTranslation(0, 0, -10);
        invalid.elements[15] = w;
        expect(helper.measure(camera, invalid, box, 0.03, 720, 720)).toEqual({
          errorPixels: Infinity,
          extentPixels: Infinity,
        });
      }
      for (const index of [3, 7, 11]) {
        const projective = new THREE.Matrix4().makeTranslation(0, 0, -10);
        projective.elements[index] = Number.EPSILON;
        expect(helper.measure(camera, projective, box, 0.03, 720, 720)).toEqual(
          { errorPixels: Infinity, extentPixels: Infinity },
        );
      }
    }
  });

  it("fails closed for near-plane intersections including the scaled error shell and behind-camera boxes", () => {
    const helper = new ProjectedGeometryError(),
      box = new THREE.Box3(
        new THREE.Vector3(-0.1, -0.1, -0.1),
        new THREE.Vector3(0.1, 0.1, 0.1),
      );
    for (const camera of [
      new THREE.PerspectiveCamera(60, 1, 0.1, 100),
      new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100),
    ]) {
      camera.updateMatrixWorld(true);
      for (const z of [-0.2, -0.15, 0, 1])
        expect(
          helper.measure(
            camera,
            new THREE.Matrix4().makeTranslation(0, 0, z),
            box,
            0,
            720,
            720,
          ),
        ).toEqual({ errorPixels: Infinity, extentPixels: Infinity });
      const model = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, -0.35),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 2),
      );
      expect(
        Number.isFinite(
          helper.measure(camera, model, box, 0, 720, 720).errorPixels,
        ),
      ).toBe(true);
      expect(helper.measure(camera, model, box, 0.03, 720, 720)).toEqual({
        errorPixels: Infinity,
        extentPixels: Infinity,
      });
    }
  });

  it("reuses its record, accepts zero error, and rejects invalid input without leaking the previous answer", () => {
    const helper = new ProjectedGeometryError(),
      camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100),
      model = new THREE.Matrix4().makeTranslation(0, 0, -10);
    camera.updateMatrixWorld(true);
    const first = helper.measure(camera, model, bounds, 0, 720, 720);
    expect(first.errorPixels).toBe(0);
    expect(first.extentPixels).toBeGreaterThan(0);
    expect(helper.measure(camera, model, bounds, 0.02, 720, 720)).toBe(first);
    for (const value of [NaN, Infinity, -1, 0]) {
      expect(helper.measure(camera, model, bounds, 0.02, value, 720)).toEqual({
        errorPixels: Infinity,
        extentPixels: Infinity,
      });
      expect(helper.measure(camera, model, bounds, 0.02, 720, value)).toEqual({
        errorPixels: Infinity,
        extentPixels: Infinity,
      });
    }
    for (const value of [NaN, Infinity, -1])
      expect(helper.measure(camera, model, bounds, value, 720, 720)).toEqual({
        errorPixels: Infinity,
        extentPixels: Infinity,
      });
    expect(
      helper.measure(new THREE.Camera(), model, bounds, 0.02, 720, 720),
    ).toEqual({ errorPixels: Infinity, extentPixels: Infinity });
    expect(
      helper.measure(camera, model, new THREE.Box3(), 0.02, 720, 720),
    ).toEqual({ errorPixels: Infinity, extentPixels: Infinity });
    for (const matrix of [
      model,
      camera.matrixWorldInverse,
      camera.projectionMatrix,
    ]) {
      const original = matrix.elements[0];
      matrix.elements[0] = NaN;
      expect(helper.measure(camera, model, bounds, 0.02, 720, 720)).toEqual({
        errorPixels: Infinity,
        extentPixels: Infinity,
      });
      matrix.elements[0] = original;
    }
    model.elements[3] = 0.1;
    expect(helper.measure(camera, model, bounds, 0.02, 720, 720)).toEqual({
      errorPixels: Infinity,
      extentPixels: Infinity,
    });
  });

  it("fails closed when finite inputs overflow during projection or error expansion", () => {
    const helper = new ProjectedGeometryError(),
      camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100),
      model = new THREE.Matrix4().makeScale(1e200, 1e200, 1);
    model.setPosition(0, 0, -10);
    camera.updateMatrixWorld(true);
    const enormous = new THREE.Box3(
      new THREE.Vector3(-1e200, -1e200, -1),
      new THREE.Vector3(1e200, 1e200, 1),
    );
    expect(helper.measure(camera, model, enormous, 0.02, 720, 720)).toEqual({
      errorPixels: Infinity,
      extentPixels: Infinity,
    });
    expect(helper.measure(camera, model, bounds, 1e200, 720, 720)).toEqual({
      errorPixels: Infinity,
      extentPixels: Infinity,
    });
    const invalidBox = bounds.clone();
    invalidBox.min.y = NaN;
    expect(helper.measure(camera, model, invalidBox, 0.02, 720, 720)).toEqual({
      errorPixels: Infinity,
      extentPixels: Infinity,
    });
  });
});
