import { describe, expect, it, vi } from "vitest";

import type { World } from "../../../../types";
import THREE from "../../../../extras/three/three";
import {
  BuildingRenderingSystem,
  type BuildingOcclusionMaterial,
  type RoofOcclusionMaterial,
} from "../BuildingRenderingSystem";
import { MAX_VERTEX_LIGHTS } from "../TerrainShader";

type BuildingMaterialHarness = {
  batchedMaterial: BuildingOcclusionMaterial;
  roofMaterial: RoofOcclusionMaterial;
  floorMaterial: THREE.MeshStandardNodeMaterial;
  glassMaterial: THREE.MeshStandardNodeMaterial;
};

describe("BuildingRenderingSystem material lifecycle", () => {
  it("constructs typed wall and roof graphs and disposes every shared material", () => {
    const world = { $eventBus: undefined } as unknown as World;
    const system = new BuildingRenderingSystem(world);
    const harness = system as unknown as BuildingMaterialHarness;
    const wallUniforms = harness.batchedMaterial.occlusionUniforms;
    const roofUniforms = harness.roofMaterial.occlusionUniforms;

    expect(harness.batchedMaterial.alphaTestNode).toBeTruthy();
    expect(harness.batchedMaterial.colorNode).toBeTruthy();
    expect(harness.batchedMaterial.roughnessNode).toBeTruthy();
    expect(harness.roofMaterial.alphaTestNode).toBeTruthy();
    expect(harness.roofMaterial.colorNode).toBeTruthy();
    expect(wallUniforms.playerPos.value).toBeInstanceOf(THREE.Vector3);
    expect(wallUniforms.vertexLightPositions).toHaveLength(MAX_VERTEX_LIGHTS);
    expect(wallUniforms.vertexLightColors).toHaveLength(MAX_VERTEX_LIGHTS);
    expect(wallUniforms.vertexLightParams).toHaveLength(MAX_VERTEX_LIGHTS);
    expect(roofUniforms.hiddenBuildingCenters.value).toHaveLength(16);
    expect(roofUniforms.hiddenBuildingRadii.value).toHaveLength(16);
    expect(roofUniforms.hiddenBuildingCount.value).toBe(0);

    const disposeListeners = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    [
      harness.batchedMaterial,
      harness.roofMaterial,
      harness.floorMaterial,
      harness.glassMaterial,
    ].forEach((material, index) => {
      material.addEventListener("dispose", disposeListeners[index]);
    });

    system.destroy();
    disposeListeners.forEach((listener) => expect(listener).toHaveBeenCalled());
  });
});
