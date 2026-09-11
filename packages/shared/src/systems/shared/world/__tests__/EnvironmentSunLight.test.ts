import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import THREE from "../../../../extras/three/three";
import type { WorldConfigManifest } from "../../../../types/world/world-types";
import { ClientInterface } from "../../../client/ClientInterface";
import { Environment } from "../Environment";

// Real World/Stage, preferences, Environment and Three lights. No renderer or
// full-world start: this suite checks construction/ownership, not GPU shading.
describe("directional illumination independent of shadow quality", () => {
  const environments: Environment[] = [];
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubEnv("ENABLE_CSM", "false");
  });
  afterEach(() => {
    for (const environment of environments.splice(0)) environment.destroy();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  async function create(shadows = "none") {
    const world = new World();
    const prefs = new ClientInterface(world);
    world.addSystem("prefs", prefs);
    prefs.shadows = shadows;
    const environment = new Environment(world);
    environments.push(environment);
    await environment.init({});
    return { world, prefs, environment, scene: world.stage.scene };
  }

  it("none retains a direct sun and target without a shadow map or scene changes", async () => {
    const { environment, scene } = await create();
    const neighbor = new THREE.Object3D();
    scene.add(neighbor);
    const fog = new THREE.Fog(0x223344, 10, 100);
    scene.fog = fog;
    environment.buildSunLight();
    const light = environment.sunLight!;
    expect(light).toBeInstanceOf(THREE.DirectionalLight);
    expect(light.name).toBe("SunLight_NoShadows");
    expect(light.castShadow).toBe(false);
    expect(light.shadow.map).toBeNull();
    expect(light.shadow.mapPass).toBeNull();
    expect(light.intensity).toBe(1.8);
    expect(light.color.toArray()).toEqual([1, 1, 1]);
    expect(light.position.toArray()).toEqual([100, 200, 100]);
    expect(light.target.position.toArray()).toEqual([0, 0, 0]);
    expect(scene.children).toEqual([neighbor, light, light.target]);
    expect(scene.fog).toBe(fog);
    expect(scene.environment).toBeNull();
  });

  it("none still disables CSM when its feature flag is enabled", async () => {
    vi.stubEnv("ENABLE_CSM", "true");
    const { environment, scene } = await create();
    environment.buildSunLight();
    expect(environment.sunLight?.castShadow).toBe(false);
    expect(environment.sunLight?.shadow.map).toBeNull();
    expect(
      (environment as unknown as { csmShadowNode: unknown }).csmShadowNode,
    ).toBeNull();
    expect(scene.children).toHaveLength(2);
  });

  it.each(["low", "med", "high"])(
    "retains the existing %s single-shadow configuration",
    async (level) => {
      const { environment } = await create(level);
      environment.buildSunLight();
      const light = environment.sunLight!;
      expect(light.name).toBe("SunLight_Single");
      expect(light.castShadow).toBe(true);
      expect(light.shadow.mapSize.toArray()).toEqual([4096, 4096]);
      expect(light.shadow.bias).toBe(0.0002);
      expect(light.shadow.normalBias).toBe(0.01);
      expect(light.shadow.camera).toMatchObject({
        near: 0.5,
        far: 600,
        left: -200,
        right: 200,
        top: 200,
        bottom: -200,
      });
    },
  );

  it("none -> med -> none replaces and destroys each owned light/target cleanly", async () => {
    const { environment, prefs, scene } = await create();
    const created: THREE.DirectionalLight[] = [];
    const disposed: THREE.DirectionalLight[] = [];
    for (const level of ["none", "med", "none"]) {
      prefs.shadows = level;
      environment.buildSunLight();
      const light = environment.sunLight!;
      expect(light).toBeInstanceOf(THREE.DirectionalLight);
      light.addEventListener("dispose", () => disposed.push(light));
      created.push(light);
      expect(scene.children).toEqual([light, light.target]);
      for (const previous of created.slice(0, -1)) {
        expect(previous.parent).toBeNull();
        expect(previous.target.parent).toBeNull();
      }
    }
    expect(disposed).toEqual(created.slice(0, -1));
    environment.destroy();
    expect(disposed).toEqual(created);
    expect(scene.children).toEqual([]);
    expect(environment.sunLight).toBeNull();
  });

  it("keeps the non-graphics guard", async () => {
    const world = new World();
    const environment = new Environment(world);
    environments.push(environment);
    environment.buildSunLight();
    expect(environment.sunLight).toBeNull();
    expect(world.stage.scene.children).toEqual([]);
  });

  it("retains camera anchoring without an admitted compact profile", () => {
    // Vitest's real manifest setup already identifies its world. A fresh actual
    // source process tests pre-admission behavior without resetting that owner.
    const source = (path: string) =>
      JSON.stringify(new URL(path, import.meta.url).href);
    const child = spawnSync(
      process.env.DUEL_HYPERIA_BUN_PATH || "bun",
      [
        "--eval",
        `
      import assert from "node:assert/strict";
      import {World} from ${source("../../../../core/World.ts")};
      import {DataManager} from ${source("../../../../data/DataManager.ts")};
      import {Environment} from ${source("../Environment.ts")};
      import {ClientInterface} from ${source("../../../client/ClientInterface.ts")};
      assert.equal(DataManager.getWorldConfig(), null);
      globalThis.window = {};
      const world = new World(), prefs = new ClientInterface(world);
      world.addSystem("prefs", prefs); prefs.shadows = "med";
      const environment = new Environment(world);
      try {
        await environment.init({}); environment.buildSunLight();
        world.camera.position.set(350,335,433);
        environment.updateSunLightPosition();
        assert.deepEqual(environment.sunLight.target.position.toArray(), [350,335,433]);
        assert.deepEqual(environment.sunLight.position.toArray(), [350,835,433]);
        console.log("UNADMITTED_CAMERA_ANCHOR_OK");
      } finally { environment.destroy(); world.destroy(); }
    `,
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 65536,
        env: { ...process.env, ENABLE_CSM: "false" },
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("UNADMITTED_CAMERA_ANCHOR_OK");
  });

  it("keeps compact shadow matrices fixed across camera cuts without changing the existing light ray or budget", async () => {
    // Actual canonical startup admission, not a fabricated terrain/renderer.
    const config = JSON.parse(
      readFileSync(
        new URL(
          "../../../../../../server/world/assets/manifests/world-config.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as WorldConfigManifest;
    DataManager.setWorldConfig(config);
    const { environment, world } = await create("med");
    environment.buildSunLight();
    const light = environment.sunLight!;
    const profile = DataManager.getWorldTerrainProfile();
    const anchor = new THREE.Vector3(
      profile.island.centerX,
      profile.height.baseOffset,
      profile.island.centerZ,
    );
    expect(light.target.position).toEqual(anchor); // Correct before first render.
    const projection = light.shadow.camera.projectionMatrix.clone();
    const color = light.color.clone(),
      intensity = light.intensity;
    for (const direction of [
      [0, -1, 0],
      [0.6, -0.8, 0],
      [-0.4, -0.3, 0.2],
      [0.23, 0, 0],
    ]) {
      environment.lightDirection.fromArray(direction);
      let first: number[] | undefined;
      for (const camera of [
        [354, 33.5, 324],
        [350, 335.0693015230977, 433],
        [-80, 900, 750],
      ]) {
        world.camera.position.fromArray(camera);
        environment["updateSunLightPosition"]();
        expect(light.target.position).toEqual(anchor);
        expect(light.position.toArray()).toEqual(
          direction.map(
            (v, i) => anchor.getComponent(i) - 400 * v + (i === 1 ? 100 : 0),
          ),
        );
        expect(environment.lightDirection.toArray()).toEqual(direction);
        // Actual Three update performed by a renderer; this test is CPU-only.
        light.updateMatrixWorld(true);
        light.shadow.camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
        light.shadow.camera.updateProjectionMatrix();
        light.shadow.updateMatrices(light);
        const matrix = [...light.shadow.camera.matrixWorldInverse.elements];
        if (first) expect(matrix).toEqual(first);
        first = matrix;
        const centerClip = anchor
          .clone()
          .applyMatrix4(light.shadow.camera.matrixWorldInverse)
          .applyMatrix4(light.shadow.camera.projectionMatrix);
        expect(Math.abs(centerClip.x)).toBeLessThan(1);
        expect(Math.abs(centerClip.y)).toBeLessThan(1);
        expect(centerClip.z).toBeGreaterThan(0);
        expect(centerClip.z).toBeLessThan(1);
      }
    }
    expect(light.shadow.mapSize.toArray()).toEqual([4096, 4096]);
    expect(light.shadow.camera).toMatchObject({
      near: 0.5,
      far: 600,
      left: -200,
      right: 200,
      top: 200,
      bottom: -200,
    });
    expect(light.shadow.bias).toBe(0.0002);
    expect(light.shadow.normalBias).toBe(0.01);
    expect(light.color).toEqual(color);
    expect(light.intensity).toBe(intensity);
    // Coordinate-system change above is test-only; the constructor's projection
    // uses the same finite extents, not an adaptive resize/fitting path.
    expect(projection.elements.every(Number.isFinite)).toBe(true);
    expect(light.shadow.map).toBeNull();
  });

  it("retains camera following for compact CSM and reselects fixed anchoring after a quality rebuild", async () => {
    const { environment, prefs, world } = await create("med");
    vi.stubEnv("ENABLE_CSM", "true");
    environment.buildSunLight();
    world.camera.position.set(354, 33.5, 324);
    environment["updateSunLightPosition"]();
    expect(environment.sunLight!.name).toBe("SunLight_CSM");
    expect(environment.sunLight!.target.position).toEqual(
      world.camera.position,
    );
    vi.stubEnv("ENABLE_CSM", "false");
    prefs.shadows = "high";
    environment.buildSunLight();
    expect(environment.sunLight!.name).toBe("SunLight_Single");
    expect(environment.sunLight!.target.position.toArray()).toEqual([
      350, 28.15, 400,
    ]);
    prefs.shadows = "none";
    environment.buildSunLight();
    environment["updateSunLightPosition"]();
    expect(environment.sunLight!.castShadow).toBe(false);
    expect(environment.sunLight!.target.position).toEqual(
      world.camera.position,
    );
  });
});
