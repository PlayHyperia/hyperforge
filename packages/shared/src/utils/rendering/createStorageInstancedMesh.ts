import THREE from "../../extras/three/three";

/** Disposal registration only; the matrix is read as storage, not a vertex input. */
export const INSTANCE_MATRIX_STORAGE_ATTRIBUTE = "instanceMatrixStorage";

/** Create a pool on its exclusively owned geometry. Matrix writes retain the
 * ordinary InstancedMesh API and require the owner's existing needsUpdate flush.
 * Static usage is intentional: DynamicDrawUsage would upload every render pass. */
export function createStorageInstancedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
): THREE.InstancedMesh {
  if (geometry.hasAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE)) {
    throw new Error("Instance matrix storage geometry already has an owner");
  }
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  // Keep the exact identity-initialized allocation and capacity from Three.
  const matrix = new THREE.StorageInstancedBufferAttribute(
    mesh.instanceMatrix.array,
    16,
  );
  mesh.instanceMatrix = matrix;
  // r186 Geometries disposes registered storage attributes with the pool's
  // geometry. Binding-only storage otherwise has no geometry lifetime owner.
  geometry.setAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE, matrix);
  return mesh;
}
