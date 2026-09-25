import THREE from "../../../extras/three/three";
import { GRASS_MEADOW_REFINEMENT } from "./GrassBladeLayout";

/** A separate artistic endpoint, never an implicit live geometry/LOD change.
 * The topology is reused; the old conforming-original-vertex contract is not. */
export const GRASS_MEADOW_AUTHORED_SHAPE = Object.freeze({
  ...GRASS_MEADOW_REFINEMENT,
  id: "meadow-authored-silhouette-v1",
  twistRadians: Math.PI / 15,
  metadataKey: "grassMeadowAuthoredShape",
} as const);

/** Unrounded values emitted by the real seeded clump generator. */
export type GrassMeadowAuthoredBlade = Readonly<{
  index: number;
  rootX: number;
  rootZ: number;
  height: number;
  width: number;
  facingAngle: number;
  curveX: number;
  curveZ: number;
}>;

/** Borrow the actual selected field recipe rather than duplicating its values. */
export type GrassMeadowAuthoredSourceShape = Readonly<{
  BLADE_CONTROL_HEIGHT: number;
  BLADE_TIP_HEIGHT: number;
  BLADE_CONTROL_ARC_RATIO: number;
  BLADE_TAPER: number;
  BLADE_TAPER_POWER: number;
  BLADE_WIDTH_FALLOFF_POWER: number;
  BLADE_UPPER_WIDTH_GAIN: number;
  BLADE_BASE_WIDTH_FACTOR: number;
  BLADE_FULL_WIDTH_HEIGHT: number;
}>;

type Recipe = Readonly<{
  id: typeof GRASS_MEADOW_AUTHORED_SHAPE.id;
  blades: readonly GrassMeadowAuthoredBlade[];
  sourceShape: GrassMeadowAuthoredSourceShape;
}>;

const R = GRASS_MEADOW_AUTHORED_SHAPE;
const SHAPE_KEYS = [
  "BLADE_CONTROL_HEIGHT",
  "BLADE_TIP_HEIGHT",
  "BLADE_CONTROL_ARC_RATIO",
  "BLADE_TAPER",
  "BLADE_TAPER_POWER",
  "BLADE_WIDTH_FALLOFF_POWER",
  "BLADE_UPPER_WIDTH_GAIN",
  "BLADE_BASE_WIDTH_FACTOR",
  "BLADE_FULL_WIDTH_HEIGHT",
] as const;
const BLADE_KEYS = [
  "index",
  "rootX",
  "rootZ",
  "height",
  "width",
  "facingAngle",
  "curveX",
  "curveZ",
] as const;
const COARSE_UV = [
  [0, 0],
  [1, 0],
  [0, 1 / 3],
  [1, 1 / 3],
  [0, 2 / 3],
  [1, 2 / 3],
  [0.5, 1],
] as const;
const COARSE_INDICES = [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6];

