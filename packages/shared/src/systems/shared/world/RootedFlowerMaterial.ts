import THREE from "../../../extras/three/three";
import {
  Fn,
  attribute,
  clamp,
  float,
  min,
  normalLocal,
  positionLocal,
  sin,
  smoothstep,
  vec2,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { INSTANCE_MATRIX_STORAGE_ATTRIBUTE } from "../../../utils/rendering/createStorageInstancedMesh";
import {
  TREE_WIND_MAX_DISPLACEMENT,
  assertTreeWindInstanceMatrix,
  createTreeWindBendNodes,
  createTreeWindFrameNodes,
  type TreeWindInputs,
} from "./TreeWind";

const PETAL_RADIUS_RATIO = 0.08;
const PETAL_GAIN = 0.6;
const PETAL_MAX_DISPLACEMENT = PETAL_GAIN * PETAL_RADIUS_RATIO ** 2;
/** Universal combined world-space sphere expansion, including petal flutter. */
export const ROOTED_FLOWER_WIND_MAX_DISPLACEMENT = Math.hypot(
  TREE_WIND_MAX_DISPLACEMENT,
  PETAL_MAX_DISPLACEMENT,
);
const MIN_HEIGHT = Math.fround(0.12);
const MAX_HEIGHT = Math.fround(0.8);
const IDENTITY = new THREE.Matrix4();

/** The owner updates this borrowed world-XZ focus from the primary view only.
 * Fixed distances keep publication/culling independent of shadow cameras. */
export type RootedFlowerFadeOptions = Readonly<{
  focus: Node<"vec2">;
  fadeStart: 24;
  fadeEnd: 32;
}>;

function validHeight(height: number): boolean {
  // The authored endpoints are stored in Float32 flowerHeight attributes.
  return (
    Number.isFinite(height) && height >= MIN_HEIGHT && height <= MAX_HEIGHT
  );
}

export interface RootedFlowerWindBounds {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sphere: number;
}

/** Combined additive world-space bounds AFTER transforming the static bounds.
 * Supply the stored flowerHeight.y and actual instance up-column length, as
 * used by the shader, rather than pre-quantization authoring values.
 * Flutter changes Y only; the subsequent stem bend remains within its XZ cap
 * even when evaluated at the fluttered height. The sphere uses their hypotenuse.
 * These expansions cover both deformed vertices and rendered triangle interiors. */
export function getRootedFlowerWindBounds(
  authoredHeight: number,
  instanceScale: number,
): RootedFlowerWindBounds {
  if (
    !validHeight(authoredHeight) ||
    !Number.isFinite(instanceScale) ||
    instanceScale < 0.0001 ||
    instanceScale > 10000
  ) {
    throw new Error("Invalid rooted flower wind bounds input");
  }
  const worldHeight = authoredHeight * instanceScale;
  const horizontal = 2 * Math.min(worldHeight * 0.018, 0.18);
  const vertical = PETAL_MAX_DISPLACEMENT * Math.min(worldHeight, 1);
  return {
    x: horizontal,
    y: vertical,
    z: horizontal,
    sphere: Math.hypot(horizontal, vertical),
  };
}

/** Combined sphere expansion, NOT the former stem-only XZ radius.
 * Prefer getRootedFlowerWindBounds for explicit per-axis box expansion. */
export function getRootedFlowerWindMaxDisplacement(
  authoredHeight: number,
  instanceScale: number,
): number {
  return getRootedFlowerWindBounds(authoredHeight, instanceScale).sphere;
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

  // A fluttered lamina may meet non-petal triangles only at its exact shared
  // zero-weight hinge. This is the C1 boundary of the quadratic shear: both
  // displacement and derivative vanish there, including its shared normal.
  const hingeKey = (vertex: number) =>
    `${petal.getX(vertex)},${petal.getY(vertex)},${petal.getZ(vertex)}`;
  const coincidentHinge = (vertex: number, reference: number) =>
    position.getX(vertex) === petal.getX(reference) &&
    position.getY(vertex) === petal.getY(reference) &&
    position.getZ(vertex) === petal.getZ(reference);
  const groups = new Map<string, { reference: number; attached: boolean }>();
  const headSupport = new Set<number>();
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const ids = [
      index.getX(triangle),
      index.getX(triangle + 1),
      index.getX(triangle + 2),
    ];
    if (ids.every((vertex) => petal.getW(vertex) === 0)) {
      for (const vertex of ids) headSupport.add(vertex);
    }
  }
  for (let vertex = 0; vertex < position.count; vertex++) {
    if (petal.getW(vertex) === 0) continue;
    if (
      position.getY(vertex) === 0 ||
      petal.getY(vertex) <= 0 ||
      Math.hypot(
        position.getX(vertex) - petal.getX(vertex),
        position.getZ(vertex) - petal.getZ(vertex),
      ) >
        PETAL_RADIUS_RATIO * fullHeight
    ) {
      throw new Error("Invalid rooted flower petal hinge envelope");
    }
    const key = hingeKey(vertex);
    if (!groups.has(key))
      groups.set(key, { reference: vertex, attached: false });
  }
  if (groups.size === 0 || groups.size > 10) {
    throw new Error("Invalid rooted flower petal groups");
  }
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const ids = [
      index.getX(triangle),
      index.getX(triangle + 1),
      index.getX(triangle + 2),
    ];
    const positive = ids.find((vertex) => petal.getW(vertex) > 0);
    if (positive === undefined) continue;
    const key = hingeKey(positive);
    const group = groups.get(key);
    if (!group) throw new Error("Missing rooted flower petal group");
    for (const vertex of ids) {
      if (petal.getW(vertex) > 0) {
        if (hingeKey(vertex) !== key) {
          throw new Error("Rooted flower triangle crosses petal groups");
        }
      } else {
        if (
          hingeKey(vertex) !== key ||
          !coincidentHinge(vertex, group.reference) ||
          !headSupport.has(vertex)
        ) {
          throw new Error("Rooted flower petal has no shared head hinge");
        }
        group.attached = true;
      }
    }
  }
  if ([...groups.values()].some((group) => !group.attached)) {
    throw new Error("Rooted flower petal group is detached");
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
 * stem, leaves and head. A small per-petal quadratic shear is composed first;
 * flowerPetal.w identifies the lamina, not a spatial derivative of authored t².
 * Native standard lighting/fog/shadows remain in charge of surface shading. */
export function createRootedFlowerMaterial(
  wind: TreeWindInputs,
  fade?: RootedFlowerFadeOptions,
): THREE.MeshStandardNodeMaterial {
  if (
    !(wind?.time instanceof THREE.Node) ||
    !(wind?.strength instanceof THREE.Node) ||
    !(wind?.direction instanceof THREE.Node)
  ) {
    throw new Error("Rooted flowers require borrowed per-world wind nodes");
  }
  if (
    fade !== undefined &&
    (!(fade?.focus instanceof THREE.Node) ||
      fade.fadeStart !== 24 ||
      fade.fadeEnd !== 32)
  ) {
    throw new Error(
      "Rooted flower fade requires a focus node and fixed 24/32 bounds",
    );
  }
  const borrowedFocus = fade?.focus;
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
    if (borrowedFocus && borrowedFocus.getNodeType(builder) !== "vec2")
      throw new Error("Rooted flower fade focus must be vec2");
    const frame = createTreeWindFrameNodes(builder.object);
    const height = attribute("flowerHeight", "vec2");
    const petal = attribute("flowerPetal", "vec4");
    const offset = frame
      .transformTangent(attribute("position", "vec3").sub(petal.xyz))
      .toVar();
    const worldHeight = height.y.mul(frame.scale).toVar();
    // Per-petal phase is constant across its lamina, including the hinge.
    // The same world time/strength/direction drives both flutter and stem wind.
    const phase = frame.root.x
      .mul(0.013)
      .add(frame.root.z.mul(0.017))
      .add(petal.x.mul(71).add(petal.z.mul(113)).div(height.y));
    const amplitude = sin(borrowedWind.time.mul(2.1).add(phase))
      .mul(clamp(borrowedWind.strength, 0, 2).mul(0.5))
      .mul(min(borrowedWind.direction.length(), 1));
    const coefficient = petal.w
      .greaterThan(0)
      .select(
        amplitude
          .mul(PETAL_GAIN)
          .mul(min(worldHeight, 1))
          .div(worldHeight.mul(worldHeight)),
        float(0),
      )
      .toVar();
    const radiusSquared = offset.x
      .mul(offset.x)
      .add(offset.z.mul(offset.z))
      .toVar();
    const radiusCap = worldHeight.mul(PETAL_RADIUS_RATIO).toVar();
    const capSquared = radiusCap.mul(radiusCap);
    // Defensive radial cap also covers tolerated instance-matrix roundoff.
    // Actual admitted petals lie inside it; outside, the capped field has zero
    // derivative. At the exact cap we use that zero one-sided convention.
    const flutterY = coefficient.mul(min(radiusSquared, capSquared)).toVar();
    const flutterSlope = radiusSquared
      .lessThan(capSquared)
      .select(coefficient.mul(2), float(0))
      .toVar();
    const flutterGradient = offset.xz.mul(flutterSlope).toVar();
    const bend = createTreeWindBendNodes(
      vec2(height.x.add(flutterY.div(frame.scale)), height.y),
      frame,
      borrowedWind,
    );
    const derivative = bend.derivative.toVar();
    const normal = normalLocal.toVar();
    // J_flutter^-T, then J_stem^-T evaluated at the fluttered height.
    const flutterNormal = vec3(
      normal.x.sub(flutterGradient.x.mul(normal.y)),
      normal.y,
      normal.z.sub(flutterGradient.y.mul(normal.y)),
    ).toVar();
    normalLocal.assign(
      vec3(
        flutterNormal.x,
        flutterNormal.y
          .sub(derivative.x.mul(flutterNormal.x))
          .sub(derivative.y.mul(flutterNormal.z)),
        flutterNormal.z,
      ).normalize(),
    );
    const displacement = bend.displacement.toVar();
    const deformed = positionLocal.add(
      vec3(displacement.x, flutterY, displacement.y),
    );
    if (!borrowedFocus) return deformed;
    // One constant per instance, after both wind stages. No camera node, alpha
    // change or extra normal division: isotropic shrink leaves normals intact,
    // even when the far endpoint degenerates every triangle at the root anchor.
    const retainedScale = float(1).sub(
      smoothstep(24, 32, frame.root.xz.sub(borrowedFocus).length()),
    );
    return frame.root.add(deformed.sub(frame.root).mul(retainedScale));
  })();
  return material;
}
