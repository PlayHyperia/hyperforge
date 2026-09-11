import THREE, { texture, uniform } from "../../../extras/three/three";
import type { TextureNode, UniformNode } from "three/webgpu";

// Lamppost light texture (shared across terrain/buildings)
// Initialized with dummy 1x1 texture so shaders compile before real data loads
const dummyLampData = new Float32Array([0]);
const lamppostLightTexture: THREE.DataTexture = new THREE.DataTexture(
  dummyLampData,
  1,
  1,
  THREE.RedFormat,
  THREE.FloatType,
);
lamppostLightTexture.wrapS = THREE.ClampToEdgeWrapping;
lamppostLightTexture.wrapT = THREE.ClampToEdgeWrapping;
lamppostLightTexture.minFilter = THREE.LinearFilter;
lamppostLightTexture.magFilter = THREE.LinearFilter;
lamppostLightTexture.needsUpdate = true;

const lamppostLightTextureNode: TextureNode<"vec4"> =
  texture(lamppostLightTexture);
const uLamppostWorldSize = uniform(1);
const uLamppostCenterX = uniform(0);
const uLamppostCenterZ = uniform(0);
const uLamppostNightMix = uniform(0);

export type LamppostLightTextureState = {
  textureNode: TextureNode<"vec4">;
  uWorldSize: UniformNode<"float", number>;
  uCenterX: UniformNode<"float", number>;
  uCenterZ: UniformNode<"float", number>;
  uNightMix: UniformNode<"float", number>;
};

export function getLamppostLightTextureState(): LamppostLightTextureState {
  return {
    textureNode: lamppostLightTextureNode,
    uWorldSize: uLamppostWorldSize,
    uCenterX: uLamppostCenterX,
    uCenterZ: uLamppostCenterZ,
    uNightMix: uLamppostNightMix,
  };
}

export function getLamppostLightTexture(): THREE.DataTexture {
  return lamppostLightTexture;
}

export function setLamppostLightTextureData(
  data: Float32Array,
  width: number,
  height: number,
  worldSize: number,
  centerX = 0,
  centerZ = 0,
): void {
  lamppostLightTexture.image = { data, width, height };
  lamppostLightTexture.needsUpdate = true;
  uLamppostWorldSize.value = worldSize;
  uLamppostCenterX.value = centerX;
  uLamppostCenterZ.value = centerZ;
}

export function clearLamppostLightTexture(): void {
  const emptyData = new Float32Array([0]);
  lamppostLightTexture.image = { data: emptyData, width: 1, height: 1 };
  lamppostLightTexture.needsUpdate = true;
  uLamppostWorldSize.value = 1;
  uLamppostCenterX.value = 0;
  uLamppostCenterZ.value = 0;
  uLamppostNightMix.value = 0;
}

export function setLamppostNightMix(nightMix: number): void {
  uLamppostNightMix.value = Math.max(0, Math.min(1, nightMix));
}

export function getLamppostNightMix(): number {
  return uLamppostNightMix.value;
}

export function isLamppostLightTextureReady(): boolean {
  const image = lamppostLightTexture.image as {
    width: number;
    height: number;
  };
  return image.width > 1 && image.height > 1;
}
