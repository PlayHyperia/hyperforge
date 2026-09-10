import { describe, expect, it, vi } from "vitest";
import THREE from "../../../extras/three/three";
import { ElevatedWaterBody } from "./WaterBodyRegistry";
import { WaterVisualManager } from "./WaterVisualManager";
import type { WaterSystem } from "./WaterSystem";

describe("WaterVisualManager elevated water bodies", () => {
  it("keeps an authored pond surface resident and disposes it cleanly", () => {
    const container = new THREE.Group();
    const parent = new THREE.Group();
    parent.add(container);
    const material = new THREE.MeshBasicMaterial();
    const registerWaterMesh = vi.fn();
    const unregisterWaterMesh = vi.fn();
    const waterSystem = {
      getMaterial: vi.fn(() => material),
      registerWaterMesh,
      unregisterWaterMesh,
    } as unknown as WaterSystem;
    const pond = new ElevatedWaterBody({
      id: "haven_pond_water",
      centerX: -7,
      centerZ: -18,
      radius: 7.5,
      radiusSq: 7.5 * 7.5,
      surfaceY: 27.8,
      sourceType: "explicit",
    });

    const manager = new WaterVisualManager(
      container,
      waterSystem,
      () => 30,
      () => 1,
      16,
      [pond],
    );

    expect(container.children).toHaveLength(1);
    const mesh = container.children[0] as THREE.Mesh;
    expect(mesh.name).toBe("WaterQT_elevated_haven_pond_water");
    expect(mesh.position.toArray()).toEqual([-7, 27.8, -18]);
    expect(mesh.layers.mask).toBe(2);
    expect(mesh.userData).toMatchObject({
      type: "water",
      waterType: "lake",
      waterBodyId: "haven_pond_water",
      elevated: true,
      walkable: false,
    });
    expect(mesh.geometry.getAttribute("shoreDistance").count).toBe(
      mesh.geometry.getAttribute("position").count,
    );
    expect(registerWaterMesh).toHaveBeenCalledWith(mesh);

    const dispose = vi.spyOn(mesh.geometry, "dispose");
    manager.destroy();

    expect(unregisterWaterMesh).toHaveBeenCalledWith(mesh);
    expect(dispose).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(container.parent).toBeNull();
  });
});