function requireValue(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

function recipeCopy(
  blades: readonly GrassMeadowAuthoredBlade[],
  sourceShape: GrassMeadowAuthoredSourceShape,
): Recipe {
  requireValue(
    Array.isArray(blades) && blades.length === R.bladesPerClump,
    "Invalid authored meadow blade population",
  );
  requireValue(
    !!sourceShape &&
      SHAPE_KEYS.every((key) => Number.isFinite(sourceShape[key])),
    "Invalid authored meadow source recipe",
  );
  requireValue(
    sourceShape.BLADE_CONTROL_HEIGHT > 0 &&
      sourceShape.BLADE_TIP_HEIGHT > sourceShape.BLADE_CONTROL_HEIGHT &&
      sourceShape.BLADE_TAPER >= 0 &&
      sourceShape.BLADE_TAPER <= 1 &&
      sourceShape.BLADE_TAPER_POWER > 0 &&
      sourceShape.BLADE_WIDTH_FALLOFF_POWER > 0 &&
      sourceShape.BLADE_UPPER_WIDTH_GAIN >= 0 &&
      sourceShape.BLADE_BASE_WIDTH_FACTOR > 0 &&
      sourceShape.BLADE_BASE_WIDTH_FACTOR <= 1 &&
      sourceShape.BLADE_FULL_WIDTH_HEIGHT > 0 &&
      sourceShape.BLADE_FULL_WIDTH_HEIGHT <= 1,
    "Invalid authored meadow dimensions",
  );
  const copied = Array.from(blades, (blade, index) => {
    requireValue(
      !!blade &&
        BLADE_KEYS.every((key) => Number.isFinite(blade[key])) &&
        blade.index === index &&
        blade.height > 0 &&
        blade.width > 0,
      "Invalid authored meadow seeded blade",
    );
    return Object.freeze({ ...blade });
  });
  return Object.freeze({
    id: R.id,
    blades: Object.freeze(copied),
    sourceShape: Object.freeze({ ...sourceShape }),
  });
}

function halfWidth(
  blade: GrassMeadowAuthoredBlade,
  t: number,
  shape: GrassMeadowAuthoredSourceShape,
) {
  const tapered =
    shape.BLADE_TAPER_POWER === 1 ? t : Math.pow(t, shape.BLADE_TAPER_POWER);
  let width = blade.width * 0.5 * (1 - tapered * shape.BLADE_TAPER);
  if (shape.BLADE_WIDTH_FALLOFF_POWER !== 1)
    width =
      blade.width *
      0.5 *
      Math.pow(
        1 - tapered * shape.BLADE_TAPER,
        shape.BLADE_WIDTH_FALLOFF_POWER,
      );
  if (shape.BLADE_UPPER_WIDTH_GAIN !== 0)
    width *=
      1 + shape.BLADE_UPPER_WIDTH_GAIN * THREE.MathUtils.smoothstep(t, 0, 0.5);
  return (
    width *
    (shape.BLADE_BASE_WIDTH_FACTOR +
      (1 - shape.BLADE_BASE_WIDTH_FACTOR) *
        THREE.MathUtils.smoothstep(t, 0, shape.BLADE_FULL_WIDTH_HEIGHT))
  );
}

/** P(t,s)=C(t)+(2s-1)w(t)S(t). S stays horizontal, so every source
 * Y remains h*B(t) and the existing height-flex recovery remains applicable.
 * Width derivatives parallel S cancel from S cross P_t. Twist's S' does NOT
 * cancel and is included below. The tip uses the centerline limiting normal. */
export function sampleGrassMeadowAuthoredBlade(
  blade: GrassMeadowAuthoredBlade,
  t: number,
  side: number,
  shape: GrassMeadowAuthoredSourceShape,
) {
  requireValue(
    Number.isFinite(t) &&
      t >= 0 &&
      t <= 1 &&
      Number.isFinite(side) &&
      side >= 0 &&
      side <= 1,
    "Invalid authored meadow sample",
  );
  const sign = blade.index % 2 === 0 ? 1 : -1;
  const sine = t === 0 || t === 1 ? 0 : Math.sin(Math.PI * t);
  const theta = blade.facingAngle + sign * R.twistRadians * sine * sine;
  const thetaPrime =
    t === 0 || t === 1
      ? 0
      : sign * R.twistRadians * Math.PI * Math.sin(2 * Math.PI * t);
  const cr = Math.cos(theta),
    sr = Math.sin(theta);
  const arc = t === 1 ? 1 : 1.2 * t * t - 0.2 * t * t * t;
  const arcPrime = 2.4 * t - 0.6 * t * t;
  const y =
    (2 * (1 - t) * t * shape.BLADE_CONTROL_HEIGHT +
      t * t * shape.BLADE_TIP_HEIGHT) *
    blade.height;
  const dy =
    2 *
    ((1 - t) * shape.BLADE_CONTROL_HEIGHT +
      t * (shape.BLADE_TIP_HEIGHT - shape.BLADE_CONTROL_HEIGHT)) *
    blade.height;
  const width = t === 1 ? 0 : halfWidth(blade, t, shape);
  const across = (2 * side - 1) * width;
  const nx = -sr * dy;
  const ny =
    sr * blade.curveX * arcPrime -
    cr * blade.curveZ * arcPrime -
    across * thetaPrime;
  const nz = cr * dy;
  const length = Math.hypot(nx, ny, nz);
  return {
    position: [
      across * cr + blade.curveX * arc + blade.rootX,
      y,
      across * sr + blade.curveZ * arc + blade.rootZ,
    ] as const,
    normal: [nx / length, ny / length, nz / length] as const,
  };
}

function coarseSample(
  blade: GrassMeadowAuthoredBlade,
  t: number,
  side: number,
  shape: GrassMeadowAuthoredSourceShape,
) {
  const cr = Math.cos(blade.facingAngle),
    sr = Math.sin(blade.facingAngle);
  const width = t === 1 ? 0 : halfWidth(blade, t, shape);
  const across = (2 * side - 1) * width;
  const arc =
    t === 1
      ? 1
      : shape.BLADE_CONTROL_ARC_RATIO === 0
        ? t * t
        : 2 * (1 - t) * t * shape.BLADE_CONTROL_ARC_RATIO + t * t;
  const y =
    (2 * (1 - t) * t * shape.BLADE_CONTROL_HEIGHT +
      t * t * shape.BLADE_TIP_HEIGHT) *
    blade.height;
  const dy =
    2 *
    ((1 - t) * shape.BLADE_CONTROL_HEIGHT +
      t * (shape.BLADE_TIP_HEIGHT - shape.BLADE_CONTROL_HEIGHT)) *
    blade.height;
  const derivative =
    2 *
    ((1 - t) * shape.BLADE_CONTROL_ARC_RATIO +
      t * (1 - shape.BLADE_CONTROL_ARC_RATIO));
  const nx = -sr * dy;
  const ny =
    shape.BLADE_CONTROL_ARC_RATIO === 0
      ? sr * 2 * blade.curveX * t - cr * 2 * blade.curveZ * t
      : sr * blade.curveX * derivative - cr * blade.curveZ * derivative;
  const nz = cr * dy,
    length = Math.hypot(nx, ny, nz);
  return {
    position: [
      across * cr + blade.curveX * arc + blade.rootX,
      y,
      across * sr + blade.curveZ * arc + blade.rootZ,
    ],
    normal: [nx / length, ny / length, nz / length],
  };
}

function stream(
  geometry: THREE.BufferGeometry,
  name: string,
  count: number,
  size: number,
) {
  const value = geometry.getAttribute(name);
  requireValue(
    value instanceof THREE.BufferAttribute &&
      !(value instanceof THREE.InstancedBufferAttribute) &&
      value.array instanceof Float32Array &&
      value.count === count &&
      value.itemSize === size &&
      !value.normalized &&
      value.array.length === count * size,
    `Invalid authored meadow ${name} stream`,
  );
  return value.array;
}

function assertCoarse(geometry: THREE.BufferGeometry, recipe: Recipe) {
  requireValue(
    geometry instanceof THREE.BufferGeometry,
    "Actual coarse meadow geometry required",
  );
  const positions = stream(geometry, "position", 147, 3),
    normals = stream(geometry, "normal", 147, 3),
    uv = stream(geometry, "uv", 147, 2);
  const index = geometry.index;
  requireValue(
    !!index &&
      (index.array instanceof Uint16Array ||
        index.array instanceof Uint32Array) &&
      index.count === 315 &&
      index.itemSize === 1 &&
      !index.normalized,
    "Invalid authored meadow coarse indices",
  );
  for (const blade of recipe.blades) {
    for (let local = 0; local < 7; local++) {
      const [side, t] = COARSE_UV[local];
      const value = coarseSample(blade, t, side, recipe.sourceShape),
        vertex = blade.index * 7 + local;
      for (let k = 0; k < 3; k++)
        requireValue(
          positions[vertex * 3 + k] === Math.fround(value.position[k]) &&
            normals[vertex * 3 + k] === Math.fround(value.normal[k]),
          "Authored meadow parameters do not reproduce actual coarse geometry",
        );
      requireValue(
        uv[vertex * 2] === Math.fround(side) &&
          uv[vertex * 2 + 1] === Math.fround(t),
        "Invalid authored meadow coarse UV",
      );
    }
    for (let i = 0; i < COARSE_INDICES.length; i++)
      requireValue(
        index.array[blade.index * 15 + i] ===
          blade.index * 7 + COARSE_INDICES[i],
        "Invalid authored meadow coarse topology",
      );
  }
}

function buildBuffers(recipe: Recipe, coarseGeometry: THREE.BufferGeometry) {
  const positions = new Float32Array(315 * 3),
    normals = new Float32Array(315 * 3),
    uv = new Float32Array(315 * 2);
  const indices = new Uint16Array(21 * R.indices.length),
    coarseVertexPairs = new Uint32Array(315 * 2);
  const coarseUv = coarseGeometry.getAttribute("uv");
  for (const blade of recipe.blades) {
    for (let local = 0; local < 15; local++) {
      const [side, t] =
        local < 7
          ? COARSE_UV[local]
          : [R.fineSamples[local - 7][1], R.fineSamples[local - 7][0] / 6];
      const vertex = blade.index * 15 + local,
        parentBase = blade.index * 7;
      const [a, b] = R.parentPairs[local];
      const value = sampleGrassMeadowAuthoredBlade(
        blade,
        t,
        side,
        recipe.sourceShape,
      );
      positions.set(value.position, vertex * 3);
      normals.set(value.normal, vertex * 3);
      coarseVertexPairs.set([parentBase + a, parentBase + b], vertex * 2);
      uv[vertex * 2] =
        (coarseUv.getX(parentBase + a) + coarseUv.getX(parentBase + b)) * 0.5;
      uv[vertex * 2 + 1] =
        (coarseUv.getY(parentBase + a) + coarseUv.getY(parentBase + b)) * 0.5;
    }
    for (let i = 0; i < R.indices.length; i++)
      indices[blade.index * R.indices.length + i] =
        blade.index * 15 + R.indices[i];
  }
  return { positions, normals, uv, indices, coarseVertexPairs };
}

export function createMeadowAuthoredShapeGeometry(
  coarseGeometry: THREE.BufferGeometry,
  blades: readonly GrassMeadowAuthoredBlade[],
  sourceShape: GrassMeadowAuthoredSourceShape,
) {
  const recipe = recipeCopy(blades, sourceShape);
  assertCoarse(coarseGeometry, recipe);
  const buffers = buildBuffers(recipe, coarseGeometry);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(buffers.positions, 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(buffers.normals, 3),
  );
  geometry.setAttribute("uv", new THREE.BufferAttribute(buffers.uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
  Object.defineProperty(geometry.userData, R.metadataKey, {
    value: recipe,
    enumerable: true,
  });
  return { geometry, coarseVertexPairs: buffers.coarseVertexPairs, layout: R };
}

/** Clone-compatible strict endpoint admission. Metadata alone never establishes
 * provenance: regenerate every float/index and the unchanged coarse source. */
export function assertGrassMeadowAuthoredEndpoint(
  geometry: THREE.BufferGeometry,
  coarseGeometry: THREE.BufferGeometry,
): void {
  requireValue(
    geometry instanceof THREE.BufferGeometry && geometry !== coarseGeometry,
    "Distinct authored meadow endpoint required",
  );
  const data: unknown = geometry.userData[R.metadataKey];
  requireValue(
    !!data &&
      typeof data === "object" &&
      "id" in data &&
      data.id === R.id &&
      "blades" in data &&
      Array.isArray(data.blades) &&
      "sourceShape" in data &&
      !!data.sourceShape &&
      typeof data.sourceShape === "object",
    "Missing authored meadow endpoint provenance",
  );
  const recipe = recipeCopy(
    data.blades as GrassMeadowAuthoredBlade[],
    data.sourceShape as GrassMeadowAuthoredSourceShape,
  );
  assertCoarse(coarseGeometry, recipe);
  const expected = buildBuffers(recipe, coarseGeometry);
  for (const [name, values, size] of [
    ["position", expected.positions, 3],
    ["normal", expected.normals, 3],
    ["uv", expected.uv, 2],
  ] as const) {
    const actual = stream(geometry, name, 315, size);
    requireValue(
      actual.every((value, i) => Number.isFinite(value) && value === values[i]),
      `Changed authored meadow ${name}`,
    );
  }
  const index = geometry.index;
  requireValue(
    !!index &&
      (index.array instanceof Uint16Array ||
        index.array instanceof Uint32Array) &&
      index.count === expected.indices.length &&
      index.itemSize === 1 &&
      !index.normalized &&
      index.array.every((value, i) => value === expected.indices[i]),
    "Changed authored meadow topology",
  );
}
