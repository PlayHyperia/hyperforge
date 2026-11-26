import type * as THREE from "three";

/**
 * GLTF loaders and the WebGPU renderer can hold different Three constructors.
 * Use Three's mesh identity flag, not instanceof, so isolation hides every mesh.
 * The caller must still verify an empty GPU mask. This only collects meshes;
 * a black/depth-only non-mesh drawable can evade a color-only blank control.
 * General scene isolation and physical clearance need separate qualification.
 */
export function collectProjectedMaskMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh === true) meshes.push(mesh);
  });
  return meshes;
}
