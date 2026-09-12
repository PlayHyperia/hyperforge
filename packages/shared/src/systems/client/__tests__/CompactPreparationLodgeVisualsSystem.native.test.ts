import { beforeAll, describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { DataManager } from "../../../data/DataManager";
import { Group, Mesh, Raycaster, Vector3 } from "../../../extras/three/three";
import { getPhysX, loadPhysX } from "../../../physics/PhysXManager";
import { TerrainSystem } from "../../shared/world/TerrainSystem";
import { TownSystem } from "../../shared/world/TownSystem";
import { COMPACT_PREPARATION_LODGE } from "../../shared/world/CompactPreparationLodge";
import {
  COMPACT_LODGE_VISUAL_SYSTEM,
  CompactPreparationLodgeVisualsSystem,
  registerCompactPreparationLodgeVisuals,
} from "../CompactPreparationLodgeVisualsSystem";

beforeAll(async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await loadPhysX();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

describe("compact lodge actual native PhysX integration (CPU, not foot-contact acceptance)", () => {
  it("cooks its exact five meshes, keeps the doorway open, hits walls/floor/roof and releases the actor across reinit", async () => {
    const saved = {
      config: DataManager["worldConfig"],
      profile: DataManager["worldTerrainProfile"],
      identity: DataManager["worldContentIdentity"],
    };
    const world = new World();
    const px = getPhysX()!;
    const actorTypes = new px.PxActorTypeFlags(
      px.PxActorTypeFlagEnum.eRIGID_STATIC,
    );
    try {
      DataManager["worldContentIdentity"] = null;
      DataManager.setWorldConfig({
        ...structuredClone(saved.config!),
        compactPreparationLodge: structuredClone(COMPACT_PREPARATION_LODGE),
      });
      await world.physics.init();
      const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
      registerCompactPreparationLodgeVisuals(world);
      const towns = world.getSystem<TownSystem>("towns")!;
      const visual = world.getSystem<CompactPreparationLodgeVisualsSystem>(
        COMPACT_LODGE_VISUAL_SYSTEM,
      )!;
      await terrain.init();
      await towns.init();
      await towns.start();
      const actorsBefore = world.physics.scene!.getNbActors(actorTypes);
      const childrenBefore = world.stage.scene.children.length;
      const record = towns.getCompactPreparationLodge()!;
      for (let cycle = 0; cycle < 3; cycle++) {
        await visual.init();
        visual.start();
        expect(visual.getDiagnostics()).toMatchObject({
          physicsActor: true,
          physicsShapes: 5,
          triangles: 1332,
        });
        expect(world.physics.scene!.getNbActors(actorTypes)).toBe(
          actorsBefore + 1,
        );
        const door = world.physics.raycast(
          new Vector3(396, 30.3, 377),
          new Vector3(0, 0, -1),
          4,
        );
        expect(door).toBeNull();
        const wall = world.physics.raycast(
          new Vector3(399, 30.3, 377),
          new Vector3(0, 0, -1),
          4,
        );
        expect(wall).not.toBeNull();
        expect(wall!.point.z).toBeCloseTo(374, 1);
        for (let x = 394; x < 402; x++) {
          for (let z = 366; z < 374; z++) {
            const floor = world.physics.raycast(
              new Vector3(x + 0.5, 31, z + 0.5),
              new Vector3(0, -1, 0),
              3,
            );
            expect(floor, `floor ${x},${z}`).not.toBeNull();
            expect(floor!.point.y).toBeCloseTo(record.position.y + 0.61, 4);
          }
        }
        const roof = world.physics.raycast(
          new Vector3(398, 40, 370),
          new Vector3(0, -1, 0),
          10,
        );
        expect(roof).not.toBeNull();
        expect(roof!.point.y).toBeCloseTo(35.3187789286, 4);
        expect(towns.getCollisionService().isWalkableAtFloor(398, 370, 1)).toBe(
          false,
        );
        const root = world.stage.scene.getObjectByName(
          COMPACT_PREPARATION_LODGE.layoutId,
        );
        expect(root).toBeInstanceOf(Group);
        if (!(root instanceof Group))
          throw new Error("Actual lodge root missing");
        const ray = new Raycaster();
        ray.layers.enableAll();
        ray.far = 0.01;
        let checkedTrimFaces = 0;
        for (const mesh of root.children) {
          if (
            !(mesh instanceof Mesh) ||
            !["windowFrames", "doorFrames"].includes(mesh.name)
          )
            continue;
          const positions = mesh.geometry.getAttribute("position");
          const normals = mesh.geometry.getAttribute("normal");
          const index = mesh.geometry.index;
          const count = index?.count ?? positions.count;
          for (let i = 0; i < count; i += 3) {
            const ids = [0, 1, 2].map((n) => index?.getX(i + n) ?? i + n);
            const center = new Vector3();
            for (const id of ids)
              center.add(new Vector3().fromBufferAttribute(positions, id));
            center.multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld);
            const outward = new Vector3()
              .fromBufferAttribute(normals, ids[0])
              .transformDirection(mesh.matrixWorld);
            ray.ray.origin.copy(center).addScaledVector(outward, 0.005);
            ray.ray.direction.copy(outward).negate();
            const renderedSurface = ray.intersectObject(root, true)[0];
            const nativeSurface = world.physics.raycast(
              ray.ray.origin,
              ray.ray.direction,
              ray.far,
            );
            const label = `${mesh.name} cycle ${cycle} face ${i / 3}`;
            expect(renderedSurface, label).toBeDefined();
            expect(nativeSurface, label).not.toBeNull();
            expect(
              nativeSurface!.point.distanceTo(renderedSurface.point),
              label,
            ).toBeLessThan(0.0001);
            checkedTrimFaces++;
          }
        }
        expect(checkedTrimFaces).toBe(708);
        visual.destroy();
        visual.destroy();
        expect(world.physics.scene!.getNbActors(actorTypes)).toBe(actorsBefore);
        expect(world.stage.scene.children.length).toBe(childrenBefore);
        expect(visual.getDiagnostics()).toBeNull();
        expect(
          world.physics.raycast(
            new Vector3(399, 30.3, 377),
            new Vector3(0, 0, -1),
            4,
          ),
        ).toBeNull();
      }
    } finally {
      await world.destroy();
      px.destroy(actorTypes);
      DataManager["worldConfig"] = saved.config;
      DataManager["worldTerrainProfile"] = saved.profile;
      DataManager["worldContentIdentity"] = saved.identity;
    }
  });
});
