import { describe, expect, it } from "vitest";
import THREE, { uniform } from "../three";
import { fitBoundedDirectionalShadow } from "../BoundedDirectionalShadow";

function lightAt(direction = new THREE.Vector3(0.4, 0.8, 0.3)) {
  const scene = new THREE.Scene();
  const light = new THREE.DirectionalLight(0xffeedd, 1.7);
  light.castShadow = true;
  light.position.copy(direction.normalize().multiplyScalar(400));
  light.shadow.camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  light.shadow.bias = 0.0002;
  light.shadow.normalBias = 0.01;
  scene.add(light, light.target);
  scene.updateMatrixWorld(true);
  return { light, scene };
}
const box = () =>
  new THREE.Box3(
    new THREE.Vector3(340, 0, 394),
    new THREE.Vector3(360, 3, 418),
  );
function corners(focus: THREE.Box3) {
  return Array.from(
    { length: 8 },
    (_, i) =>
      new THREE.Vector3(
        i & 1 ? focus.max.x : focus.min.x,
        i & 2 ? focus.max.y : focus.min.y,
        i & 4 ? focus.max.z : focus.min.z,
      ),
  );
}
function snapshot(light: THREE.DirectionalLight) {
  const camera = light.shadow.camera;
  return JSON.stringify({
    position: light.position.toArray(),
    target: light.target.position.toArray(),
    matrices: [
      light.matrix.toArray(),
      light.matrixWorld.toArray(),
      light.target.matrix.toArray(),
      light.target.matrixWorld.toArray(),
    ],
    camera: [
      camera.left,
      camera.right,
      camera.top,
      camera.bottom,
      camera.near,
      camera.far,
      camera.zoom,
      ...camera.up.toArray(),
      ...camera.projectionMatrix.elements,
      ...camera.matrixWorld.elements,
      ...light.shadow.matrix.elements,
    ],
    map: light.shadow.map?.uuid,
    mapPass: light.shadow.mapPass?.uuid,
    mapSize: light.shadow.mapSize.toArray(),
    needsUpdate: light.shadow.needsUpdate,
    color: light.color.toArray(),
    intensity: light.intensity,
  });
}

