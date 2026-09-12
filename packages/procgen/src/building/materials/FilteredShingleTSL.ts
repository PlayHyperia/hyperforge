import type { Node } from "three/webgpu";
import {
  abs,
  asin,
  clamp,
  float,
  floor,
  fract,
  fwidth,
  max,
  min,
  mix,
  select,
  sin,
  smoothstep,
  vec2,
  vec3,
} from "three/tsl";

// Preserve the legacy curve's actual literal, not a silently retuned shingle.
export const SHINGLE_CURVE_PI = 3.14159;
export const SHINGLE_MEAN_GAP =
  0.05 + (0.1 * (1 - Math.cos(SHINGLE_CURVE_PI))) / SHINGLE_CURVE_PI;
// The same hash drives tint and thickness: E[h]=1/2, E[h*h]=1/3.
export const SHINGLE_CORRELATED_HASH_MEAN = 61 / 120;

type Scalar = Node<"float">;
type Color = Node<"vec3">;

function support(c: Scalar) {
  const angle = asin(clamp(c.sub(0.05).div(0.1), 0, 1)).toVar();
  return {
    c,
    lo: angle.div(SHINGLE_CURVE_PI).toVar(),
    hi: float(Math.PI).sub(angle).div(SHINGLE_CURVE_PI).toVar(),
  };
}

/** Integral of max(0, .05 + .1*sin(K*u) - c), on a clipped cell interval. */
function positiveIntegral(
  edge: ReturnType<typeof support>,
  uLo: Scalar,
  uHi: Scalar,
): Scalar {
  const lo = max(uLo, edge.lo).toVar();
  const hi = max(lo, min(uHi, edge.hi)).toVar();
  const span = hi.sub(lo).toVar();
  const halfAngle = span.mul(SHINGLE_CURVE_PI / 2).toVar();
  // sin(x)/x is finite at zero; the polynomial also avoids tiny-interval
  // cancellation when the camera is very close to a curved gap boundary.
  const square = halfAngle.mul(halfAngle).toVar();
  const sinc = select(
    halfAngle.lessThan(0.01),
    float(1).sub(square.div(6)).add(square.mul(square).div(120)),
    sin(halfAngle).div(max(halfAngle, 0.000001)),
  ).toVar();
  return span
    .mul(
      float(0.05)
        .sub(edge.c)
        .add(
          sin(lo.add(hi).mul(SHINGLE_CURVE_PI / 2))
            .mul(0.1)
            .mul(sinc),
        ),
    )
    .toVar();
}

/** Statistical infinite-pattern mean, not an exact finite-roof/GPU hash average. */
export function shingleStatisticalMeanNode(
  base: Color,
  secondary: Color,
  variation: Scalar,
): Color {
  const solidMean = base.add(
    secondary.sub(base).mul(variation).mul(SHINGLE_CORRELATED_HASH_MEAN),
  );
  return mix(solidMean, base.mul(0.3), SHINGLE_MEAN_GAP);
}

/**
 * Fixed-work box-footprint filter in continuous shingle-cell coordinates.
 * At widths <=1 cell, analytically integrate over at most two
 * staggered rows and two columns per row. Both periodic gap edges are included.
 * The derivative bounding rectangle is NOT the exact pixel parallelogram.
 * Widths >1 are capped, then smoothly approach the statistical mean at >=2.
 * This minification blend is an approximation, not exact anisotropic filtering.
 * The small-argument sinc uses a fourth-order series below .01 (omitted term
 * <2e-16 in real arithmetic); float32/driver precision remains a native limit.
 * Four cells, four hashes and four inverse-sine supports; no texture/pass/state
 * allocation or data-dependent iteration. This is not a measured GPU-cost claim.
 * Call within the existing material Fn stack: explicit vars share each expensive
 * support/hash/interval expression rather than relying on backend CSE.
 */
export function integrateShingleFootprintNode(
  cellUV: Node<"vec2">,
  footprint: Node<"vec2">,
  base: Color,
  secondary: Color,
  variation: Scalar,
): Color {
  const rawWidth = abs(footprint).toVar();
  const width = clamp(rawWidth, vec2(0.0001), vec2(1)).toVar();
  // Reduce to fractional coordinates BEFORE adding the footprint. Only hash
  // identity uses absolute cell IDs; tiny widths must not subtract large UVs.
  const origin = floor(cellUV).toVar();
  const center = fract(cellUV).toVar();
  const low = center.sub(width.mul(0.5)).toVar();
  const high = center.add(width.mul(0.5)).toVar();
  const firstRow = floor(low.y).toVar();
  let sum: Color = vec3(0);
  let totalArea: Scalar = float(0);
  for (let ri = 0; ri < 2; ri++) {
    const localRow = firstRow.add(ri).toVar();
    const row = origin.y.add(localRow).toVar();
    const rowOffset = row.mod(2).mul(0.5).toVar();
    const vLo = clamp(low.y.sub(localRow), 0, 1).toVar();
    const vHi = clamp(high.y.sub(localRow), 0, 1).toVar();
    const lower = support(vLo),
      upper = support(vHi);
    const firstColumn = floor(low.x.add(rowOffset)).toVar();
    for (let ci = 0; ci < 2; ci++) {
      const localColumn = firstColumn.add(ci).toVar();
      const column = origin.x.add(localColumn).toVar();
      const uLo = clamp(low.x.add(rowOffset).sub(localColumn), 0, 1).toVar();
      const uHi = clamp(high.x.add(rowOffset).sub(localColumn), 0, 1).toVar();
      const area = uHi.sub(uLo).mul(vHi.sub(vLo)).toVar();
      const gapArea = clamp(
        positiveIntegral(lower, uLo, uHi).sub(
          positiveIntegral(upper, uLo, uHi),
        ),
        0,
        area,
      ).toVar();
      const h = fract(
        sin(column.mul(127.1).add(row.mul(311.7))).mul(43758.5453123),
      ).toVar();
      const solid = mix(base, secondary, h.mul(variation))
        .mul(float(0.95).add(h.mul(0.1)))
        .toVar();
      sum = sum
        .add(solid.mul(area.sub(gapArea)))
        .add(base.mul(0.3).mul(gapArea));
      totalArea = totalArea.add(area);
    }
  }
  // In real arithmetic this sum is width.x*width.y. Using the same clipped
  // areas preserves convex color weights despite float32 endpoint rounding.
  const local = sum.div(max(totalArea, 0.000000000001));
  const unresolved = smoothstep(1, 2, max(rawWidth.x, rawWidth.y));
  return mix(
    local,
    shingleStatisticalMeanNode(base, secondary, variation),
    unresolved,
  );
}

/** Derivatives are taken before floor/fract/stagger, and only in the color graph. */
export function createFilteredShingleColorNode(
  scaledUV: Node<"vec2">,
  base: Color,
  secondary: Color,
  variation: Scalar,
): Color {
  const cellUV = scaledUV.div(vec2(0.2, 0.15 * (1 - 0.3))).toVar();
  return integrateShingleFootprintNode(
    cellUV,
    fwidth(cellUV),
    base,
    secondary,
    variation,
  );
}
