import * as THREE from "three";

export interface ObjectAxisRegionResult {
  geometry: THREE.BufferGeometry;
  sourceMeshCount: number;
  triangleCount: number;
}

/**
 * Extract world-space triangles whose centroid falls inside an authored
 * interval of a content-local axis. This lets audits test contact against the
 * handle itself instead of accepting contact with a blade, guard, or head.
 */
export function createObjectAxisRegionGeometry(
  contentRoot: THREE.Object3D,
  sourceAxis: THREE.Vector3,
  minimumProjection: number,
  maximumProjection: number,
): ObjectAxisRegionResult {
  if (
    sourceAxis.lengthSq() <= 1e-8 ||
    !Number.isFinite(minimumProjection) ||
    !Number.isFinite(maximumProjection) ||
    minimumProjection >= maximumProjection
  ) {
    throw new Error("Object-axis region authority is invalid");
  }
  contentRoot.updateWorldMatrix(true, true);
  const axis = sourceAxis.clone().normalize();
  const contentWorldInverse = contentRoot.matrixWorld.clone().invert();
  const positions: number[] = [];
  let sourceMeshCount = 0;
  const local = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const world = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const contentLocal = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  const centroid = new THREE.Vector3();

  contentRoot.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.visible) return;
    const attribute = object.geometry.getAttribute("position");
    if (!(attribute instanceof THREE.BufferAttribute)) return;
    const index = object.geometry.getIndex();
    const triangleCount = index
      ? Math.floor(index.count / 3)
      : Math.floor(attribute.count / 3);
    if (triangleCount < 1) return;
    sourceMeshCount += 1;
    object.updateWorldMatrix(true, false);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertexIndex = index
          ? index.getX(triangle * 3 + corner)
          : triangle * 3 + corner;
        local[corner].fromBufferAttribute(attribute, vertexIndex);
        world[corner].copy(local[corner]).applyMatrix4(object.matrixWorld);
        contentLocal[corner]
          .copy(world[corner])
          .applyMatrix4(contentWorldInverse);
      }
      centroid
        .copy(contentLocal[0])
        .add(contentLocal[1])
        .add(contentLocal[2])
        .multiplyScalar(1 / 3);
      const projection = centroid.dot(axis);
      if (projection < minimumProjection || projection > maximumProjection) {
        continue;
      }
      for (const vertex of world) positions.push(vertex.x, vertex.y, vertex.z);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  if (positions.length > 0) {
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return {
    geometry,
    sourceMeshCount,
    triangleCount: positions.length / 9,
  };
}