describe("opt-in bounded directional shadows with real Three objects", () => {
  it.each([
    new THREE.Vector3(0.4, 0.8, 0.3),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(1, 0.001, -0.5),
  ])(
    "contains all eight world corners in XY and WebGPU depth at a retained400m distance",
    (direction) => {
      const { light } = lightAt(direction);
      const before = light.position
        .clone()
        .sub(light.target.position)
        .normalize();
      const focus = box(),
        originalBox = focus.clone();
      const result = fitBoundedDirectionalShadow(light, focus);
      for (const p of corners(focus)) {
        const clip = p.clone().project(light.shadow.camera);
        expect(Math.abs(clip.x)).toBeLessThan(1);
        expect(Math.abs(clip.y)).toBeLessThan(1);
        expect(clip.z).toBeGreaterThan(0);
        expect(clip.z).toBeLessThan(1);
      }
      expect(focus.equals(originalBox)).toBe(true);
      const after = light.position
        .clone()
        .sub(light.target.position)
        .normalize();
      expect(after.distanceTo(before)).toBeLessThan(1e-12);
      expect(after.length()).toBeCloseTo(1, 14);
      expect(result.retainedLightDistance).toBeCloseTo(400, 10);
      expect(result.near).toBeGreaterThan(370);
      expect(result.far).toBeLessThan(430);
      expect(result.texelWorld).toBeLessThan(0.025);
      expect(light.shadow.mapSize.toArray()).toEqual([2048, 2048]);
      expect(light.color.getHex()).toBe(0xffeedd);
      expect(light.intensity).toBe(1.7);
      expect(light.shadow.bias).toBe(0.0002);
      expect(light.shadow.normalBias).toBe(0.01);
      expect(light.shadow.map).toBeNull();
    },
  );

  it("is independent of an orbit camera and stable for subtexel focus motion", () => {
    const { light, scene } = lightAt(new THREE.Vector3(0, 0, 1));
    const camera = new THREE.PerspectiveCamera();
    scene.add(camera);
    const focus = new THREE.Box3(
      new THREE.Vector3(-10, -2, -12),
      new THREE.Vector3(10, 2, 12),
    );
    const a = fitBoundedDirectionalShadow(light, focus);
    const target = light.target.position.clone();
    camera.position.set(300, 200, -100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    focus.translate(
      new THREE.Vector3(a.texelWorld * 0.2, a.texelWorld * 0.2, 0),
    );
    const b = fitBoundedDirectionalShadow(light, focus);
    expect(light.target.position.distanceTo(target)).toBeLessThan(1e-12);
    expect(b.texelWorld).toBeCloseTo(a.texelWorld, 14);
    expect(camera.position.toArray()).toEqual([300, 200, -100]);
    expect(light.position.toArray()).toEqual([0, 0, 400]);
  });

  it("fits parented light/target in world space without changing parent transforms", () => {
    const { light, scene } = lightAt();
    scene.position.set(4, 2, -3);
    scene.rotation.y = 0.3;
    scene.updateMatrixWorld(true);
    const parent = scene.matrix.clone();
    const before = light
      .getWorldPosition(new THREE.Vector3())
      .sub(light.target.getWorldPosition(new THREE.Vector3()))
      .normalize();
    fitBoundedDirectionalShadow(light, box(), { mapSize: 1024 });
    expect(scene.matrix.equals(parent)).toBe(true);
    const after = light
      .getWorldPosition(new THREE.Vector3())
      .sub(light.target.getWorldPosition(new THREE.Vector3()))
      .normalize();
    expect(before.distanceTo(after)).toBeLessThan(1e-12);
    for (const p of corners(box())) {
      const v = p.project(light.shadow.camera);
      expect(Math.abs(v.x)).toBeLessThan(1);
      expect(Math.abs(v.y)).toBeLessThan(1);
      expect(v.z).toBeGreaterThan(0);
      expect(v.z).toBeLessThan(1);
    }
  });

  it("rejects invalid bounds, disabled shadows and unsafe fits before mutation", () => {
    const { light } = lightAt();
    const invalid = [
      new THREE.Box3(),
      new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()),
      new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(2, 0, 2)),
      new THREE.Box3(new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(2, 2, 2)),
      new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(101, 2, 2)),
    ];
    for (const focus of invalid) {
      const before = snapshot(light);
      expect(() => fitBoundedDirectionalShadow(light, focus)).toThrow();
      expect(snapshot(light)).toBe(before);
    }
    for (const paddingWorld of [NaN, -1, 11]) {
      const before = snapshot(light);
      expect(() =>
        fitBoundedDirectionalShadow(light, box(), { paddingWorld }),
      ).toThrow();
      expect(snapshot(light)).toBe(before);
    }
    const oversizedTexture = JSON.parse('{"mapSize":4096}') as {
      mapSize: 2048;
    };
    const textureBefore = snapshot(light);
    expect(() =>
      fitBoundedDirectionalShadow(light, box(), oversizedTexture),
    ).toThrow();
    expect(snapshot(light)).toBe(textureBefore);
    light.castShadow = false;
    const disabled = snapshot(light);
    expect(() => fitBoundedDirectionalShadow(light, box())).toThrow();
    expect(snapshot(light)).toBe(disabled);
    light.castShadow = true;
    light.position.set(0, 1, 0);
    const short = snapshot(light);
    expect(() => fitBoundedDirectionalShadow(light, box())).toThrow();
    expect(snapshot(light)).toBe(short);
  });

  it("rejects coupled hierarchy and cropped shadow cameras before mutation", () => {
    const { light } = lightAt();
    light.add(light.target);
    const coupled = snapshot(light);
    expect(() => fitBoundedDirectionalShadow(light, box())).toThrow(/branches/);
    expect(snapshot(light)).toBe(coupled);
    light.remove(light.target);
    light.shadow.camera.setViewOffset(100, 100, 0, 0, 50, 50);
    const cropped = snapshot(light);
    expect(() => fitBoundedDirectionalShadow(light, box())).toThrow(
      /uncropped/,
    );
    expect(snapshot(light)).toBe(cropped);
  });

  it("rejects an actual custom Three shadow node before any mutation", () => {
    const { light } = lightAt();
    const shadow = light.shadow as THREE.DirectionalLightShadow & {
      shadowNode?: unknown;
    };
    const node = uniform(1);
    shadow.shadowNode = node;
    const before = snapshot(light);
    expect(() => fitBoundedDirectionalShadow(light, box())).toThrow(
      /single-map path/,
    );
    expect(snapshot(light)).toBe(before);
    expect(shadow.shadowNode).toBe(node);
    shadow.shadowNode = null;
    expect(() => fitBoundedDirectionalShadow(light, box())).not.toThrow();
  });

  it("rejects incompatible allocated maps without disposal and reuses compatible maps", () => {
    const { light } = lightAt();
    const map = new THREE.RenderTarget(4096, 4096);
    light.shadow.map = map;
    let disposed = 0;
    map.addEventListener("dispose", () => disposed++);
    const before = snapshot(light);
    expect(() => fitBoundedDirectionalShadow(light, box())).toThrow(/rebuild/);
    expect(snapshot(light)).toBe(before);
    expect(disposed).toBe(0);
    // Explicit caller-owned replacement; the helper never owns these resources.
    map.dispose();
    const compatible = new THREE.RenderTarget(2048, 2048);
    light.shadow.map = compatible;
    fitBoundedDirectionalShadow(light, box());
    expect(light.shadow.map).toBe(compatible);
    expect(disposed).toBe(1);
    compatible.dispose();
    light.shadow.map = null;
  });
});
