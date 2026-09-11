import THREE, { texture, uniform } from "../../../extras/three/three";
import type { TextureNode, UniformNode } from "three/webgpu";

// Road influence texture (shared across terrain/grass/flowers)
// Initialized with dummy 1x1 texture so shaders compile before real data loads
function createRoadInfluenceTexture(
  data: Float32Array,
  width: number,
  height: number,
): THREE.DataTexture {
  const image = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RedFormat,
    THREE.FloatType,
  );
  image.wrapS = image.wrapT = THREE.ClampToEdgeWrapping;
  image.minFilter = image.magFilter = THREE.LinearFilter;
  image.needsUpdate = true;
  return image;
}

let roadInfluenceTexture = createRoadInfluenceTexture(
  new Float32Array([0]),
  1,
  1,
);

const roadInfluenceTextureNode: TextureNode<"vec4"> =
  texture(roadInfluenceTexture);
const uRoadInfluenceWorldSize = uniform(1); // World size covered by road texture
const uRoadInfluenceCenterX = uniform(0); // World center X
const uRoadInfluenceCenterZ = uniform(0); // World center Z
const uRoadInfluenceThreshold = uniform(0.15); // Cull threshold
let activeOwner: object | undefined;

export type RoadInfluenceTextureState = {
  textureNode: TextureNode<"vec4">;
  uWorldSize: UniformNode<"float", number>;
  uCenterX: UniformNode<"float", number>;
  uCenterZ: UniformNode<"float", number>;
  uThreshold: UniformNode<"float", number>;
};

export function getRoadInfluenceTextureState(): RoadInfluenceTextureState {
  return {
    textureNode: roadInfluenceTextureNode,
    uWorldSize: uRoadInfluenceWorldSize,
    uCenterX: uRoadInfluenceCenterX,
    uCenterZ: uRoadInfluenceCenterZ,
    uThreshold: uRoadInfluenceThreshold,
  };
}

export function getRoadInfluenceTexture(): THREE.DataTexture {
  return roadInfluenceTexture;
}

export function setRoadInfluenceTextureData(
  data: Float32Array,
  width: number,
  height: number,
  worldSize: number,
  centerX = 0,
  centerZ = 0,
  owner?: object,
): void {
  activeOwner = owner;
  const previous = roadInfluenceTexture;
  if (previous.image.width !== width || previous.image.height !== height) {
    // A DataTexture's allocated WebGPU dimensions cannot change via needsUpdate.
    // Keep the base node stable: existing sample() clones follow its new value.
    roadInfluenceTexture = createRoadInfluenceTexture(data, width, height);
    roadInfluenceTextureNode.value = roadInfluenceTexture;
  } else {
    roadInfluenceTexture.image = { data, width, height };
    roadInfluenceTexture.needsUpdate = true;
  }
  uRoadInfluenceWorldSize.value = worldSize;
  uRoadInfluenceCenterX.value = centerX;
  uRoadInfluenceCenterZ.value = centerZ;
  // Publish the complete replacement before notifying existing GPU bindings.
  // Three's dispose listeners release the old allocation and invalidate them.
  if (previous !== roadInfluenceTexture) previous.dispose();
}

export function clearRoadInfluenceTexture(owner?: object): void {
  if (owner && activeOwner !== owner) return;
  setRoadInfluenceTextureData(new Float32Array([0]), 1, 1, 1);
}

export function setRoadInfluenceThreshold(threshold: number): void {
  uRoadInfluenceThreshold.value = Math.max(0, Math.min(1, threshold));
}

export function getRoadInfluenceThreshold(): number {
  return uRoadInfluenceThreshold.value;
}
