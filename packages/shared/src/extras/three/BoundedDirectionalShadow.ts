import THREE from "./three";

type Options = { mapSize?: 1024 | 2048; paddingWorld?: number };

/** Opt-in, one-map arena review fit. The caller must select shadows first.
 * Preserves the existing world light ray, distance, color and intensity. Focus
 * is an explicit world-space caster+receiver box, independent of the view camera.
 * Call before first render when changing map size; incompatible allocated maps
 * are rejected, never disposed/replaced here. The caller owns restore/rebuild.
 */
export function fitBoundedDirectionalShadow(
  light: THREE.DirectionalLight,
  focus: THREE.Box3,
  { mapSize = 2048, paddingWorld = 1 }: Options = {},
) {
  const finite = (v: THREE.Vector3) => v.toArray().every(Number.isFinite);
  const size = focus.getSize(new THREE.Vector3());
  if (
    !light.castShadow ||
    !finite(focus.min) ||
    !finite(focus.max) ||
    focus.isEmpty() ||
    !finite(size) ||
    Math.min(size.x, size.y, size.z) <= 1e-6 ||
    size.length() > 100 ||
    ![1024, 2048].includes(mapSize) ||
    !Number.isFinite(paddingWorld) ||
    paddingWorld < 0 ||
    paddingWorld > 10
  )
    throw new Error(
      "Bounded shadow requires enabled shadows and a finite positive box <=100m diagonal",
    );
  if (
    !light.matrixAutoUpdate ||
    !light.target.matrixAutoUpdate ||
    !light.matrixWorldAutoUpdate ||
    !light.target.matrixWorldAutoUpdate
  )
    throw new Error("Bounded shadow requires position-driven light and target");
  const shadow = light.shadow;
  if (
    (shadow as THREE.DirectionalLightShadow & { shadowNode?: unknown })
      .shadowNode != null
  )
    throw new Error(
      "Bounded shadow requires the single-map path, not CSM or a custom shadow node",
    );
  if (!shadow.camera.matrixAutoUpdate || shadow.camera.view?.enabled)
    throw new Error(
      "Bounded shadow requires an uncropped position-driven shadow camera",
    );
  const contains = (
    ancestor: THREE.Object3D,
    node: THREE.Object3D | null,
  ): boolean =>
    node !== null && (node === ancestor || contains(ancestor, node.parent));
  if (contains(light, light.target) || contains(light.target, light))
    throw new Error(
      "Bounded shadow requires independent light and target branches",
    );
  for (const map of [shadow.map, shadow.mapPass]) {
    if (map && (map.width !== mapSize || map.height !== mapSize))
      throw new Error(
        "Bounded shadow map size differs: caller must explicitly rebuild before fitting",
      );
  }

  // Read current hierarchy without updating any object before admission.
  const worldMatrix = (object: THREE.Object3D | null): THREE.Matrix4 => {
    if (!object) return new THREE.Matrix4();
    const local = object.matrixAutoUpdate
      ? new THREE.Matrix4().compose(
          object.position,
          object.quaternion,
          object.scale,
        )
      : object.matrix.clone();
    const world = object.matrixWorldAutoUpdate
      ? worldMatrix(object.parent).multiply(local)
      : object.matrixWorld.clone();
    if (
      !world.elements.every(Number.isFinite) ||
      Math.abs(world.determinant()) < 1e-12
    )
      throw new Error("Bounded shadow hierarchy is nonfinite or singular");
    return world;
  };
  const oldLight = new THREE.Vector3().setFromMatrixPosition(
    worldMatrix(light),
  );
  const oldTarget = new THREE.Vector3().setFromMatrixPosition(
    worldMatrix(light.target),
  );
  const z = oldLight.clone().sub(oldTarget);
  const distance = z.length();
  if (!Number.isFinite(distance) || distance <= 1e-6)
    throw new Error("Bounded shadow needs a nonzero finite light ray");
  z.divideScalar(distance);
  // Fixed-direction review fit: crossing this near-vertical threshold changes
  // the shadow-map roll/grid. This is not continuous moving-sun stabilization.
  const up =
    Math.abs(z.y) < 0.99
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const projected = new THREE.Box3();
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(
      i & 1 ? focus.max.x : focus.min.x,
      i & 2 ? focus.max.y : focus.min.y,
      i & 4 ? focus.max.z : focus.min.z,
    );
    projected.expandByPoint(new THREE.Vector3(p.dot(x), p.dot(y), p.dot(z)));
  }
  const center = projected.getCenter(new THREE.Vector3());
  const span = projected.getSize(new THREE.Vector3());
  // Reserve one texel on each side, so rounding the focus by <=half a texel
  // cannot clip the padded box. The grid is fixed in world light space.
  const texelWorld =
    (Math.max(span.x, span.y) + 2 * paddingWorld) / (mapSize - 2);
  const halfWidth = (texelWorld * mapSize) / 2;
  const snapped = center.clone();
  snapped.x = Math.round(center.x / texelWorld) * texelWorld;
  snapped.y = Math.round(center.y / texelWorld) * texelWorld;
  const near = distance - span.z / 2 - paddingWorld;
  const far = distance + span.z / 2 + paddingWorld;
  if (
    ![texelWorld, halfWidth, near, far].every(Number.isFinite) ||
    near <= 0 ||
    far <= near
  )
    throw new Error(
      "Bounded focus cannot fit in front of the light at its retained distance",
    );
  const targetWorld = x
    .clone()
    .multiplyScalar(snapped.x)
    .addScaledVector(y, snapped.y)
    .addScaledVector(z, snapped.z);
  const lightWorld = targetWorld.clone().addScaledVector(z, distance);
  const targetLocal = targetWorld
    .clone()
    .applyMatrix4(worldMatrix(light.target.parent).invert());
  const lightLocal = lightWorld
    .clone()
    .applyMatrix4(worldMatrix(light.parent).invert());
  if (!finite(targetLocal) || !finite(lightLocal))
    throw new Error("Invalid local fit");

  // All rejection checks precede the first mutation. No allocations of maps,
  // disposal, cast/receive policy changes, or sun radiometry changes below.
  light.position.copy(lightLocal);
  light.target.position.copy(targetLocal);
  light.updateWorldMatrix(true, false);
  light.target.updateWorldMatrix(true, false);
  shadow.mapSize.set(mapSize, mapSize);
  const camera = shadow.camera;
  camera.up.copy(up);
  camera.left = camera.bottom = -halfWidth;
  camera.right = camera.top = halfWidth;
  camera.near = near;
  camera.far = far;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  shadow.updateMatrices(light);
  shadow.needsUpdate = true;
  return {
    mapSize,
    texelWorld,
    near,
    far,
    retainedLightDistance: distance,
    bounds: {
      left: -halfWidth,
      right: halfWidth,
      bottom: -halfWidth,
      top: halfWidth,
    },
    inputFocusWorld: { min: focus.min.toArray(), max: focus.max.toArray() },
    focusWorld: targetWorld.toArray(),
    lightToTargetDirectionWorld: z.clone().negate().toArray(),
  };
}
