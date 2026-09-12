import { describe, expect, it } from "vitest";

import type { World } from "../../../../types";
import THREE from "../../../../extras/three/three";
import { WaterSystem, type WaterUniforms } from "../WaterSystem";
import { World as RealWorld } from "../../../../core/World";
import { NodeFrame } from "three/webgpu";
import { NodeUpdateType } from "three/tsl";

type WaterMaterialHarness = {
  normalTex?: THREE.Texture;
  flowTex?: THREE.Texture;
  foamTex?: THREE.Texture;
  oceanMaterial?: THREE.MeshStandardNodeMaterial;
  oceanUniforms: WaterUniforms | null;
  createOceanMaterial(): THREE.MeshStandardNodeMaterial;
};

function createTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint8Array([128, 128, 255, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  texture.needsUpdate = true;
  return texture;
}

describe("WaterSystem material graph", () => {
  it("skips real NodeFrame reflection scheduling when disabled before initialization", () => {
    const world = new RealWorld();
    const water = new WaterSystem(world);
    water.setReflectionsEnabled(false);
    const node = water["createReflection"]();
    const reflection = node.reflector;
    try {
      // A real NodeFrame without a GPU renderer: a disabled node must never
      // enter the native draw or allocate any camera/target. Not a GPU test.
      const frame = new NodeFrame();
      frame.camera = world.camera;
      frame.renderId = 1;
      expect(reflection.updateBeforeType).toBe(NodeUpdateType.RENDER);
      expect(reflection.getUpdateBeforeType(frame)).toBe(NodeUpdateType.NONE);
      frame.updateBeforeNode(reflection);
      expect(reflection.virtualCameras.has(world.camera)).toBe(false);
      expect(reflection.renderTargets.size).toBe(0);
      expect(reflection.resolutionScale).toBe(0.5);
    } finally {
      node.dispose();
      water.destroy();
    }
  });

  it("retains the registered node and native update policy across preference toggles", () => {
    const water = new WaterSystem(new RealWorld());
    const node = water["createReflection"]();
    const reflection = node.reflector;
    const update = reflection.updateBefore;
    const gate = reflection.getUpdateBeforeType;
    try {
      for (const enabled of [true, false, true, false, true]) {
        water.setReflectionsEnabled(enabled);
        expect(reflection.getUpdateBeforeType()).toBe(
          enabled ? NodeUpdateType.RENDER : NodeUpdateType.NONE,
        );
        // NodeBuilder registers by the property, NodeFrame dispatches by the
        // method. Keeping registration permits re-enable without a recompile.
        expect(reflection.updateBeforeType).toBe(NodeUpdateType.RENDER);
        expect(reflection.updateBefore).toBe(update);
        expect(reflection.getUpdateBeforeType).toBe(gate);
        expect(node.reflector).toBe(reflection);
      }
      reflection.updateBeforeType = NodeUpdateType.FRAME;
      expect(reflection.getUpdateBeforeType()).toBe(NodeUpdateType.FRAME);
    } finally {
      node.dispose();
      water.destroy();
    }
  });

  it("constructs the ocean graph with updateable runtime uniform values", () => {
    const world = {
      isServer: false,
      camera: null,
      getSystem: () => null,
    } as unknown as World;
    const system = new WaterSystem(world);
    const harness = system as unknown as WaterMaterialHarness;
    harness.normalTex = createTexture();
    harness.flowTex = createTexture();
    harness.foamTex = createTexture();

    const material = harness.createOceanMaterial();
    harness.oceanMaterial = material;

    expect(material.positionNode).toBeTruthy();
    expect(material.opacityNode).toBeTruthy();
    expect(material.outputNode).toBeTruthy();
    expect(harness.oceanUniforms?.time.value).toBe(0);
    expect(harness.oceanUniforms?.windStrength.value).toBe(1.2);
    expect(harness.oceanUniforms?.sunDirection.value).toBeInstanceOf(
      THREE.Vector3,
    );

    system.update(0.25);
    expect(harness.oceanUniforms?.time.value).toBe(0.25);
    expect(typeof harness.oceanUniforms?.windStrength.value).toBe("number");

    system.destroy();
  });
});
