import THREE from "../../../extras/three/three";
import { attribute, mix, storage, uv, vertexIndex } from "three/tsl";
import { StorageBufferAttribute } from "three/webgpu";
import type Node from "three/src/nodes/core/Node.js";
import { GRASS_MEADOW_REFINEMENT } from "./GrassBladeLayout";

export type GrassMeadowRefinementSample = Readonly<{
  position: Node<"vec3">;
  normal: Node<"vec3">;
  t: Node<"float">;
}>;

export type GrassMeadowRefinementResponse = Readonly<{
  position: Node<"vec3">;
  normal: Node<"vec3">;
  width: Node<"vec3">;
}>;

export const GRASS_MEADOW_COARSE_POSITION_T_ATTRIBUTE = "meadowCoarsePositionT";
export const GRASS_MEADOW_COARSE_NORMAL_U_ATTRIBUTE = "meadowCoarseNormalU";
export const GRASS_MEADOW_PARENT_PAIRS_ATTRIBUTE = "meadowParentPairs";

const BINDINGS = [
  GRASS_MEADOW_COARSE_POSITION_T_ATTRIBUTE,
  GRASS_MEADOW_COARSE_NORMAL_U_ATTRIBUTE,
  GRASS_MEADOW_PARENT_PAIRS_ATTRIBUTE,
] as const;
const R = GRASS_MEADOW_REFINEMENT;
const COARSE_COUNT = R.bladesPerClump * R.sourceVerticesPerBlade;
const FINE_COUNT = R.bladesPerClump * R.verticesPerBlade;
const COARSE_INDICES = [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6];
const COARSE_UV = [0, 0, 1, 0, 0, 1 / 3, 1, 1 / 3, 0, 2 / 3, 1, 2 / 3, 0.5, 1];

function stream(
  geometry: THREE.BufferGeometry,
  name: string,
  size: number,
  count: number,
) {
  const value = geometry.getAttribute(name);
  if (
    !(value instanceof THREE.BufferAttribute) ||
    value instanceof THREE.InstancedBufferAttribute ||
    !(value.array instanceof Float32Array) ||
    value.itemSize !== size ||
    value.count !== count ||
    value.normalized ||
    value.array.length !== size * count ||
    value.array.some((n) => !Number.isFinite(n))
  )
    throw new Error(`Invalid meadow refinement ${name} stream`);
  return value.array;
}

function topology(geometry: THREE.BufferGeometry, fine: boolean) {
  const vertices = fine ? R.verticesPerBlade : R.sourceVerticesPerBlade;
  const indices = fine ? R.indices : COARSE_INDICES;
  const index = geometry.index;
  if (
    !(index instanceof THREE.BufferAttribute) ||
    !(
      index.array instanceof Uint16Array || index.array instanceof Uint32Array
    ) ||
    index.itemSize !== 1 ||
    index.normalized ||
    index.count !== R.bladesPerClump * indices.length ||
    index.array.length !== index.count
  )
    throw new Error("Invalid meadow refinement topology");
  for (let b = 0; b < R.bladesPerClump; b++) {
    for (let i = 0; i < indices.length; i++) {
      if (index.array[b * indices.length + i] !== b * vertices + indices[i])
        throw new Error("Noncanonical meadow refinement topology");
    }
  }
}

/** Isolated, vertex-stage response interpolation; does not admit a runtime LOD.
 * The callback must be a pure response graph (three independent evaluations).
 * Geometry owns the three read-only storage attributes, as in GrassGroundingGpu;
 * they are not vertex inputs. Caller owns immutable source vertex streams and
 * borrowed uniforms. Root corrections affine in UV.x belong AFTER this response.
 * The callback reproduces the original vertex response, including its original
 * normal/width normalization. This interpolation never normalizes: the consumer
 * normalizes only after the interpolated varying reaches the fragment stage.
 */
