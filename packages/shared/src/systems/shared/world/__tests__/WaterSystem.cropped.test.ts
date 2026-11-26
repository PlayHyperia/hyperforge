import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { float } from "three/tsl";

/** Re-evaluate the URL-captured application singleton, not Three's external
 * classes. No mock modules, replaced render methods, GPU or world loop. */
async function loadModules(enabled: boolean) {
  const dom = new JSDOM("<!doctype html>", {
    url: `http://localhost/${enabled ? "?reflectionCapture=cropped-v1" : ""}`,
  });
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: dom.window,
  });
  try {
    vi.resetModules();
    const [{ WaterSystem }, { World }, screen, shadows] = await Promise.all([
      import("../WaterSystem"),
      import("../../../../core/World"),
      import("../../../../extras/three/CroppedReflectionScreen"),
      import("../../../../extras/three/UniformDirectionalShadow"),
    ]);
    expect(screen.croppedReflectionScreen.enabled).toBe(enabled);
    return { WaterSystem, World, ...screen, ...shadows };
  } finally {
    if (prior) Object.defineProperty(globalThis, "window", prior);
    else Reflect.deleteProperty(globalThis, "window");
    dom.window.close();
  }
}

type Modules = Awaited<ReturnType<typeof loadModules>>;
function fixture(modules: Modules) {
  const dom = new JSDOM("<!doctype html><canvas></canvas>");
  const renderer = new THREE.WebGPURenderer({
    canvas: dom.window.document.querySelector("canvas")!,
  });
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const world = new modules.World();
  const water = new modules.WaterSystem(world);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1512 / 862, 0.1, 500);
  const target = new THREE.RenderTarget(1512, 862, { samples: 0 });
  const pixels = new THREE.Vector4(768, 344, 744, 128);
  expect(world.camera).toBeInstanceOf(THREE.PerspectiveCamera);
  const begin = () =>
    water["beginLakeCroppedCapture"](
      renderer,
      scene,
      camera,
      target,
      1512,
      862,
      pixels,
    );
  const frame = new THREE.NodeFrame();
  frame.renderer = renderer;
  frame.scene = scene;
  frame.camera = camera;
  const updateCoordinates = () => {
    frame.renderId++;
    for (const node of Object.values(modules.croppedReflectionScreen.uniforms!))
      frame.updateNode(node);
  };
  const callbacks = () => ({
    before: Object.getOwnPropertyDescriptor(scene, "onBeforeRender"),
    after: Object.getOwnPropertyDescriptor(scene, "onAfterRender"),
  });
  const close = () => {
    for (const object of scene.children) {
      if (
        object instanceof THREE.Mesh ||
        object instanceof THREE.Points ||
        object instanceof THREE.Line
      ) {
        object.geometry.dispose();
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material])
          material.dispose();
      }
      if (
        object instanceof THREE.DirectionalLight ||
        object instanceof THREE.PointLight
      )
        object.shadow.dispose();
    }
    target.dispose();
    dom.window.close();
  };
  return {
    renderer,
    water,
    scene,
    camera,
    target,
    pixels,
    frame,
    begin,
    callbacks,
    updateCoordinates,
    close,
  };
}

