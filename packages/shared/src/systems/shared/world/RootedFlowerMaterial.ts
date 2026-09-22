import THREE from "../../../extras/three/three";
import { Fn, attribute, normalLocal, positionLocal, vec3 } from "three/tsl";
import { INSTANCE_MATRIX_STORAGE_ATTRIBUTE } from "../../../utils/rendering/createStorageInstancedMesh";
import {
  TREE_WIND_MAX_DISPLACEMENT,
  assertTreeWindInstanceMatrix,
  createTreeWindBendNodes,
  createTreeWindFrameNodes,
  type TreeWindInputs,
} from "./TreeWind";

/** Universal world-space XZ displacement cap; this is not a static mesh bound. */
export const ROOTED_FLOWER_WIND_MAX_DISPLACEMENT = TREE_WIND_MAX_DISPLACEMENT;
const MIN_HEIGHT = Math.fround(0.12);
const MAX_HEIGHT = Math.fround(0.8);
const IDENTITY = new THREE.Matrix4();

function validHeight(height: number): boolean {
  // The authored endpoints are stored in Float32 flowerHeight attributes.
  return (
    Number.isFinite(height) && height >= MIN_HEIGHT && height <= MAX_HEIGHT
  );
}

/** Add this world-space radius to static XZ bounds after instance scaling.
 * Supply the stored flowerHeight.y and actual instance up-column length, as
 * used by the shader, rather than pre-quantization authoring values.
 * The shared equation clamps strength to 2 and direction length to at most 1.
 * It does not bound a future, independently animated petal deformation. */
export function getRootedFlowerWindMaxDisplacement(
  authoredHeight: number,
  instanceScale: number,
): number {
  if (
    !validHeight(authoredHeight) ||
    !Number.isFinite(instanceScale) ||
    instanceScale < 0.0001 ||
    instanceScale > 10000
  ) {
    throw new Error("Invalid rooted flower wind bounds input");
  }
  return 2 * Math.min(authoredHeight * instanceScale * 0.018, 0.18);
}

function validateGeometry(geometry: THREE.BufferGeometry): void {
  if (geometry.hasAttribute("tangent")) {
    throw new Error("Rooted flower material requires no tangent attribute");
  }
  const position = geometry.getAttribute("position");
  if (
    !(position instanceof THREE.BufferAttribute) ||
    !Number.isInteger(position.count) ||
    position.count < 3 ||
    position.count > 700
  ) {
    throw new Error("Rooted flower requires 3..700 authored vertices");
  }
  const attributes = [
    ["position", 3],
    ["normal", 3],
    ["color", 3],
    ["uv", 2],
    ["flowerHeight", 2],
    ["flowerPetal", 4],
  ] as const;
  for (const [name, itemSize] of attributes) {
    const value = geometry.getAttribute(name);
    if (
      !(value instanceof THREE.BufferAttribute) ||
      !(value.array instanceof Float32Array) ||
      value.itemSize !== itemSize ||
      value.count !== position.count ||
      value.normalized ||
      value.array.some((component) => !Number.isFinite(component))
    ) {
      throw new Error(`Invalid rooted flower ${name} attribute`);
    }
  }
  const height = geometry.getAttribute("flowerHeight");
  const petal = geometry.getAttribute("flowerPetal");
  const normal = geometry.getAttribute("normal");
  const color = geometry.getAttribute("color");
  const uv = geometry.getAttribute("uv");
  const fullHeight = height.getY(0);
  if (!validHeight(fullHeight)) {
    throw new Error("Invalid rooted flower authored height");
  }
  let hasRoot = false;
  for (let vertex = 0; vertex < position.count; vertex++) {
    const y = position.getY(vertex);
    if (
      y < 0 ||
      height.getX(vertex) !== y ||
      height.getY(vertex) !== fullHeight ||
      Math.abs(
        Math.hypot(
          normal.getX(vertex),
          normal.getY(vertex),
          normal.getZ(vertex),
        ) - 1,
      ) > 0.001 ||
      color.getX(vertex) < 0 ||
      color.getX(vertex) > 1 ||
      color.getY(vertex) < 0 ||
      color.getY(vertex) > 1 ||
      color.getZ(vertex) < 0 ||
      color.getZ(vertex) > 1 ||
      uv.getX(vertex) < 0 ||
      uv.getX(vertex) > 1 ||
      uv.getY(vertex) < 0 ||
      uv.getY(vertex) > 1 ||
      petal.getW(vertex) < 0 ||
      petal.getW(vertex) > 1
    ) {
      throw new Error("Invalid rooted flower authored metadata");
    }
    hasRoot ||= y === 0;
  }
  if (!hasRoot) throw new Error("Rooted flower geometry has no fixed root");
  const index = geometry.index;
  if (
    !index ||
    index.itemSize !== 1 ||
    !(
      index.array instanceof Uint16Array || index.array instanceof Uint32Array
    ) ||
    index.count < 3 ||
    index.count > 1800 ||
    index.count % 3 !== 0 ||
    index.array.some((vertex) => vertex >= position.count)
  ) {
    throw new Error("Invalid rooted flower bounded triangle indices");
  }
}

