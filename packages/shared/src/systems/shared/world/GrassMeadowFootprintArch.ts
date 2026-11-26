import type THREE from "../../../extras/three/three";
import {
  FINE_GRASS_HEIGHT_FLEX_RESPONSE,
  GRASS_MEADOW_REFINEMENT,
} from "./GrassBladeLayout";
import type {
  GrassMeadowAuthoredBlade,
  GrassMeadowAuthoredSourceShape,
} from "./GrassMeadowAuthoredShape";

/** Explicit alternative endpoint. No ordinary geometry, LOD or wind contract
 * selects this recipe implicitly. XZ subdivides the actual coarse triangles;
 * only the fine endpoint follows the recurved vertical profile. */
export const GRASS_MEADOW_FOOTPRINT_ARCH = Object.freeze({
  ...GRASS_MEADOW_REFINEMENT,
  id: "meadow-footprint-arch-v1",
  metadataKey: "grassMeadowFootprintArch",
  controlHeight: 0.95 / 0.7,
  tipHeight: 0.95 * (2 / 0.7 - 1 / (0.7 * 0.7)),
  peakHeight: 0.95,
  maximumHeight: FINE_GRASS_HEIGHT_FLEX_RESPONSE.maximumHeight,
} as const);

export type GrassMeadowFootprintArchSourceShape =
  GrassMeadowAuthoredSourceShape &
    Readonly<{
      BLADE_WIDTH_BEZIER_CONTROL_POINTS?: readonly [
        number,
        number,
        number,
        number,
        number,
      ];
    }>;

type Recipe = Readonly<{
  id: typeof GRASS_MEADOW_FOOTPRINT_ARCH.id;
  blades: readonly GrassMeadowAuthoredBlade[];
  sourceShape: GrassMeadowFootprintArchSourceShape;
}>;
type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];
const R = GRASS_MEADOW_FOOTPRINT_ARCH;
const COARSE_UV: readonly Vec2[] = [
  [0, 0],
  [1, 0],
  [0, 1 / 3],
  [1, 1 / 3],
  [0, 2 / 3],
  [1, 2 / 3],
  [0.5, 1],
];
const COARSE_INDICES = [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6];
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

function requireValue(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}
function curve(t: number) {
  return t * (2 * R.controlHeight + t * (R.tipHeight - 2 * R.controlHeight));
}

/** Fine endpoint only: normalize by the interior peak, not the lower tip.
 * Coarse parents retain their original response before response interpolation. */
export function getMeadowFootprintArchWindFactor(
  t: number,
  sourceY: number,
  scale: number,
): number {
  requireValue(
    Number.isFinite(t) &&
      t >= 0 &&
      t <= 1 &&
      Number.isFinite(sourceY) &&
      sourceY >= 0 &&
      Number.isFinite(scale) &&
      scale > 0,
    "Invalid footprint arch wind input",
  );
  const height = curve(t);
  const amplitude = Math.min(
    1,
    (scale * sourceY) / (Math.max(height, 1e-5) * R.maximumHeight),
  );
  const fraction = height / R.peakHeight;
  return amplitude * fraction * fraction;
}

function recipeCopy(
  blades: readonly GrassMeadowAuthoredBlade[],
  sourceShape: GrassMeadowFootprintArchSourceShape,
): Recipe {
  requireValue(
    Array.isArray(blades) && blades.length === R.bladesPerClump,
    "Invalid footprint arch blade population",
  );
  requireValue(
    !!sourceShape &&
      SHAPE_KEYS.every((key) => Number.isFinite(sourceShape[key])),
    "Invalid footprint arch coarse recipe",
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
    "Invalid footprint arch coarse dimensions",
  );
  const controls = sourceShape.BLADE_WIDTH_BEZIER_CONTROL_POINTS;
  requireValue(
    controls === undefined ||
      (Array.isArray(controls) &&
        controls.length === 5 &&
        controls.every((value) => Number.isFinite(value) && value >= 0) &&
        controls[0] > 0),
    "Invalid footprint arch width controls",
  );
  const copied = blades.map((blade, index) => {
    requireValue(
      !!blade &&
        BLADE_KEYS.every((key) => Number.isFinite(blade[key])) &&
        blade.index === index &&
        blade.height > 0 &&
        blade.width > 0,
      "Invalid footprint arch seeded blade",
    );
    return Object.freeze({ ...blade });
  });
  return Object.freeze({
    id: R.id,
    blades: Object.freeze(copied),
    sourceShape: Object.freeze({
      ...sourceShape,
      ...(controls
        ? {
            BLADE_WIDTH_BEZIER_CONTROL_POINTS: Object.freeze([
              ...controls,
            ]) as readonly [number, number, number, number, number],
          }
        : {}),
    }),
  });
}

