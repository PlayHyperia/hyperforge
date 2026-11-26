import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import THREE from "../../../../extras/three/three";
import { ClientGraphics } from "../../../client/ClientGraphics";
import type { PostProcessingComposer } from "../../../../utils/rendering/PostProcessingFactory";
import { Environment } from "../Environment";
import { fogRenderTarget } from "../FogConfig";
import { SkySystem } from "../SkySystem";

// Actual World/Environment/ClientGraphics/SkySystem and native Three camera,
// geometry and TSL graphs. The renderer below is an explicit command recorder
// for ordering and injected failures, NOT a GPU/browser or rendered-pixel test.
const cleanup: Array<() => void> = [];
const initialWidth = fogRenderTarget.width;
const initialHeight = fogRenderTarget.height;
afterEach(() => {
  for (const release of cleanup.splice(0).reverse()) release();
  fogRenderTarget.setSize(initialWidth, initialHeight);
});

function fixture() {
  const world = new World();
  const environment = new Environment(world);
  world.addSystem("environment", environment);
  const graphics = new ClientGraphics(world);
  const sky = new SkySystem(world);
  // Exercise the actual production geometry factories without starting asset
  // loading, a browser, the day clock or a renderer.
  sky["scene"] = world.stage.scene;
  sky["group"] = new THREE.Group();
  world.stage.scene.add(sky["group"]);
  sky["createSkyDome"]();
  sky["createFogSky"]();
  environment["skySystem"] = sky;
  cleanup.push(() => sky.destroy());

  const originalTarget = new THREE.CubeRenderTarget(8);
  cleanup.push(() => originalTarget.dispose());
  const commands: string[] = [];
  const recorder = {
    toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping,
    toneMappingExposure: 0.85,
    outputColorSpace: THREE.SRGBColorSpace,
    target: originalTarget as THREE.RenderTarget | null,
    face: 3,
    mip: 1,
    info: { frame: 7, calls: 100 },
    failRender: null as Error | null,
    failRestore: null as Error | null,
    getRenderTarget() {
      return this.target;
    },
    getActiveCubeFace() {
      return this.face;
    },
    getActiveMipmapLevel() {
      return this.mip;
    },
    setRenderTarget(target: THREE.RenderTarget | null, face = 0, mip = 0) {
      if (target === originalTarget && this.failRestore) throw this.failRestore;
      this.target = target;
      this.face = face;
      this.mip = mip;
    },
    render(scene: THREE.Scene, camera: THREE.Camera) {
      const fog = scene === sky["fogScene"];
      commands.push(fog ? "fog" : "main");
      this.info.calls++;
      if (fog) {
        expect(this.target).toBe(fogRenderTarget);
        expect(this.toneMapping).toBe(THREE.NoToneMapping);
        expect(camera).toBe(sky["fogCamera"]);
        if (this.failRender) throw this.failRender;
      } else {
        expect(scene).toBe(world.stage.scene);
        expect(camera).toBe(world.camera);
        expect(this.target).toBe(originalTarget);
        expect(this.face).toBe(3);
        expect(this.mip).toBe(1);
        expect(this.toneMapping).toBe(THREE.ACESFilmicToneMapping);
      }
    },
  };
  graphics.renderer = recorder as unknown as THREE.WebGPURenderer;
  graphics.usePostprocessing = false;
  graphics.composer = null;
  world.camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  world.camera.updateProjectionMatrix();
  return {
    world,
    environment,
    graphics,
    sky,
    recorder,
    commands,
    originalTarget,
  };
}

