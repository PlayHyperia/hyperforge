import type { UniformNode } from "three/webgpu";
import { describe, expect, it } from "vitest";

import THREE, { uniform } from "../../../extras/three/three";
import { ClientTeleportEffectsSystem } from "../ClientTeleportEffectsSystem";

type TeleportMaterial = THREE.Material & {
  colorNode?: unknown;
  opacityNode?: unknown;
};

type TeleportMaterialFactories = {
  createParticleGlowMaterial(color: THREE.Color): TeleportMaterial;
  createTexturedMaterial(
    texture: THREE.Texture,
    color: THREE.Color,
    opacity: UniformNode<"float", number>,
  ): TeleportMaterial;
  createStructuralGlowMaterial(
    color: THREE.Color,
    opacity: UniformNode<"float", number>,
  ): TeleportMaterial;
  createBeamMaterial(
    baseColor: THREE.Color,
    topColor: THREE.Color,
    opacity: UniformNode<"float", number>,
  ): TeleportMaterial;
  createBasicAdditiveMaterial(
    color: THREE.Color,
    opacity: UniformNode<"float", number>,
  ): TeleportMaterial;
};

describe("ClientTeleportEffectsSystem material factories", () => {
  it("constructs every typed TSL teleport material graph", () => {
    const factories =
      ClientTeleportEffectsSystem.prototype as unknown as TeleportMaterialFactories;
    const opacity = uniform(0.65);
    const color = new THREE.Color(0x66ccff);
    const texture = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    texture.needsUpdate = true;

    const materials = [
      factories.createParticleGlowMaterial(color),
      factories.createTexturedMaterial(texture, color, opacity),
      factories.createStructuralGlowMaterial(color, opacity),
      factories.createBeamMaterial(color, new THREE.Color(0xffffff), opacity),
      factories.createBasicAdditiveMaterial(color, opacity),
    ];

    for (const material of materials) {
      expect(material.colorNode).toBeTruthy();
      expect(material.opacityNode).toBeTruthy();
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      material.dispose();
    }
    texture.dispose();
  });
});