function smoothstep(x: number, min: number, max: number) {
  if (x <= min) return 0;
  if (x >= max) return 1;
  x = (x - min) / (max - min);
  return x * x * (3 - 2 * x);
}

// Exact flat-ribbon source arithmetic, including the explicitly selected
// quartic envelope. Do not substitute the new vertical curve into this check.
function coarseSample(
  blade: GrassMeadowAuthoredBlade,
  t: number,
  side: number,
  shape: GrassMeadowFootprintArchSourceShape,
) {
  const cr = Math.cos(blade.facingAngle),
    sr = Math.sin(blade.facingAngle);
  const tapered =
    shape.BLADE_TAPER_POWER === 1 ? t : Math.pow(t, shape.BLADE_TAPER_POWER);
  let hw = blade.width * 0.5 * (1 - tapered * shape.BLADE_TAPER);
  if (shape.BLADE_WIDTH_FALLOFF_POWER !== 1)
    hw =
      blade.width *
      0.5 *
      Math.pow(
        1 - tapered * shape.BLADE_TAPER,
        shape.BLADE_WIDTH_FALLOFF_POWER,
      );
  if (shape.BLADE_UPPER_WIDTH_GAIN !== 0)
    hw *= 1 + shape.BLADE_UPPER_WIDTH_GAIN * smoothstep(t, 0, 0.5);
  hw *=
    shape.BLADE_BASE_WIDTH_FACTOR +
    (1 - shape.BLADE_BASE_WIDTH_FACTOR) *
      smoothstep(t, 0, shape.BLADE_FULL_WIDTH_HEIGHT);
  if (shape.BLADE_WIDTH_BEZIER_CONTROL_POINTS) {
    const [a, b, c, d, e] = shape.BLADE_WIDTH_BEZIER_CONTROL_POINTS,
      s = 1 - t;
    hw =
      blade.width *
      0.5 *
      (a * s ** 4 +
        4 * b * s ** 3 * t +
        6 * c * s * s * t * t +
        4 * d * s * t ** 3 +
        e * t ** 4);
  }
  const across = t === 1 ? 0 : side === 0 ? -hw : hw;
  const arc =
    t === 1
      ? 1
      : shape.BLADE_CONTROL_ARC_RATIO === 0
        ? t * t
        : 2 * (1 - t) * t * shape.BLADE_CONTROL_ARC_RATIO + t * t;
  const y =
    t === 1
      ? blade.height * shape.BLADE_TIP_HEIGHT
      : (2 * (1 - t) * t * shape.BLADE_CONTROL_HEIGHT +
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
  const nx = -sr * dy,
    ny =
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

function isPlainAttribute(value: unknown): value is THREE.BufferAttribute {
  return (
    !!value &&
    typeof value === "object" &&
    Reflect.get(value, "isBufferAttribute") === true &&
    Reflect.get(value, "isInstancedBufferAttribute") !== true &&
    Reflect.get(value, "isInterleavedBufferAttribute") !== true
  );
}
function stream(
  geometry: THREE.BufferGeometry,
  name: string,
  count: number,
  size: number,
) {
  const value = geometry.getAttribute(name);
  requireValue(
    isPlainAttribute(value) &&
      value.array instanceof Float32Array &&
      value.count === count &&
      value.itemSize === size &&
      value.normalized === false &&
      value.array.length === count * size,
    `Invalid footprint arch ${name} stream`,
  );
  return value.array;
}
function indexStream(geometry: THREE.BufferGeometry, count: number) {
  const value = geometry.index;
  requireValue(
    isPlainAttribute(value) &&
      (value.array instanceof Uint16Array ||
        value.array instanceof Uint32Array) &&
      value.count === count &&
      value.itemSize === 1 &&
      value.normalized === false &&
      value.array.length === count,
    "Invalid footprint arch indices",
  );
  return value.array;
}
function assertCoarse(geometry: THREE.BufferGeometry, recipe: Recipe) {
  requireValue(
    geometry?.isBufferGeometry === true,
    "Actual coarse footprint geometry required",
  );
  const positions = stream(geometry, "position", 147, 3),
    normals = stream(geometry, "normal", 147, 3),
    uv = stream(geometry, "uv", 147, 2),
    index = indexStream(geometry, 315);
  for (const blade of recipe.blades) {
    for (let local = 0; local < 7; local++) {
      const [side, t] = COARSE_UV[local],
        value = coarseSample(blade, t, side, recipe.sourceShape),
        vertex = blade.index * 7 + local;
      for (let k = 0; k < 3; k++)
        requireValue(
          Number.isFinite(value.position[k]) &&
            Number.isFinite(value.normal[k]) &&
            positions[vertex * 3 + k] === Math.fround(value.position[k]) &&
            normals[vertex * 3 + k] === Math.fround(value.normal[k]),
          "Footprint parameters do not reproduce coarse geometry",
        );
      requireValue(
        uv[vertex * 2] === Math.fround(side) &&
          uv[vertex * 2 + 1] === Math.fround(t),
        "Invalid footprint coarse UV",
      );
    }
    for (let i = 0; i < COARSE_INDICES.length; i++)
      requireValue(
        index[blade.index * 15 + i] === blade.index * 7 + COARSE_INDICES[i],
        "Invalid footprint coarse topology",
      );
    const root = blade.index * 21;
    requireValue(
      Math.hypot(
        positions[root + 3] - positions[root],
        positions[root + 5] - positions[root + 2],
      ) > 1e-6,
      "Degenerate footprint root-width direction",
    );
  }
  return { positions, uv, index };
}

/** Shared retained-source validation only. The returned source has no fine
 * endpoint identity; callers must publish and validate their own recipe. */
export function captureGrassMeadowCoarseSource(
  coarseGeometry: THREE.BufferGeometry,
  blades: readonly GrassMeadowAuthoredBlade[],
  sourceShape: GrassMeadowFootprintArchSourceShape,
) {
  const recipe = recipeCopy(blades, sourceShape);
  return {
    blades: recipe.blades,
    sourceShape: recipe.sourceShape,
    ...assertCoarse(coarseGeometry, recipe),
  };
}

type Face = {
  uv: readonly Vec2[];
  xu: number;
  xt: number;
  zu: number;
  zt: number;
  bary: (u: number, t: number) => Vec3;
};
function faceFor(
  positions: Float32Array,
  uv: Float32Array,
  ids: readonly number[],
): Face {
  const points = ids.map((i) => [uv[i * 2], uv[i * 2 + 1]] as const),
    [a, b, c] = points;
  const du1 = b[0] - a[0],
    dt1 = b[1] - a[1],
    du2 = c[0] - a[0],
    dt2 = c[1] - a[1],
    det = du1 * dt2 - du2 * dt1;
  requireValue(det > 1e-8, "Degenerate footprint UV face");
  const delta = (i: number, k: number) =>
    positions[ids[i] * 3 + k] - positions[ids[0] * 3 + k];
  return {
    uv: points,
    xu: (delta(1, 0) * dt2 - delta(2, 0) * dt1) / det,
    xt: (du1 * delta(2, 0) - du2 * delta(1, 0)) / det,
    zu: (delta(1, 2) * dt2 - delta(2, 2) * dt1) / det,
    zt: (du1 * delta(2, 2) - du2 * delta(1, 2)) / det,
    bary(u, t) {
      const v = ((u - a[0]) * dt2 - du2 * (t - a[1])) / det,
        w = (du1 * (t - a[1]) - (u - a[0]) * dt1) / det;
      return [1 - v - w, v, w];
    },
  };
}

/** Analytic area covectors of UV-affine XZ + nonlinear Y, weighted by each
 * incident fine triangle's UV area. Normalize only the sum. This is a chosen
 * shading convention at a crease, not a claim of a unique tangent plane.
 * A common deformation cofactor transports this unnormalized sum linearly;
 * neither response interpolation nor grounding shear gains that claim. */
function buildBuffers(recipe: Recipe, coarse: ReturnType<typeof assertCoarse>) {
  const positions = new Float32Array(945),
    normals = new Float32Array(945),
    uv = new Float32Array(630),
    indices = new Uint16Array(945),
    coarseVertexPairs = new Uint32Array(630);
  for (const blade of recipe.blades) {
    const base = blade.index * 15,
      parentBase = blade.index * 7;
    for (let local = 0; local < 15; local++) {
      const [a, b] = R.parentPairs[local].map((value) => value + parentBase),
        vertex = base + local;
      coarseVertexPairs.set([a, b], vertex * 2);
      for (let k = 0; k < 2; k++)
        uv[vertex * 2 + k] =
          (coarse.uv[a * 2 + k] + coarse.uv[b * 2 + k]) * 0.5;
      for (const k of [0, 2])
        positions[vertex * 3 + k] =
          (coarse.positions[a * 3 + k] + coarse.positions[b * 3 + k]) * 0.5;
      positions[vertex * 3 + 1] = blade.height * curve(uv[vertex * 2 + 1]);
    }
    const faces: Face[] = [];
    for (let i = 0; i < 15; i += 3)
      faces.push(
        faceFor(
          coarse.positions,
          coarse.uv,
          Array.from(
            coarse.index.subarray(
              blade.index * 15 + i,
              blade.index * 15 + i + 3,
            ),
          ),
        ),
      );
    const sums = new Float64Array(45);
    for (let i = 0; i < R.indices.length; i += 3) {
      const ids = R.indices.slice(i, i + 3).map((value) => value + base);
      indices.set(ids, blade.index * 45 + i);
      const points = ids.map((v) => [uv[v * 2], uv[v * 2 + 1]] as const),
        [a, b, c] = points;
      const area =
        ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) * 0.5;
      const matching = faces.filter(
        (face) =>
          Math.min(
            ...face.bary((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3),
          ) > 1e-7,
      );
      requireValue(
        area > 1e-9 && matching.length === 1,
        "Invalid footprint subdivision",
      );
      const face = matching[0];
      requireValue(
        points.every((point) => Math.min(...face.bary(...point)) >= -2e-6),
        "Footprint subdivision crossed source face",
      );
      for (const vertex of ids) {
        const t = uv[vertex * 2 + 1],
          dy =
            blade.height *
            (2 * R.controlHeight + 2 * (R.tipHeight - 2 * R.controlHeight) * t),
          n = [
            -face.zu * dy,
            face.zu * face.xt - face.xu * face.zt,
            face.xu * dy,
          ];
        requireValue(
          Math.hypot(...n) > 1e-10,
          "Degenerate footprint analytic normal",
        );
        for (let k = 0; k < 3; k++)
          sums[(vertex - base) * 3 + k] += area * n[k];
      }
    }
    for (let local = 0; local < 15; local++) {
      const at = local * 3,
        length = Math.hypot(sums[at], sums[at + 1], sums[at + 2]);
      requireValue(
        Number.isFinite(length) && length > 1e-10,
        "Degenerate footprint averaged normal",
      );
      for (let k = 0; k < 3; k++)
        normals[(base + local) * 3 + k] = sums[at + k] / length;
    }
  }
  return { positions, normals, uv, indices, coarseVertexPairs };
}

/** Pure buffers; renderer ownership and admission remain with the caller. */
export function createMeadowFootprintArchBuffers(
  coarseGeometry: THREE.BufferGeometry,
  blades: readonly GrassMeadowAuthoredBlade[],
  sourceShape: GrassMeadowFootprintArchSourceShape,
) {
  const recipe = recipeCopy(blades, sourceShape),
    coarse = assertCoarse(coarseGeometry, recipe);
  return { ...buildBuffers(recipe, coarse), recipe, layout: R };
}

/** Clone-compatible provenance: regenerate the complete coarse and endpoint
 * streams. Extra grounding/storage attributes are permitted, never trusted. */
export function assertGrassMeadowFootprintArchEndpoint(
  geometry: THREE.BufferGeometry,
  coarseGeometry: THREE.BufferGeometry,
): void {
  requireValue(
    geometry?.isBufferGeometry === true && geometry !== coarseGeometry,
    "Distinct footprint arch endpoint required",
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
    "Missing footprint arch provenance",
  );
  const recipe = recipeCopy(
      data.blades as GrassMeadowAuthoredBlade[],
      data.sourceShape as GrassMeadowFootprintArchSourceShape,
    ),
    expected = buildBuffers(recipe, assertCoarse(coarseGeometry, recipe));
  for (const [name, values, size] of [
    ["position", expected.positions, 3],
    ["normal", expected.normals, 3],
    ["uv", expected.uv, 2],
  ] as const) {
    const actual = stream(geometry, name, 315, size);
    requireValue(
      actual.every((value, i) => Number.isFinite(value) && value === values[i]),
      `Changed footprint arch ${name}`,
    );
  }
  requireValue(
    indexStream(geometry, 945).every(
      (value, i) => value === expected.indices[i],
    ),
    "Changed footprint arch topology",
  );
}
