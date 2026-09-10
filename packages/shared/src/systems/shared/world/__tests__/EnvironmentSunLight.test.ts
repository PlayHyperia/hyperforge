import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../../../../core/World";
import THREE from "../../../../extras/three/three";
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
});