describe.sequential(
  "cropped lake capture admission and synchronous lease",
  () => {
    it.each([false, true])(
      "keeps shader setup sizing separate from sampled crop ownership (enabled=%s)",
      async (enabled) => {
        const modules = await loadModules(enabled),
          f = fixture(modules);
        const reflection = f.water["createReflection"]();
        const foreign = new THREE.RenderTarget(13, 17);
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(),
          new THREE.MeshStandardNodeMaterial(),
        );
        const crop = new THREE.Vector4(
          1.96875,
          862 / 134,
          -0.96875,
          -344 / 134,
        );
        const capacity = new modules.ReflectionCropCapacity();
        const required = new THREE.Vector4(744, 344, 744, 128);
        try {
          f.renderer.setSize(3024, 1724, false);
          f.water["reflectionCropUv"].value.copy(crop);
          f.water["reflectionCropCapacities"] = new WeakMap([
            [foreign, capacity],
          ]);
          expect(capacity.select(required, 1512, 862)).not.toBeNull();
          const resize: unknown = Reflect.get(
            reflection.reflector,
            "_updateResolution",
          );
          if (typeof resize !== "function")
            throw new Error("Native resize missing");
          Reflect.apply(resize, reflection.reflector, [foreign, f.renderer]);
          expect([foreign.width, foreign.height]).toEqual([1512, 862]);
          expect(f.water["reflectionCropUv"].value.equals(crop)).toBe(true);
          // A foreign full resize must not put its existing planner into the
          // eight-update fallback/re-entry state either.
          expect(capacity.select(required, 1512, 862)).not.toBeNull();

          // Exercise r186's actual setup -> _updateResolution(_defaultRT),
          // not a copied setup algorithm or replacement renderer method.
          const builder = new THREE.WGSLNodeBuilder(mesh, f.renderer);
          reflection.reflector.setup(builder);
          expect(f.water["reflectionCropUv"].value.equals(crop)).toBe(true);
          expect(capacity.select(required, 1512, 862)).not.toBeNull();
          expect(f.renderer.hasInitialized()).toBe(false);
        } finally {
          foreign.dispose();
          reflection.dispose();
          mesh.geometry.dispose();
          mesh.material.dispose();
          await f.renderer.dispose();
          f.close();
        }
      },
    );

    it.each([false, true])(
      "keeps authentic full fallback owned and releases resize ownership (enabled=%s)",
      async (enabled) => {
        const modules = await loadModules(enabled),
          f = fixture(modules);
        const reflection = f.water["createReflection"]();
        const material = new THREE.MeshStandardNodeMaterial();
        f.water["lakeMaterial"] = material;
        const lake = new THREE.Mesh(
          new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2),
          material,
        );
        f.scene.add(lake);
        f.scene.updateMatrixWorld(true);
        f.water.registerWaterMesh(lake);
        f.frame.object = lake;
        f.frame.material = material;
        f.camera.position.set(0, -2, 3);
        f.camera.lookAt(0, 0, 0);
        f.camera.updateMatrixWorld(true);
        f.renderer.setSize(3024, 1724, false);
        const mirror = reflection.reflector.getVirtualCamera(f.camera);
        const actualTarget = reflection.reflector.getRenderTarget(mirror);
        const capacity = new modules.ReflectionCropCapacity();
        const required = new THREE.Vector4(744, 344, 744, 128);
        const crop = new THREE.Vector4(
          1.96875,
          862 / 134,
          -0.96875,
          -344 / 134,
        );
        try {
          f.water["reflectionCropCapacities"] = new WeakMap([
            [actualTarget, capacity],
          ]);
          expect(capacity.select(required, 1512, 862)).not.toBeNull();
          actualTarget.setSize(768, 134);
          f.water["reflectionCropUv"].value.copy(crop);
          // The actual native update sizes the registered capture, then returns
          // for a camera below the plane before rendering. Enabled admission
          // fails full because no normal texture/UV graph is prepared.
          expect(reflection.reflector.updateBefore(f.frame)).toBeUndefined();
          expect([actualTarget.width, actualTarget.height]).toEqual([
            1512, 862,
          ]);
          expect(f.water["reflectionCropUv"].value.toArray()).toEqual([
            1, 1, 0, 0,
          ]);
          expect(capacity.select(required, 1512, 862)).toBeNull();
          expect(f.renderer.hasInitialized()).toBe(false);

          // Even this real camera target has no mutation authority outside the
          // completed native update. This checks the finally-restored owner.
          f.water["reflectionCropUv"].value.copy(crop);
          const resize: unknown = Reflect.get(
            reflection.reflector,
            "_updateResolution",
          );
          if (typeof resize !== "function")
            throw new Error("Native resize missing");
          Reflect.apply(resize, reflection.reflector, [
            actualTarget,
            f.renderer,
          ]);
          expect(f.water["reflectionCropUv"].value.equals(crop)).toBe(true);
        } finally {
          f.water.unregisterWaterMesh(lake);
          f.scene.remove(lake);
          lake.geometry.dispose();
          material.dispose();
          reflection.dispose();
          await f.renderer.dispose();
          f.close();
        }
      },
    );

    it("keeps default graphs off and rejects runtime activation without the selected graph", async () => {
      const modules = await loadModules(false),
        f = fixture(modules);
      try {
        const before = f.callbacks();
        expect(f.water["reflectionCropCapacities"]).toBeNull();
        expect(f.begin()).toBeNull();
        expect(() => f.water.setReflectionCropEnabled(true)).toThrow(
          "opt-in shader graph",
        );
        expect(() => f.water.setReflectionCropEnabled(false)).not.toThrow();
        expect(f.begin()).toBeNull();
        expect(f.callbacks()).toEqual(before);
        expect([f.target.width, f.target.height]).toEqual([1512, 862]);
      } finally {
        f.close();
      }
    });

    it("retires only candidate capacity metadata on mode changes and destruction", async () => {
      const modules = await loadModules(true),
        f = fixture(modules);
      try {
        const capacity = new modules.ReflectionCropCapacity();
        const owners = new WeakMap([[f.target, capacity]]);
        f.water["reflectionCropCapacities"] = owners;
        f.water.setReflectionCropEnabled(true);
        expect(f.water["reflectionCropCapacities"]).toBe(owners);
        f.water.setReflectionCropEnabled(false);
        expect(f.water["reflectionCropCapacities"]).toBeNull();
        f.water.setReflectionCropEnabled(true);
        expect(f.water["reflectionCropCapacities"]).toBeNull();
        f.water["reflectionCropCapacities"] = owners;
        f.water.destroy();
        expect(f.water["reflectionCropCapacities"]).toBeNull();
        expect([f.target.width, f.target.height]).toEqual([1512, 862]);
      } finally {
        f.close();
      }
    });

    it("can disable and re-enable the explicitly selected graph between captures", async () => {
      const modules = await loadModules(true),
        f = fixture(modules);
      try {
        const before = f.callbacks();
        f.water.setReflectionCropEnabled(false);
        expect(f.begin()).toBeNull();
        expect(f.callbacks()).toEqual(before);
        f.water.setReflectionCropEnabled(true);
        const end = f.begin();
        expect(end).toBeTypeOf("function");
        end!();
        expect(f.callbacks()).toEqual(before);
        f.water.setReflectionCropEnabled(false);
        expect(f.begin()).toBeNull();
      } finally {
        f.close();
      }
    });

    it.each([
      "renderer-scissor",
      "target-scissor",
      "msaa",
      "shadow-type",
      "point-shadow",
      "unowned-directional-shadow",
      "custom-shadow-filter",
      "transmission",
      "transmission-node",
      "points",
      "line",
      "sprite",
      "shader-material",
      "borrowed-before",
      "borrowed-after",
      "nonconfigurable",
      "not-extensible",
      "grass-footprint",
      "unaligned",
      "outside",
    ] as const)(
      "declines %s before installing callbacks or throwing",
      async (reason) => {
        const modules = await loadModules(true),
          f = fixture(modules);
        try {
          if (reason === "renderer-scissor") f.renderer.setScissorTest(true);
          if (reason === "target-scissor") f.target.scissorTest = true;
          if (reason === "msaa") f.target.samples = 4;
          if (reason === "shadow-type")
            f.renderer.shadowMap.type = THREE.BasicShadowMap;
          if (reason === "point-shadow") {
            const light = new THREE.PointLight();
            light.castShadow = true;
            f.scene.add(light);
          }
          if (
            reason === "unowned-directional-shadow" ||
            reason === "custom-shadow-filter"
          ) {
            const light = new THREE.DirectionalLight();
            light.castShadow = true;
            if (reason === "custom-shadow-filter") {
              light.shadow.shadowNode =
                new modules.UniformDirectionalShadowNode(light);
              Reflect.set(light.shadow, "filterNode", float(1));
            }
            f.scene.add(light);
          }
          if (reason === "transmission" || reason === "transmission-node") {
            const material = new THREE.MeshPhysicalNodeMaterial();
            if (reason === "transmission") material.transmission = 0.5;
            else material.transmissionNode = float(0.5);
            f.scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
          }
          if (reason === "points")
            f.scene.add(
              new THREE.Points(
                new THREE.BufferGeometry(),
                new THREE.PointsMaterial(),
              ),
            );
          if (reason === "line")
            f.scene.add(
              new THREE.Line(
                new THREE.BufferGeometry(),
                new THREE.LineBasicMaterial(),
              ),
            );
          if (reason === "sprite")
            f.scene.add(new THREE.Sprite(new THREE.SpriteMaterial()));
          if (reason === "shader-material")
            f.scene.add(
              new THREE.Mesh(
                new THREE.BoxGeometry(),
                new THREE.ShaderMaterial(),
              ),
            );
          if (reason === "borrowed-before") f.scene.onBeforeRender = () => {};
          if (reason === "borrowed-after") f.scene.onAfterRender = () => {};
          if (reason === "nonconfigurable")
            Object.defineProperty(f.scene, "onBeforeRender", {
              configurable: false,
              value: THREE.Object3D.prototype.onBeforeRender,
            });
          if (reason === "not-extensible") Object.preventExtensions(f.scene);
          if (reason === "grass-footprint")
            f.water.setReflectionGrassFootprintEnabled(true);
          if (reason === "unaligned") f.pixels.x++;
          if (reason === "outside") f.pixels.z++;
          const before = f.callbacks();
          const projection = f.camera.projectionMatrix.clone();
          expect(f.begin()).toBeNull();
          expect(f.callbacks()).toEqual(before);
          expect(f.camera.projectionMatrix.equals(projection)).toBe(true);
          expect(f.renderer.getRenderTarget()).toBeNull();
          expect([f.target.width, f.target.height]).toEqual([1512, 862]);
        } finally {
          f.close();
        }
      },
    );

    it("crops after the oblique projection and exactly restores callbacks, matrices and screen uniforms", async () => {
      const modules = await loadModules(true),
        f = fixture(modules);
      const light = new THREE.DirectionalLight();
      light.castShadow = true;
      light.shadow.shadowNode = new modules.UniformDirectionalShadowNode(light);
      f.scene.add(
        light,
        new THREE.Mesh(
          new THREE.BoxGeometry(),
          new THREE.MeshStandardNodeMaterial(),
        ),
      );
      Object.defineProperty(f.scene, "onBeforeRender", {
        configurable: true,
        writable: false,
        enumerable: true,
        value: THREE.Object3D.prototype.onBeforeRender,
      });
      const before = f.callbacks();
      const end = f.begin();
      try {
        expect(end).toBeTypeOf("function");
        expect(f.renderer.getRenderTarget()).toBeNull();
        expect([f.target.width, f.target.height]).toEqual([744, 128]);
        // Reproduce the native ordering: admission/resize precedes the final
        // oblique matrix; this is ordinary callback invocation, not rendering.
        f.camera.projectionMatrix.elements[2] = 0.12;
        f.camera.projectionMatrix.elements[6] = -0.24;
        f.camera.projectionMatrix.elements[10] = -0.61;
        f.camera.projectionMatrixInverse
          .copy(f.camera.projectionMatrix)
          .invert();
        const projection = f.camera.projectionMatrix.clone();
        const inverse = f.camera.projectionMatrixInverse.clone();
        // Installed declarations describe the six-argument object callback;
        // native Renderer invokes Scene callbacks with these four arguments.
        Reflect.apply(f.scene.onBeforeRender, f.scene, [
          f.renderer,
          f.scene,
          new THREE.PerspectiveCamera(),
          f.target,
        ]);
        expect(f.camera.projectionMatrix.equals(projection)).toBe(true);
        f.renderer.setRenderTarget(f.target);
        Reflect.apply(f.scene.onBeforeRender, f.scene, [
          f.renderer,
          f.scene,
          f.camera,
          f.target,
        ]);
        expect(
          f.camera.projectionMatrix.equals(
            modules.cropReflectionProjection(projection, f.pixels, 1512, 862),
          ),
        ).toBe(true);
        f.updateCoordinates();
        expect(
          modules.croppedReflectionScreen.uniforms!.pixelOffset.value.toArray(),
        ).toEqual([768, 344]);
        f.frame.camera = new THREE.OrthographicCamera();
        f.updateCoordinates();
        expect(
          modules.croppedReflectionScreen.uniforms!.pixelOffset.value.toArray(),
        ).toEqual([0, 0]);
        f.frame.camera = f.camera;
        f.updateCoordinates();
        expect(
          modules.croppedReflectionScreen.uniforms!.pixelOffset.value.toArray(),
        ).toEqual([768, 344]);
        Reflect.apply(f.scene.onAfterRender, f.scene, [
          f.renderer,
          f.scene,
          f.camera,
          f.target,
        ]);
        expect(f.camera.projectionMatrix.equals(projection)).toBe(true);
        expect(f.camera.projectionMatrixInverse.equals(inverse)).toBe(true);
        f.updateCoordinates();
        expect(
          modules.croppedReflectionScreen.uniforms!.pixelOffset.value.toArray(),
        ).toEqual([0, 0]);
        end!();
        end!();
        expect(f.callbacks()).toEqual(before);
        expect(f.renderer.getRenderTarget()).toBe(f.target);
      } finally {
        end?.();
        f.close();
      }
    });

    it("retires a started capture even when its after callback has not executed", async () => {
      const modules = await loadModules(true),
        f = fixture(modules);
      const before = f.callbacks();
      const projection = f.camera.projectionMatrix.clone();
      const inverse = f.camera.projectionMatrixInverse.clone();
      const end = f.begin();
      try {
        expect(end).toBeTypeOf("function");
        Reflect.apply(f.scene.onBeforeRender, f.scene, [
          f.renderer,
          f.scene,
          f.camera,
          f.target,
        ]);
        expect(f.camera.projectionMatrix.equals(projection)).toBe(false);
        end!();
        expect(f.camera.projectionMatrix.equals(projection)).toBe(true);
        expect(f.camera.projectionMatrixInverse.equals(inverse)).toBe(true);
        expect(f.callbacks()).toEqual(before);
        // A new lease proves cleanup did not leave the shared screen owner busy.
        const next = f.begin();
        expect(next).toBeTypeOf("function");
        next!();
      } finally {
        end?.();
        f.close();
      }
    });
    it("returns fallback without leaking callbacks when a different coordinate lease is already held", async () => {
      const modules = await loadModules(true),
        f = fixture(modules);
      const borrowedTarget = new THREE.RenderTarget(744, 128);
      const borrowedCamera = new THREE.PerspectiveCamera();
      const endBorrowed = modules.croppedReflectionScreen.begin({
        renderer: f.renderer,
        target: borrowedTarget,
        camera: borrowedCamera,
        fullWidth: 1512,
        fullHeight: 862,
        x: 768,
        y: 344,
        width: 744,
        height: 128,
      });
      try {
        const before = f.callbacks();
        const projection = f.camera.projectionMatrix.clone();
        expect(f.begin()).toBeNull();
        expect(f.callbacks()).toEqual(before);
        expect(f.camera.projectionMatrix.equals(projection)).toBe(true);
        expect(f.renderer.getRenderTarget()).toBeNull();
        f.renderer.setRenderTarget(borrowedTarget);
        f.frame.camera = borrowedCamera;
        f.updateCoordinates();
        expect(
          modules.croppedReflectionScreen.uniforms!.pixelOffset.value.toArray(),
        ).toEqual([768, 344]);
        endBorrowed();
        const next = f.begin();
        expect(next).toBeTypeOf("function");
        next!();
      } finally {
        endBorrowed();
        borrowedTarget.dispose();
        f.close();
      }
    });
  },
);
