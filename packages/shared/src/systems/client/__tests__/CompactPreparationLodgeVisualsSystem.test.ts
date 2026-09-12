import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as THREE from "../../../extras/three/three";
import { World } from "../../../core/World";
import { DataManager } from "../../../data/DataManager";
import { TerrainSystem } from "../../shared/world/TerrainSystem";
import { TownSystem } from "../../shared/world/TownSystem";
import { COMPACT_PREPARATION_LODGE } from "../../shared/world/CompactPreparationLodge";
import {
  COMPACT_LODGE_VISUAL_SYSTEM,
  CompactPreparationLodgeVisualsSystem,
  createCompactPreparationLodgeVisual,
  registerCompactPreparationLodgeVisuals,
} from "../CompactPreparationLodgeVisualsSystem";

const saved = {
  config: DataManager["worldConfig"],
  profile: DataManager["worldTerrainProfile"],
  identity: DataManager["worldContentIdentity"],
};
const worlds: World[] = [];
const leases: ReturnType<typeof createCompactPreparationLodgeVisual>[] = [];
beforeEach(() => {
  DataManager["worldContentIdentity"] = null;
  DataManager.setWorldConfig({
    ...structuredClone(saved.config!),
    compactPreparationLodge: structuredClone(COMPACT_PREPARATION_LODGE),
  });
});
afterEach(async () => {
  for (const visual of leases.splice(0)) visual.dispose();
  for (const world of worlds.splice(0)) await world.destroy();
  DataManager["worldConfig"] = saved.config;
  DataManager["worldTerrainProfile"] = saved.profile;
  DataManager["worldContentIdentity"] = saved.identity;
});

function worldWithoutPhysics() {
  const world = new World();
  worlds.push(world);
  // Same removal performed by createClientWorld for actual broadcast worlds;
  // no physics, scene, generator, material, collision or system test doubles.
  const physics = world.getSystem("physics")!;
  world.systems = world.systems.filter((system) => system !== physics);
  world.systemsByName.delete("physics");
  delete world.physics;
  return world;
}

async function fixture(preexistingTown = false) {
  const world = worldWithoutPhysics();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  if (preexistingTown) world.register("towns", TownSystem);
  const before = world.getSystem("towns");
  registerCompactPreparationLodgeVisuals(world);
  const towns = world.getSystem<TownSystem>("towns")!;
  if (before) expect(towns).toBe(before);
  await terrain.init();
  await towns.init();
  await towns.start();
  return {
    world,
    towns,
    system: world.getSystem<CompactPreparationLodgeVisualsSystem>(
      COMPACT_LODGE_VISUAL_SYSTEM,
    )!,
  };
}

