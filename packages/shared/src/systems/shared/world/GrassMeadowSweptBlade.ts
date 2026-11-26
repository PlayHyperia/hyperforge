import type THREE from "../../../extras/three/three";
import {
  FINE_GRASS_HEIGHT_FLEX_RESPONSE,
  GRASS_MEADOW_REFINEMENT,
} from "./GrassBladeLayout";
import type { GrassMeadowAuthoredBlade } from "./GrassMeadowAuthoredShape";
import {
  captureGrassMeadowCoarseSource,
  type GrassMeadowFootprintArchSourceShape,
} from "./GrassMeadowFootprintArch";

/** Opt-in continuous XYZ sweep. Material UV remains the parent's barycentric
 * parameter; only fine geometry/wind maps it to the sine-spaced curve. Neither
 * ordinary LODs nor placement select this endpoint implicitly. */
export const GRASS_MEADOW_SWEPT_BLADE = Object.freeze({
  ...GRASS_MEADOW_REFINEMENT,
  id: "meadow-swept-blade-v1",
  metadataKey: "grassMeadowSweptBlade",
  controlHeight: 0.95,
  tipHeight: 0.95,
  peakHeight: 0.95,
  maximumHeight: FINE_GRASS_HEIGHT_FLEX_RESPONSE.maximumHeight,
  widthControls: Object.freeze([0.25, 1.55, 1.05, 0.15, 0] as const),
  samplePolicy: "tip-weighted-sine-v1",
  materialUvPolicy: "coarse-parent-barycentric-v1",
} as const);

export type GrassMeadowSweptBladeSourceShape =
  GrassMeadowFootprintArchSourceShape;

type Recipe = Readonly<{
  id: typeof GRASS_MEADOW_SWEPT_BLADE.id;
  samplePolicy: typeof GRASS_MEADOW_SWEPT_BLADE.samplePolicy;
  materialUvPolicy: typeof GRASS_MEADOW_SWEPT_BLADE.materialUvPolicy;
  blades: readonly GrassMeadowAuthoredBlade[];
  sourceShape: GrassMeadowSweptBladeSourceShape;
}>;
const R = GRASS_MEADOW_SWEPT_BLADE;

