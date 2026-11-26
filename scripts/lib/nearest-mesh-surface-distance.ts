import * as THREE from "three";

/**
 * Exact point-to-triangle distance for rigid audit meshes in world space.
 * Falls back to vertices only when a geometry does not contain a complete
 * triangle, so sparse longitudinal tessellation cannot invent a hand gap.
 */
export function nearestMeshSurfaceDistance(
  root: THREE.Object3D,
  point: THREE.Vector3,
): number {
  let nearest = Number.POSITIVE_INFINITY;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const closest = new THREE.Vector3();
  const triangle = new THREE.Triangle();

  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const geometry = mesh.geometry;
    const position = geometry?.getAttribute?.("position");
    if (!position) return;
    const index = geometry.getIndex();
    const elementCount = index?.count ?? position.count;
    const triangleElementCount = elementCount - (elementCount % 3);
    if (triangleElementCount === 0) {
      for (let element = 0; element < elementCount; element += 1) {
        const vertexIndex = index ? index.getX(element) : element;
        a.fromBufferAttribute(position, vertexIndex).applyMatrix4(
          object.matrixWorld,
        );
        nearest = Math.min(nearest, a.distanceTo(point));
      }
      return;
    }

    for (let element = 0; element < triangleElementCount; element += 3) {
      const firstIndex = index ? index.getX(element) : element;
      const secondIndex = index ? index.getX(element + 1) : element + 1;
      const thirdIndex = index ? index.getX(element + 2) : element + 2;
      a.fromBufferAttribute(position, firstIndex).applyMatrix4(
        object.matrixWorld,
      );
      b.fromBufferAttribute(position, secondIndex).applyMatrix4(
        object.matrixWorld,
      );
      c.fromBufferAttribute(position, thirdIndex).applyMatrix4(
        object.matrixWorld,
      );
      triangle.set(a, b, c).closestPointToPoint(point, closest);
      nearest = Math.min(nearest, closest.distanceTo(point));
    }
  });
  return nearest;
}
