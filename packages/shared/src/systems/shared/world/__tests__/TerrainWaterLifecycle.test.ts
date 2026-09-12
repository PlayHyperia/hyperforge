import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import THREE from "../../../../extras/three/three";
import { fogRenderTarget } from "../FogConfig";
import { TerrainSystem } from "../TerrainSystem";
import { TerrainQuadTree } from "../TerrainQuadTree";
import { WaterVisualManager } from "../WaterVisualManager";

// Real parent/child owners, native promises and the production procedural
// texture fallback. Targets are genuine Three CPU objects, never rendered or
// represented as GPU allocations. No WaterSystem lifecycle is replaced.
const worlds: World[] = [];
beforeAll(async () => {
  await DataManager.getInstance().initialize();
});
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});
function fixture(world = new World()) {
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  return { world, terrain };
}
function delay() {
  return new Promise<void>((resolve) => setTimeout(resolve, 1));
}

describe("Terrain-owned water retirement (CPU ownership, not GPU qualification)", () => {
  it("parent World.destroy retires water geometry before shared materials, every real reflector target and owned texture exactly once", async () => {
    const { world, terrain } = fixture();
    await terrain.init();
    const water = terrain["waterSystem"]!;
    const reflection = water["reflection"]!;
    expect(reflection.target.parent).toBe(world.stage.scene);
    const cameras = [
      new THREE.PerspectiveCamera(),
      new THREE.PerspectiveCamera(),
    ];
    const targets = cameras.map((camera) =>
      reflection.reflector.getRenderTarget(camera),
    );
    expect(targets[0]).not.toBe(targets[1]);
    const materials = [water.getMaterial("ocean")!, water.getMaterial("lake")!];
    const textures = [
      water["normalTex"]!,
      water["flowTex"]!,
      water["foamTex"]!,
    ];
    expect(textures.every((texture) => texture instanceof THREE.Texture)).toBe(
      true,
    );

    const container = new THREE.Group();
    world.stage.scene.add(container);
    const profile = terrain.getWorldTerrainProfile();
    const visuals = new WaterVisualManager(
      container,
      water,
      (x, z) => terrain.getHeightAtComputed(x, z),
      (x, z) => terrain["getIslandMask"](x, z),
      profile.water.threshold,
      [],
      profile,
    );
    // Install the actual production child owner in the parent's existing slot.
    // Terrain geometry/grass setup is outside this water teardown fixture.
    terrain["waterVisualManager"] = visuals;
    const tree = new TerrainQuadTree({
      minSize: 100,
      maxDepth: 4,
      splitRatio: 0,
      rootChunkRadius: 0,
    });
    tree.update(0, 0);
    visuals.onNodeNeedsGeometry(tree.getFinalNodes()[0]);
    const mesh = container.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(materials).toContain(mesh.material);
    expect(water.waterMeshCount).toBe(1);

    const events: string[] = [];
    mesh.geometry.addEventListener("dispose", () => events.push("geometry"));
    for (const [i, material] of materials.entries())
      material.addEventListener("dispose", () => {
        expect(mesh.parent).toBeNull();
        expect(water.waterMeshCount).toBe(0);
        expect(events[0]).toBe("geometry");
        events.push("material" + i);
        terrain.destroy(); // Native synchronous disposal reentrancy must be inert.
      });
    for (const [i, texture] of textures.entries())
      texture.addEventListener("dispose", () => events.push("texture" + i));
    for (const [i, target] of targets.entries())
      target.addEventListener("dispose", () => events.push("target" + i));
    const borrowedTexture = new THREE.Texture();
    const borrowedMaterial = new THREE.MeshBasicMaterial({
      map: borrowedTexture,
    });
    let borrowedDisposals = 0;
    const onBorrowedDispose = () => {
      borrowedDisposals++;
    };
    borrowedTexture.addEventListener("dispose", onBorrowedDispose);
    borrowedMaterial.addEventListener("dispose", onBorrowedDispose);
    fogRenderTarget.addEventListener("dispose", onBorrowedDispose);
    fogRenderTarget.texture.addEventListener("dispose", onBorrowedDispose);
    world.stage.scene.environment = borrowedTexture;
    try {
      world.destroy();
      terrain.destroy();
      expect(events).toHaveLength(8);
      expect(new Set(events).size).toBe(8);
      expect(reflection.target.parent).toBeNull();
      expect(container.parent).toBeNull();
      expect(terrain["waterSystem"]).toBeUndefined();
      expect(terrain["waterVisualManager"]).toBeNull();
      expect(terrain["initializingWater"]).toBeNull();
      expect(water["reflection"]).toBeUndefined();
      expect(water.getMaterial("ocean")).toBeUndefined();
      expect(water.getMaterial("lake")).toBeUndefined();
      expect([water["normalTex"], water["flowTex"], water["foamTex"]]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(borrowedDisposals).toBe(0);
    } finally {
      tree.dispose();
      fogRenderTarget.removeEventListener("dispose", onBorrowedDispose);
      fogRenderTarget.texture.removeEventListener("dispose", onBorrowedDispose);
      borrowedTexture.removeEventListener("dispose", onBorrowedDispose);
      borrowedMaterial.removeEventListener("dispose", onBorrowedDispose);
      borrowedMaterial.dispose();
      borrowedTexture.dispose();
    }
  });

  it("concurrent init callers share one actual WaterSystem and one completion", async () => {
    const { terrain } = fixture();
    const first = terrain.init(),
      water = terrain["waterSystem"];
    expect(water).toBeDefined();
    expect(terrain.init()).toBe(first);
    await first;
    expect(terrain["waterSystem"]).toBe(water);
    expect(terrain.init()).toBe(first);
  });

  it.each(["before-textures", "partially-created-textures"])(
    "parent retirement during %s prevents late publication and drains the exact initialization",
    async (stage) => {
      const { world, terrain } = fixture();
      const initialization = terrain.init();
      // Install rejection handling before the native asynchronous work settles.
      const rejected = expect(initialization).rejects.toThrow(
        "Terrain destroyed during water initialization",
      );
      const water = terrain["waterSystem"]!;
      expect(terrain["initializingWater"]).toBe(water);
      if (stage === "partially-created-textures") {
        const deadline = Date.now() + 5000;
        while (!water["normalTex"] && Date.now() < deadline) await delay();
        expect(water["normalTex"]).toBeInstanceOf(THREE.Texture);
        expect(water["foamTex"]).toBeUndefined();
      }
      const normal = water["normalTex"];
      let normalDisposals = 0;
      normal?.addEventListener("dispose", () => {
        normalDisposals++;
      });
      let publications = 0;
      world.stage.scene.addEventListener("childadded", () => {
        publications++;
      });
      world.destroy();
      expect(terrain["waterSystem"]).toBeUndefined();
      expect(normalDisposals).toBe(0); // Work is not cancelled or retired mid-write.
      await rejected;
      expect(publications).toBe(0);
      expect(terrain["initializingWater"]).toBeNull();
      expect(water["reflection"]).toBeUndefined();
      expect(water.getMaterial("ocean")).toBeUndefined();
      expect([water["normalTex"], water["flowTex"], water["foamTex"]]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(normalDisposals).toBe(normal ? 1 : 0);
      expect(terrain["terrainUpdateIntervalId"]).toBeUndefined();
      expect(terrain["serializationIntervalId"]).toBeUndefined();
      expect(terrain["boundingBoxIntervalId"]).toBeUndefined();
      await expect(terrain.init()).rejects.toThrow("Terrain is destroyed");
      await expect(terrain.start()).rejects.toThrow("Terrain is destroyed");
      terrain.destroy();
      expect(normalDisposals).toBe(normal ? 1 : 0);
    },
  );

  it.each([false, true])(
    "retains an actual role-admission exception identity, including parent retirement=%s before rejection delivery",
    async (retire) => {
      const failure = new Error("CPU_WORLD_ROLE_ADMISSION_FAILURE");
      class RejectingRoleWorld extends World {
        rejectRole = false;
        override get isServer(): boolean {
          if (this.rejectRole) throw failure;
          return super.isServer;
        }
      }
      const world = new RejectingRoleWorld();
      const { terrain } = fixture(world);
      world.rejectRole = true;
      try {
        const initialization = terrain.init();
        expect(terrain["waterSystem"]).toBeDefined();
        const rejected = expect(initialization).rejects.toBe(failure);
        world.rejectRole = false;
        if (retire) world.destroy();
        await rejected;
        expect(terrain["waterSystem"]).toBeUndefined();
        expect(terrain["initializingWater"]).toBeNull();
      } finally {
        world.rejectRole = false;
      }
    },
  );

  it("retains a native scene-listener failure and disposes the already initialized exact owner", async () => {
    const { world, terrain } = fixture();
    const failure = new Error("NATIVE_SCENE_PUBLICATION_FAILURE");
    let disposed = 0;
    world.stage.scene.addEventListener("childadded", () => {
      const water = terrain["waterSystem"]!;
      for (const texture of [
        water["normalTex"]!,
        water["flowTex"]!,
        water["foamTex"]!,
      ]) {
        texture.addEventListener("dispose", () => {
          disposed++;
        });
      }
      for (const material of [
        water.getMaterial("ocean")!,
        water.getMaterial("lake")!,
      ]) {
        material.addEventListener("dispose", () => {
          disposed++;
        });
      }
      const target = water["reflection"]!.reflector.getRenderTarget(
        world.camera,
      );
      target.addEventListener("dispose", () => {
        disposed++;
      });
      throw failure;
    });
    await expect(terrain.init()).rejects.toBe(failure);
    expect(disposed).toBe(6);
    expect(terrain["waterSystem"]).toBeUndefined();
    expect(terrain["initializingWater"]).toBeNull();
    expect(world.stage.scene.children).toEqual([]);
    terrain.destroy();
    expect(disposed).toBe(6);
  });

  it("scene-publication reentrancy retires water without resuming parent initialization", async () => {
    const { world, terrain } = fixture();
    world.stage.scene.addEventListener("childadded", () => terrain.destroy());
    await expect(terrain.init()).rejects.toThrow(
      "Terrain destroyed during water publication",
    );
    expect(terrain["waterSystem"]).toBeUndefined();
    expect(terrain["initializingWater"]).toBeNull();
    expect(world.stage.scene.children).toEqual([]);
    expect(terrain["terrainUpdateIntervalId"]).toBeUndefined();
    await expect(terrain.start()).rejects.toThrow("Terrain is destroyed");
  });
});