describe("compact lodge actual geometry / scene ownership (CPU, not rendered acceptance)", () => {
  it.each([false, true])(
    "registers only one shared owner and visual with preexistingTown=%s",
    async (preexistingTown) => {
      const { world, towns, system } = await fixture(preexistingTown);
      const before = [...world.systems];
      registerCompactPreparationLodgeVisuals(world);
      expect(world.systems).toEqual(before);
      expect(world.getSystem("pois")).toBeUndefined();
      expect(towns.getTowns()).toEqual([]);
      system.start();
      const count = world.stage.scene.children.length;
      system.start();
      expect(world.stage.scene.children).toHaveLength(count);
      expect(system.getDiagnostics()).toEqual({
        buildingId: COMPACT_PREPARATION_LODGE.layoutId,
        meshes: 5,
        triangles: 1116,
        geometryBytes: 134680,
        materials: 4,
        physicsShapes: 0,
        physicsActor: false,
      });
      system.destroy();
      system.destroy();
      system.start();
      expect(system.getDiagnostics()).toBeNull();
      expect(world.stage.scene.children).toHaveLength(count - 1);
      // The visual did not unregister collision it does not own.
      expect(
        towns
          .getCollisionService()
          .getBuilding(COMPACT_PREPARATION_LODGE.layoutId),
      ).toBeDefined();
      await system.init();
      system.start();
      expect(system.getDiagnostics()?.meshes).toBe(5);
      expect(world.stage.scene.children).toHaveLength(count);
    },
  );

  it("keeps the admitted mesh envelope and physical doorway open, with only actual floors selectable", async () => {
    const { towns } = await fixture();
    const record = towns.getCompactPreparationLodge()!;
    const beforeLayout = structuredClone(record.layout);
    const visual = createCompactPreparationLodgeVisual(record);
    leases.push(visual);
    expect(record.layout).toEqual(beforeLayout);
    const box = new THREE.Box3().setFromObject(visual.root);
    expect(box.min.x).toBeCloseTo(393.502307415, 5);
    expect(box.max.x).toBeCloseTo(402.497692585, 5);
    expect(box.min.z).toBeCloseTo(365.55000019, 5);
    expect(box.max.z).toBeCloseTo(376.55000019, 5);
    expect(box.max.y).toBeCloseTo(35.3187789286, 5);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(396, 30.3, 377),
      new THREE.Vector3(0, 0, -1),
      0,
      4,
    );
    ray.layers.enableAll();
    expect(ray.intersectObject(visual.root, true)).toHaveLength(0);
    ray.ray.origin.x = 399;
    expect(ray.intersectObject(visual.root, true).length).toBeGreaterThan(0);
    ray.ray.set(new THREE.Vector3(398, 40, 370), new THREE.Vector3(0, -1, 0));
    ray.far = 20;
    ray.layers.set(2);
    const hit = ray.intersectObject(visual.root, true)[0];
    expect(hit.object.name).toBe("floors");
    // Generator renders the floor 1 cm above its collision elevation, matching
    // the existing supported player root bias, not the foundation wall bottom.
    expect(hit.point.y).toBeCloseTo(record.position.y + 0.61, 5);
    for (const mesh of visual.meshes) {
      expect(mesh.castShadow && mesh.receiveShadow).toBe(true);
      expect(mesh.geometry.boundingSphere!.radius).toBeGreaterThan(0);
      expect(mesh.layers.mask).toBe(mesh.name === "floors" ? 4 : 2);
      expect(mesh.userData.walkable).toBe(mesh.name === "floors");
      const material = mesh.material as THREE.MeshStandardNodeMaterial;
      expect(material.isMeshStandardNodeMaterial).toBe(true);
      expect(material.vertexColors).toBe(false);
      expect(material.map).toBeNull();
      expect(material.colorNode).toBeTruthy();
      expect(material.outputNode).toBeTruthy();
      expect(material.roughness).toBeGreaterThan(0.7);
    }
  });

  it("disposes every private geometry and shared-per-role material exactly once", async () => {
    const { world, towns } = await fixture();
    const visual = createCompactPreparationLodgeVisual(
      towns.getCompactPreparationLodge()!,
    );
    leases.push(visual);
    world.stage.scene.add(visual.root);
    const geometryDisposals = new Map<THREE.BufferGeometry, number>();
    const materialDisposals = new Map<THREE.Material, number>();
    for (const mesh of visual.meshes) {
      if (!geometryDisposals.has(mesh.geometry)) {
        geometryDisposals.set(mesh.geometry, 0);
        mesh.geometry.addEventListener("dispose", () =>
          geometryDisposals.set(
            mesh.geometry,
            geometryDisposals.get(mesh.geometry)! + 1,
          ),
        );
      }
      const material = mesh.material as THREE.Material;
      if (!materialDisposals.has(material)) {
        materialDisposals.set(material, 0);
        material.addEventListener("dispose", () =>
          materialDisposals.set(material, materialDisposals.get(material)! + 1),
        );
      }
    }
    visual.dispose();
    visual.dispose();
    expect(visual.root.parent).toBeNull();
    expect([...geometryDisposals.values()]).toEqual([1, 1, 1, 1, 1]);
    expect([...materialDisposals.values()]).toEqual([1, 1, 1, 1]);
  });

  it("does not publish scenery when the authoritative owner has not started", () => {
    const world = worldWithoutPhysics();
    registerCompactPreparationLodgeVisuals(world);
    const system = world.getSystem<CompactPreparationLodgeVisualsSystem>(
      COMPACT_LODGE_VISUAL_SYSTEM,
    )!;
    const before = [...world.stage.scene.children];
    expect(() => system.start()).toThrow("authoritative collision owner");
    expect(system.getDiagnostics()).toBeNull();
    expect(world.stage.scene.children).toEqual(before);
  });

  it("preserves absent-descriptor registration behavior", () => {
    const config = structuredClone(DataManager.getWorldConfig()!);
    delete config.compactPreparationLodge;
    DataManager.setWorldConfig(config);
    const world = worldWithoutPhysics();
    const before = [...world.systems];
    registerCompactPreparationLodgeVisuals(world);
    expect(world.systems).toEqual(before);
  });
});