/** Explicit cold-path admission for a privately owned storage pool. The owner
 * must repeat transform admission at insertion/migration and keep the pool at
 * world identity. A shader cannot police later CPU matrix/geometry mutations.
 * No geometry, matrix, attribute version, bounds or borrowed uniform is edited. */
export function assertRootedFlowerPool(
  object: THREE.Object3D,
): asserts object is THREE.InstancedMesh {
  if (
    !(object instanceof THREE.InstancedMesh) ||
    !(object.instanceMatrix instanceof THREE.StorageInstancedBufferAttribute) ||
    object.instanceMatrix.itemSize !== 16 ||
    !(object.instanceMatrix.array instanceof Float32Array) ||
    !Number.isInteger(object.instanceMatrix.count) ||
    object.instanceMatrix.count < 1 ||
    object.instanceMatrix.count > 512 ||
    !Number.isInteger(object.count) ||
    object.count < 0 ||
    object.count > object.instanceMatrix.count ||
    object.geometry.getAttribute(INSTANCE_MATRIX_STORAGE_ATTRIBUTE) !==
      object.instanceMatrix
  ) {
    throw new Error(
      "Rooted flowers require an owned 1..512 storage instance pool",
    );
  }
  if (!object.matrixWorld.equals(IDENTITY)) {
    throw new Error("Rooted flower pool world matrix must be identity");
  }
  validateGeometry(object.geometry);
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < object.count; index++) {
    object.getMatrixAt(index, matrix);
    assertTreeWindInstanceMatrix(matrix);
  }
}

/** INACTIVE foundation: no world registration, placement, LOD or live owner.
 * Borrow the caller's per-world wind nodes; never allocate a second instance
 * matrix buffer or use the renderer's global time. Main bending connects the
 * stem, leaves and head. Independent petal flutter remains OPEN.
 * Native standard lighting/fog/shadows remain in charge of surface shading. */
export function createRootedFlowerMaterial(
  wind: TreeWindInputs,
): THREE.MeshStandardNodeMaterial {
  if (
    !(wind?.time instanceof THREE.Node) ||
    !(wind?.strength instanceof THREE.Node) ||
    !(wind?.direction instanceof THREE.Node)
  ) {
    throw new Error("Rooted flowers require borrowed per-world wind nodes");
  }
  const borrowedWind: TreeWindInputs = {
    time: wind.time,
    strength: wind.strength,
    direction: wind.direction,
  };
  const material = new THREE.MeshStandardNodeMaterial({
    name: "RootedFlowerMaterial",
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    fog: true,
  });
  material.positionNode = Fn((builder) => {
    assertRootedFlowerPool(builder.object);
    const frame = createTreeWindFrameNodes(builder.object);
    const bend = createTreeWindBendNodes(
      attribute("flowerHeight", "vec2"),
      frame,
      borrowedWind,
    );
    const derivative = bend.derivative.toVar();
    const normal = normalLocal.toVar();
    normalLocal.assign(
      vec3(
        normal.x,
        normal.y
          .sub(derivative.x.mul(normal.x))
          .sub(derivative.y.mul(normal.z)),
        normal.z,
      ).normalize(),
    );
    const displacement = bend.displacement.toVar();
    return positionLocal.add(vec3(displacement.x, 0, displacement.y));
  })();
  return material;
}