function requireValue(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

function curve(t: number) {
  return t * (2 * R.controlHeight + t * (R.tipHeight - 2 * R.controlHeight));
}

/** Fine endpoint only. Parents continue to use their original wind profile.
 * Inputs are the actual canonical material UV and unscaled source Y. */
export function getMeadowSweptBladeWindFactor(
  canonicalT: number,
  sourceY: number,
  scale: number,
): number {
  requireValue(
    Number.isFinite(canonicalT) &&
      canonicalT >= 0 &&
      canonicalT <= 1 &&
      Number.isFinite(sourceY) &&
      sourceY >= 0 &&
      Number.isFinite(scale) &&
      scale > 0,
    "Invalid swept blade wind input",
  );
  const t = Math.sin(canonicalT * Math.PI * 0.5),
    height = curve(t),
    amplitude = Math.min(
      1,
      (scale * sourceY) / (Math.max(height, 1e-5) * R.maximumHeight),
    ),
    fraction = height / R.peakHeight;
  return amplitude * fraction * fraction;
}

function width(t: number) {
  const s = 1 - t,
    [a, b, c, d, e] = R.widthControls;
  return (
    a * s ** 4 +
    4 * b * s ** 3 * t +
    6 * c * s * s * t * t +
    4 * d * s * t ** 3 +
    e * t ** 4
  );
}

function assertDraw(geometry: THREE.BufferGeometry) {
  requireValue(
    geometry?.isBufferGeometry === true &&
      geometry.groups.length === 0 &&
      Object.keys(geometry.morphAttributes).length === 0 &&
      geometry.drawRange.start === 0 &&
      (geometry.drawRange.count === Infinity ||
        geometry.drawRange.count === geometry.index?.count),
    "Unmodified swept blade draw topology required",
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
    !!value &&
      Reflect.get(value, "isBufferAttribute") === true &&
      Reflect.get(value, "isInstancedBufferAttribute") !== true &&
      Reflect.get(value, "isInterleavedBufferAttribute") !== true &&
      value.array instanceof Float32Array &&
      value.array.buffer instanceof ArrayBuffer &&
      value.count === count &&
      value.itemSize === size &&
      value.normalized === false &&
      value.array.length === count * size,
    `Invalid swept blade ${name} stream`,
  );
  return value.array;
}

function buildBuffers(
  recipe: Recipe,
  coarse: ReturnType<typeof captureGrassMeadowCoarseSource>,
) {
  const positions = new Float32Array(945),
    normals = new Float32Array(945),
    uv = new Float32Array(630),
    indices = new Uint16Array(945),
    coarseVertexPairs = new Uint32Array(630);
  for (const blade of recipe.blades) {
    const parentBase = blade.index * 7,
      base = blade.index * 15,
      root = parentBase * 3,
      lo = coarse.positions.subarray(root, root + 3),
      hi = coarse.positions.subarray(root + 3, root + 6),
      dx = hi[0] - lo[0],
      dy = hi[1] - lo[1],
      dz = hi[2] - lo[2],
      span = Math.hypot(dx, dy, dz),
      axisX = dx / span,
      axisY = dy / span,
      axisZ = dz / span;
    requireValue(
      Number.isFinite(span) && span > 1e-5 && Math.abs(axisY) < 1e-8,
      "Invalid swept blade root-width frame",
    );
    const centerX = (lo[0] + hi[0]) * 0.5,
      centerZ = (lo[2] + hi[2]) * 0.5,
      nominalWidth = span / R.widthControls[0];
    for (let local = 0; local < 15; local++) {
      const vertex = base + local,
        [a, b] = R.parentPairs[local].map((value) => parentBase + value);
      coarseVertexPairs.set([a, b], vertex * 2);
      for (let k = 0; k < 2; k++)
        uv[vertex * 2 + k] =
          (coarse.uv[a * 2 + k] + coarse.uv[b * 2 + k]) * 0.5;
      const row =
        local < 7
          ? local === 6
            ? 6
            : Math.floor(local / 2) * 2
          : R.fineSamples[local - 7][0];
      const side =
        local < 7
          ? local === 6
            ? 0
            : (local % 2) * 2 - 1
          : R.fineSamples[local - 7][1] * 2 - 1;
      // Author from the exact row, as in the approved neutral source. Shader
      // wind evaluates the same mapping from stored Float32 canonical UV; no
      // claim of bitwise CPU/TSL transcendental arithmetic is made.
      const t = Math.sin((row / 6) * Math.PI * 0.5),
        p = [
          centerX +
            blade.curveX * t * t +
            axisX * 0.5 * nominalWidth * width(t) * side,
          blade.height * curve(t),
          centerZ +
            blade.curveZ * t * t +
            axisZ * 0.5 * nominalWidth * width(t) * side,
        ],
        tangentX = 2 * blade.curveX * t,
        tangentY =
          blade.height *
          (2 * (R.controlHeight + t * (R.tipHeight - 2 * R.controlHeight))),
        tangentZ = 2 * blade.curveZ * t,
        nx = axisY * tangentZ - axisZ * tangentY,
        ny = axisZ * tangentX - axisX * tangentZ,
        nz = axisX * tangentY - axisY * tangentX,
        length = Math.hypot(nx, ny, nz);
      requireValue(
        p.every(Number.isFinite) && Number.isFinite(length) && length > 1e-12,
        "Degenerate swept blade surface",
      );
      // Exact source-root bytes are intentional, including signed zero.
      positions.set(local < 2 ? (local === 0 ? lo : hi) : p, vertex * 3);
      normals.set([nx / length, ny / length, nz / length], vertex * 3);
    }
    indices.set(
      R.indices.map((value) => base + value),
      blade.index * 45,
    );
  }
  for (const values of [positions, normals, uv])
    requireValue(
      values.every(Number.isFinite),
      "Non-finite swept blade output",
    );
  return { positions, normals, uv, indices, coarseVertexPairs };
}

/** Pure, independently owned buffers. No scene, material or placement is
 * modified; the caller owns geometry creation, fitting and publication. */
export function createMeadowSweptBladeBuffers(
  coarseGeometry: THREE.BufferGeometry,
  blades: readonly GrassMeadowAuthoredBlade[],
  sourceShape: GrassMeadowSweptBladeSourceShape,
) {
  assertDraw(coarseGeometry);
  const coarse = captureGrassMeadowCoarseSource(
    coarseGeometry,
    blades,
    sourceShape,
  );
  const recipe: Recipe = Object.freeze({
    id: R.id,
    samplePolicy: R.samplePolicy,
    materialUvPolicy: R.materialUvPolicy,
    blades: coarse.blades,
    sourceShape: coarse.sourceShape,
  });
  return { ...buildBuffers(recipe, coarse), recipe, layout: R };
}

/** Clone-compatible provenance, never an id-only admission. Rebuild the
 * complete coarse and fine streams; unrelated owned GPU attributes are allowed. */
export function assertGrassMeadowSweptBladeEndpoint(
  geometry: THREE.BufferGeometry,
  coarseGeometry: THREE.BufferGeometry,
): void {
  requireValue(
    geometry !== coarseGeometry,
    "Distinct swept blade endpoint required",
  );
  assertDraw(geometry);
  const data: unknown = geometry.userData[R.metadataKey];
  requireValue(
    !!data &&
      typeof data === "object" &&
      "id" in data &&
      data.id === R.id &&
      "samplePolicy" in data &&
      data.samplePolicy === R.samplePolicy &&
      "materialUvPolicy" in data &&
      data.materialUvPolicy === R.materialUvPolicy &&
      "blades" in data &&
      Array.isArray(data.blades) &&
      "sourceShape" in data &&
      !!data.sourceShape &&
      typeof data.sourceShape === "object",
    "Missing swept blade provenance",
  );
  const expected = createMeadowSweptBladeBuffers(
    coarseGeometry,
    data.blades as GrassMeadowAuthoredBlade[],
    data.sourceShape as GrassMeadowSweptBladeSourceShape,
  );
  for (const [name, values, size] of [
    ["position", expected.positions, 3],
    ["normal", expected.normals, 3],
    ["uv", expected.uv, 2],
  ] as const) {
    const actual = stream(geometry, name, 315, size);
    requireValue(
      actual.every(
        (value, i) => Number.isFinite(value) && Object.is(value, values[i]),
      ),
      `Changed swept blade ${name}`,
    );
  }
  const index = geometry.index;
  requireValue(
    !!index &&
      index.isBufferAttribute === true &&
      Reflect.get(index, "isInstancedBufferAttribute") !== true &&
      (index.array instanceof Uint16Array ||
        index.array instanceof Uint32Array) &&
      index.array.buffer instanceof ArrayBuffer &&
      index.count === 945 &&
      index.array.length === 945 &&
      index.itemSize === 1 &&
      index.normalized === false &&
      index.array.every((value, i) => value === expected.indices[i]),
    "Changed swept blade topology",
  );
}