describe("sky fog at the final main-camera render boundary", () => {
  it("uses the selected pose after lateUpdate and prepares exactly once before the main draw", () => {
    const { world, environment, graphics, sky, commands } = fixture();
    world.camera.position.set(390, 34, 369);
    world.camera.lookAt(384, 30, 374);
    sky.lateUpdate(0);
    environment.lateUpdate(0);
    expect(commands).toEqual([]);
    expect(environment.getFogSkyReceipt()?.ready).toBe(false);

    // Same order as the existing graphics.render camera lease: choose a new
    // pose, then invoke the enclosing actual ClientGraphics.render method.
    const enclosing = graphics.render.bind(graphics);
    graphics.render = () => {
      world.camera.position.set(407, 48, 455);
      world.camera.lookAt(470, 18, 515);
      world.camera.fov = 52;
      world.camera.updateProjectionMatrix();
      enclosing();
    };
    const day = [sky.dayPhase, sky.dayIntensity, ...sky.sunDirection.toArray()];
    graphics.commit();
    expect(commands).toEqual(["fog", "main"]);
    const receipt = environment.getFogSkyReceipt()!;
    expect(receipt).toMatchObject({
      ready: true,
      failed: false,
      preparationCount: 1,
      selectedCamera: { uuid: world.camera.uuid, fov: 52 },
      skyCenter: [407, 48, 455],
      renderer: {
        frameBefore: 7,
        frameAfter: 7,
        callsBefore: 100,
        callsAfter: 101,
      },
    });
    expect(receipt.selectedCamera?.matrixWorld).toEqual(
      world.camera.matrixWorld.toArray(),
    );
    expect(receipt.fogCamera?.projectionMatrix).toEqual(
      world.camera.projectionMatrix.toArray(),
    );
    expect(
      sky["fogCamera"]!.quaternion.angleTo(world.camera.quaternion),
    ).toBeLessThan(1e-7);
    expect([
      sky.dayPhase,
      sky.dayIntensity,
      ...sky.sunDirection.toArray(),
    ]).toEqual(day);
    expect(graphics.hasRendered).toBe(true);
  });

  it("resolves parented world orientation and centers the main dome without moving the borrowed camera", () => {
    const { world, graphics, sky } = fixture();
    world.rig.position.set(30, 8, -70);
    world.rig.rotation.set(0.1, 0.7, -0.2);
    world.camera.position.set(4, 6, 9);
    world.camera.rotation.set(-0.25, 0.3, 0.05);
    world.camera.updateWorldMatrix(true, false);
    const before = world.camera.matrixWorld.clone();
    const position = world.camera.getWorldPosition(new THREE.Vector3());
    const orientation = world.camera.getWorldQuaternion(new THREE.Quaternion());
    const local = world.camera.position.clone();
    graphics.render();
    expect(sky["fogCamera"]!.quaternion.angleTo(orientation)).toBeLessThan(
      1e-7,
    );
    expect(
      sky["fogCamera"]!.quaternion.angleTo(world.camera.quaternion),
    ).toBeGreaterThan(0.1);
    expect(sky["fogCamera"]!.position.toArray()).toEqual([0, 0, 0]);
    expect(
      sky["group"]!.getWorldPosition(new THREE.Vector3()).distanceTo(position),
    ).toBeLessThan(1e-10);
    expect(world.camera.position).toEqual(local);
    expect(world.camera.matrixWorld).toEqual(before);
  });

  it("retains complete perspective projection inputs and resizes only the shared fog target width", () => {
    const { world, graphics, sky, recorder } = fixture();
    const camera = world.camera;
    camera.fov = 43;
    camera.zoom = 1.2;
    camera.filmOffset = 2;
    camera.near = 0.3;
    camera.far = 9000;
    camera.setViewOffset(1600, 900, 150, 75, 800, 450);
    camera.updateProjectionMatrix();
    const texture = fogRenderTarget.texture;
    graphics.render();
    const fog = sky["fogCamera"]!;
    expect(fog.projectionMatrix).toEqual(camera.projectionMatrix);
    expect(fog.projectionMatrixInverse).toEqual(camera.projectionMatrixInverse);
    expect(fog).toMatchObject({
      fov: 43,
      zoom: 1.2,
      filmOffset: 2,
      near: 0.3,
      far: 9000,
    });
    expect(fog.view).toEqual(camera.view);
    expect(fog.view).not.toBe(camera.view);
    expect(fog.coordinateSystem).toBe(THREE.WebGPUCoordinateSystem);
    camera.clearViewOffset();
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    graphics.render();
    expect(fogRenderTarget.width).toBe(initialHeight);
    expect(fogRenderTarget.height).toBe(initialHeight);
    expect(fogRenderTarget.texture).toBe(texture);
    expect(recorder.toneMappingExposure).toBe(0.85);
    expect(recorder.outputColorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("does not read camera user data/animations and reuses bounded view-offset storage", () => {
    const { world, graphics, sky } = fixture();
    const camera = world.camera;
    camera.userData.circular = camera.userData;
    Object.defineProperty(camera, "animations", {
      get() {
        throw new Error("unrelated camera animation payload was read");
      },
    });
    camera.setViewOffset(1600, 900, 0, 0, 800, 450);
    graphics.render();
    const ownedView = sky["fogCamera"]!.view;
    camera.setViewOffset(1600, 900, 100, 50, 800, 450);
    graphics.render();
    expect(sky["fogCamera"]!.view).toBe(ownedView);
    expect(ownedView).not.toBe(camera.view);
    expect(ownedView).toEqual(camera.view);
    expect(sky["fogCamera"]!.userData).toEqual({});
  });

  it("preserves sky rotation/scale and matches actual main/fog sphere ray directions under a transformed scene", () => {
    const { world, graphics, sky } = fixture();
    world.stage.scene.position.set(2, 5, -8);
    world.stage.scene.rotation.set(0.2, -0.6, 0.05);
    world.stage.scene.scale.set(0.9, 1.1, 0.8);
    sky["group"]!.rotation.set(0.02, 0.15, -0.03);
    const rotation = sky["group"]!.quaternion.clone();
    world.camera.position.set(407, 48, 455);
    graphics.render();
    expect(sky["group"]!.quaternion.toArray()).toEqual(rotation.toArray());
    const main = sky["skyMesh"]!;
    const fog = sky["fogSkyMesh"]!;
    const linear = main.matrixWorld.clone().setPosition(0, 0, 0);
    expect(fog.matrixWorld).toEqual(linear);
    const direction = new THREE.Vector3(0.3, 0.2, -0.7).normalize();
    const point = world.camera.getWorldPosition(new THREE.Vector3());
    const mainRay = new THREE.Raycaster(point, direction);
    mainRay.layers.enable(1);
    const mainHit = mainRay.intersectObject(main)[0];
    const fogHit = new THREE.Raycaster(
      new THREE.Vector3(),
      direction,
    ).intersectObject(fog)[0];
    expect(mainHit).toBeDefined();
    expect(fogHit).toBeDefined();
    const mainDirection = main.worldToLocal(mainHit.point.clone()).normalize();
    const fogDirection = fog.worldToLocal(fogHit.point.clone()).normalize();
    expect(mainDirection.distanceTo(fogDirection)).toBeLessThan(1e-10);
  });

  it("prepares the same fog before the existing composer branch without a direct extra main draw", () => {
    const { graphics, commands } = fixture();
    graphics.usePostprocessing = true;
    graphics.composer = {
      render: () => commands.push("composer"),
    } as unknown as PostProcessingComposer;
    graphics.render();
    expect(commands).toEqual(["fog", "composer"]);
  });

  it("keeps diagnostic reads detached, observational and tied to the latest preparation", () => {
    const { world, graphics, environment, recorder } = fixture();
    graphics.render();
    const first = environment.getFogSkyReceipt()!;
    const expected = structuredClone(first);
    const calls = recorder.info.calls;
    first.selectedCamera!.matrixWorld[12] = 123456;
    first.renderTarget.width = 1;
    world.camera.position.set(20, 30, 40);
    world.camera.updateMatrixWorld(true);
    expect(environment.getFogSkyReceipt()).toEqual(expected);
    expect(recorder.info.calls).toBe(calls);
    graphics.render();
    expect(environment.getFogSkyReceipt()).toMatchObject({
      preparationCount: 2,
      ready: true,
      skyCenter: [20, 30, 40],
    });
  });

  it("restores target face/mip and tone mapping on failure and never continues the main draw or retries", () => {
    const { graphics, environment, recorder, commands, originalTarget } =
      fixture();
    graphics.render();
    const error = new Error("injected native render failure");
    recorder.failRender = error;
    expect(() => graphics.render()).toThrow(error);
    expect(commands).toEqual(["fog", "main", "fog"]);
    expect(recorder.target).toBe(originalTarget);
    expect([recorder.face, recorder.mip, recorder.toneMapping]).toEqual([
      3,
      1,
      THREE.ACESFilmicToneMapping,
    ]);
    expect(environment.getFogSkyReceipt()).toMatchObject({
      preparationCount: 2,
      ready: false,
      failed: true,
    });
    expect(() => graphics.render()).toThrow("renderer session must stop");
    expect(commands).toHaveLength(3);
  });

  it("retains both render and restoration errors, restores tone mapping and exposes failure", () => {
    const { graphics, environment, recorder } = fixture();
    recorder.failRender = new Error("draw failure");
    recorder.failRestore = new Error("restore failure");
    let failure: unknown;
    try {
      graphics.render();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      recorder.failRender,
      recorder.failRestore,
    ]);
    expect(recorder.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(environment.getFogSkyReceipt()).toMatchObject({
      ready: false,
      failed: true,
    });
    expect(graphics.hasRendered).toBe(false);
  });

  it("does nothing before sky initialization and retires only owned geometry/materials", () => {
    const world = new World();
    expect(new Environment(world).getFogSkyReceipt()).toBe(null);
    const { sky, graphics, environment, commands } = fixture();
    let sharedDisposals = 0;
    const onDispose = () => sharedDisposals++;
    fogRenderTarget.addEventListener("dispose", onDispose);
    cleanup.push(() =>
      fogRenderTarget.removeEventListener("dispose", onDispose),
    );
    graphics.render();
    sky.destroy();
    expect(environment.getFogSkyReceipt()).toMatchObject({
      ready: false,
      initialized: false,
      selectedCamera: null,
      fogCamera: null,
    });
    expect(sharedDisposals).toBe(0);
    sky.prepareForRender(graphics.renderer, world.camera);
    expect(commands).toEqual(["fog", "main"]);
  });
});
