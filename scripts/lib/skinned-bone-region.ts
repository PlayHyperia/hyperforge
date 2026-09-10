import * as THREE from "three";

export interface SkinnedBoneRegionGeometry {
  geometry: THREE.BufferGeometry;
  sourceMeshCount: number;
  triangleCount: number;
}

export interface SkinnedBoneRegionOptions {
  /** Include only actual descendants present in each eligible mesh's skeleton. */
  includeDescendantSkinBones?: boolean;
}

function boneWeightForVertex(
  mesh: THREE.SkinnedMesh,
  vertexIndex: number,
  selectedBoneIndices: ReadonlySet<number>,
): number {
  const skinIndex = mesh.geometry.getAttribute("skinIndex");
  const skinWeight = mesh.geometry.getAttribute("skinWeight");
  if (!skinIndex || !skinWeight) return 0;
  let weight = 0;
  for (let component = 0; component < 4; component += 1) {
    if (
      selectedBoneIndices.has(skinIndex.getComponent(vertexIndex, component))
    ) {
      weight += skinWeight.getComponent(vertexIndex, component);
    }
  }
  return weight;
}

/**
 * Builds a world-space triangle soup for the rendered region controlled by one
 * skeleton bone, optionally including its actual descendant skin bones. Every
 * triangle vertex must clear the same summed-influence gate; ancestor and sibling
 * influences never contribute. This is a skin-weight region, not a finger-closure
 * or anatomical-boundary certification. The supplied root controls mesh scope.
 */
export function createSkinnedBoneRegionGeometry(
  root: THREE.Object3D,
  targetBone: THREE.Object3D,
  minimumVertexWeight = 0.5,
  options: SkinnedBoneRegionOptions = {},
): SkinnedBoneRegionGeometry {
  if (
    !Number.isFinite(minimumVertexWeight) ||
    minimumVertexWeight <= 0 ||
    minimumVertexWeight > 1
  ) {
    throw new Error("minimumVertexWeight must be within (0, 1]");
  }

  root.updateMatrixWorld(true);
  const positions: number[] = [];
  let sourceMeshCount = 0;
  const vertex = new THREE.Vector3();

  root.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const position = mesh.geometry.getAttribute("position");
    if (!position || !mesh.geometry.getAttribute("skinIndex")) return;
    if (!mesh.skeleton.bones.includes(targetBone as THREE.Bone)) return;
    const selectedBoneIndices = new Set<number>();
    mesh.skeleton.bones.forEach((bone, boneIndex) => {
      let candidate: THREE.Object3D | null = bone;
      while (candidate) {
        if (candidate === targetBone) {
          selectedBoneIndices.add(boneIndex);
          break;
        }
        if (!options.includeDescendantSkinBones) break;
        candidate = candidate.parent;
      }
    });
    sourceMeshCount += 1;
    mesh.skeleton.update();
    const index = mesh.geometry.getIndex();
    const elementCount = index?.count ?? position.count;
    const triangleElementCount = elementCount - (elementCount % 3);
    for (let element = 0; element < triangleElementCount; element += 3) {
      const vertexIndices = [0, 1, 2].map((offset) =>
        index ? index.getX(element + offset) : element + offset,
      );
      if (
        vertexIndices.some(
          (vertexIndex) =>
            boneWeightForVertex(mesh, vertexIndex, selectedBoneIndices) <
            minimumVertexWeight,
        )
      ) {
        continue;
      }
      for (const vertexIndex of vertexIndices) {
        vertex.fromBufferAttribute(position, vertexIndex);
        mesh.applyBoneTransform(vertexIndex, vertex);
        vertex.applyMatrix4(mesh.matrixWorld);
        positions.push(vertex.x, vertex.y, vertex.z);
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  if (positions.length > 0) {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return {
    geometry,
    sourceMeshCount,
    triangleCount: positions.length / 9,
  };
}