export function createGrassMeadowRefinementResponse(
  geometry: THREE.BufferGeometry,
  coarseGeometry: THREE.BufferGeometry,
  weight: Node<"float">,
  evaluate: (
    sample: GrassMeadowRefinementSample,
  ) => GrassMeadowRefinementResponse,
): GrassMeadowRefinementResponse {
  if (
    !(geometry instanceof THREE.BufferGeometry) ||
    !(coarseGeometry instanceof THREE.BufferGeometry) ||
    geometry === coarseGeometry ||
    !(weight instanceof THREE.Node) ||
    typeof evaluate !== "function" ||
    BINDINGS.some(
      (name) =>
        geometry.hasAttribute(name) || coarseGeometry.hasAttribute(name),
    )
  )
    throw new Error("Invalid or already bound meadow refinement geometry");
  topology(geometry, true);
  topology(coarseGeometry, false);
  const p = stream(geometry, "position", 3, FINE_COUNT);
  const n = stream(geometry, "normal", 3, FINE_COUNT);
  const u = stream(geometry, "uv", 2, FINE_COUNT);
  const cp = stream(coarseGeometry, "position", 3, COARSE_COUNT);
  const cn = stream(coarseGeometry, "normal", 3, COARSE_COUNT);
  const cu = stream(coarseGeometry, "uv", 2, COARSE_COUNT);
  for (let b = 0; b < R.bladesPerClump; b++) {
    const c = b * R.sourceVerticesPerBlade;
    const f = b * R.verticesPerBlade;
    for (let v = 0; v < R.verticesPerBlade; v++) {
      const [a, z] = R.parentPairs[v];
      for (let k = 0; k < 2; k++) {
        if (
          u[(f + v) * 2 + k] !==
          Math.fround((cu[(c + a) * 2 + k] + cu[(c + z) * 2 + k]) * 0.5)
        )
          throw new Error("Noncanonical meadow refinement barycentric UV");
      }
      if (v < R.sourceVerticesPerBlade) {
        for (let k = 0; k < 3; k++) {
          if (
            p[(f + v) * 3 + k] !== cp[(c + v) * 3 + k] ||
            n[(f + v) * 3 + k] !== cn[(c + v) * 3 + k]
          )
            throw new Error("Changed meadow refinement original vertex");
        }
        for (let k = 0; k < 2; k++) {
          if (cu[(c + v) * 2 + k] !== Math.fround(COARSE_UV[v * 2 + k]))
            throw new Error("Noncanonical meadow refinement coarse UV");
        }
      }
    }
  }

  // Fixed canonical counts: 2*147*vec4<float> + 315*vec2<uint> = 7,224 bytes.
  // Copies never borrow the coarse geometry's arrays or a caller's pair table.
  const positionT = new Float32Array(COARSE_COUNT * 4);
  const normalU = new Float32Array(COARSE_COUNT * 4);
  const pairs = new Uint32Array(FINE_COUNT * 2);
  for (let v = 0; v < COARSE_COUNT; v++) {
    positionT.set(cp.subarray(v * 3, v * 3 + 3), v * 4);
    normalU.set(cn.subarray(v * 3, v * 3 + 3), v * 4);
    positionT[v * 4 + 3] = cu[v * 2 + 1];
    normalU[v * 4 + 3] = cu[v * 2];
  }
  for (let v = 0; v < FINE_COUNT; v++) {
    const base = Math.floor(v / R.verticesPerBlade) * R.sourceVerticesPerBlade;
    const pair = R.parentPairs[v % R.verticesPerBlade];
    pairs[v * 2] = base + pair[0];
    pairs[v * 2 + 1] = base + pair[1];
  }
  const positionBuffer = new StorageBufferAttribute(positionT, 4);
  const normalBuffer = new StorageBufferAttribute(normalU, 4);
  const pairBuffer = new StorageBufferAttribute(pairs, 2);
  const positions = storage(positionBuffer, "vec4", COARSE_COUNT).toReadOnly();
  const normals = storage(normalBuffer, "vec4", COARSE_COUNT).toReadOnly();
  const parents = storage(pairBuffer, "uvec2", FINE_COUNT)
    .toReadOnly()
    .element(vertexIndex);
  const a = positions.element(parents.x);
  const b = positions.element(parents.y);
  const first = evaluate({
    position: a.xyz,
    normal: normals.element(parents.x).xyz,
    t: a.w,
  });
  const second = evaluate({
    position: b.xyz,
    normal: normals.element(parents.y).xyz,
    t: b.w,
  });
  const fine = evaluate({
    position: attribute("position", "vec3"),
    normal: attribute("normal", "vec3"),
    t: uv().y,
  });
  for (const response of [first, second, fine]) {
    if (
      !response ||
      ![response.position, response.normal, response.width].every(
        (node) => node instanceof THREE.Node,
      )
    )
      throw new Error("Invalid meadow refinement response graph");
  }
  const boundedWeight = weight.clamp(0, 1);
  const result = {
    position: mix(
      first.position.add(second.position).mul(0.5),
      fine.position,
      boundedWeight,
    ),
    normal: mix(
      first.normal.add(second.normal).mul(0.5),
      fine.normal,
      boundedWeight,
    ),
    width: mix(
      first.width.add(second.width).mul(0.5),
      fine.width,
      boundedWeight,
    ),
  };
  // No geometry mutation until validation and all callback/graph construction
  // succeed. Register for the ordinary renderer geometry-disposal lifecycle.
  geometry.setAttribute(BINDINGS[0], positionBuffer);
  geometry.setAttribute(BINDINGS[1], normalBuffer);
  geometry.setAttribute(BINDINGS[2], pairBuffer);
  return result;
}
