import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { createAnimatedImpostorMaterial } from "../AnimatedImpostorMaterialTSL";
import { createTSLImpostorMaterial } from "../ImpostorMaterialTSL";
import { InstancedAnimatedImpostor } from "../InstancedAnimatedImpostor";

function arrayTexture(depth: number): THREE.DataArrayTexture {
  const texture = new THREE.DataArrayTexture(
    new Uint8Array(4 * depth),
    1,
    1,
    depth,
  );
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.needsUpdate = true;
  return texture;
}

describe("TSL impostor material construction", () => {
  it("constructs the asymmetric animated material graph without a renderer", () => {
    const atlas = arrayTexture(2);
    const material = createAnimatedImpostorMaterial(atlas, {
      atlasArray: atlas,
      spritesPerSide: 4,
      spritesX: 4,
      spritesY: 2,
      hemisphere: true,
      frameCount: 2,
    });

    expect(material.positionNode).toBeDefined();
    expect(material.colorNode).toBeDefined();
    expect(material.animatedImpostorUniforms.spritesX.value).toBe(4);
    expect(material.animatedImpostorUniforms.spritesY.value).toBe(2);

    material.dispose();
    atlas.dispose();
  });

  it("constructs the complete AAA material graph and updates view uniforms", () => {
    const atlas = new THREE.Texture();
    const normal = new THREE.Texture();
    const depth = new THREE.Texture();
    const pbr = new THREE.Texture();
    const material = createTSLImpostorMaterial({
      atlasTexture: atlas,
      normalAtlasTexture: normal,
      depthAtlasTexture: depth,
      pbrAtlasTexture: pbr,
      gridSizeX: 4,
      gridSizeY: 2,
      enableAAA: true,
      enableDepthBlending: true,
      enableSpecular: true,
    });

    material.updateView(
      new THREE.Vector3(1, 2, 3),
      new THREE.Vector3(0.2, 0.3, 0.5),
    );
    expect(material.colorNode).toBeDefined();
    expect(material.impostorUniforms.faceIndices.value.toArray()).toEqual([
      1, 2, 3,
    ]);
    expect(material.impostorUniforms.faceWeights.value.toArray()).toEqual([
      0.2, 0.3, 0.5,
    ]);

    material.dispose();
    atlas.dispose();
    normal.dispose();
    depth.dispose();
    pbr.dispose();
  });

  it("constructs typed storage nodes and writes per-instance state", () => {
    const atlas = arrayTexture(2);
    const impostors = new InstancedAnimatedImpostor({
      maxInstances: 2,
      atlas: {
        atlasArray: atlas,
        totalFrames: 2,
        variants: new Map([
          [
            "fighter",
            {
              modelId: "fighter",
              frameCount: 2,
              baseFrameIndex: 0,
              scale: 1,
              boundingRadius: 1,
            },
          ],
        ]),
        spritesPerSide: 4,
        spritesX: 4,
        spritesY: 2,
        hemisphere: true,
        animationFPS: 10,
      },
    });

    impostors.setInstances([
      {
        position: new THREE.Vector3(348, 0.42, 402),
        yaw: Math.PI / 2,
        animationOffset: 1,
        variantIndex: 0,
        scale: 1,
        visible: true,
      },
    ]);
    expect(impostors.activeCount).toBe(1);
    expect(impostors.material.positionNode).toBeDefined();
    expect(impostors.material.colorNode).toBeDefined();
    expect(
      impostors.updateInstance(0, {
        position: new THREE.Vector3(349, 0.42, 402),
        visible: false,
      }),
    ).toBe(0);

    impostors.material.dispose();
    atlas.dispose();
  });
});
