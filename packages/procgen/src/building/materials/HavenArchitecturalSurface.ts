import type { Node } from "three/webgpu";
import {
  float,
  vec2,
  vec4,
  sin,
  cos,
  fract,
  floor,
  max,
  smoothstep,
  select,
} from "three/tsl";

export type HavenSurfaceType =
  "wood-plank" | "shingle" | "stone-ashlar" | "plaster";
type Scalar = Node<"float">;

/** Compact material recipe only; heights are meters, not displacement. */
export const HAVEN_ARCHITECTURAL_ROOF_CONFIG = Object.freeze({
  baseColor: "#79776e",
  secondaryColor: "#5d625c",
  accentColor: "#333e3e",
  scale: 0.35,
  roughness: 0.88,
  variation: 0.3,
});

/** Local-unit box projection: authored compact owners use meter coordinates and
 * unit root scale. Object scaling deliberately scales this physical pattern too.
 * It does not normalize a scaled object back to world-meter texel density.
 */
export function createHavenLocalMetricUV(
  position: Node<"vec3">,
  normal: Node<"vec3">,
): Node<"vec2"> {
  const axis = normal.abs();
  return select(
    axis.y.greaterThan(axis.x).and(axis.y.greaterThan(axis.z)),
    position.xz,
    select(axis.x.greaterThan(axis.z), position.zy, position.xy),
  );
}

function ramp(value: Scalar) {
  const t = value.clamp(0, 1).toVar();
  return {
    value: t
      .mul(t)
      .mul(float(3).sub(t.mul(2)))
      .toVar(),
    derivative: t.mul(float(1).sub(t)).mul(6).toVar(),
  };
}

/** Pure actual TSL height/analytic gradient. The bounded C1 profiles close at
 * every periodic joint, including staggered rows. No albedo-to-height inference.
 * UVs are the same scaled coordinates used by the existing color patterns.
 */
export function createHavenReliefProfile(
  type: HavenSurfaceType,
  uv: Node<"vec2">,
) {
  if (type === "plaster") {
    const x = uv.x.mul(2 * Math.PI),
      y = uv.y.mul(2 * Math.PI);
    const height = sin(x).mul(sin(y)).mul(0.00025);
    return {
      height,
      gradient: vec2(cos(x).mul(sin(y)), sin(x).mul(cos(y))).mul(
        0.00025 * 2 * Math.PI,
      ),
      coverage: height.div(0.0005).add(0.5),
      cellScale: vec2(1),
    };
  }
  if (type === "wood-plank") {
    const v = fract(uv.y.div(0.15)).toVar();
    const a = ramp(v.div(0.045)),
      b = ramp(float(1).sub(v).div(0.045));
    const coverage = a.value.mul(b.value).toVar();
    return {
      height: coverage.sub(1).mul(0.0007),
      gradient: vec2(
        0,
        a.derivative
          .mul(b.value)
          .sub(a.value.mul(b.derivative))
          .mul(0.0007 / (0.045 * 0.15)),
      ),
      coverage,
      cellScale: vec2(0, 1 / 0.15),
    };
  }
  const shingle = type === "shingle";
  const width = shingle ? 0.2 : 0.6,
    height = shingle ? 0.105 : 0.3;
  const cell = uv.div(vec2(width, height));
  const row = floor(cell.y);
  const u = fract(cell.x.add(row.mod(2).mul(0.5))).toVar();
  const v = fract(cell.y).toVar();
  const edge = shingle ? 0.04 : 0.06;
  const left = ramp(u.div(edge)),
    right = ramp(float(1).sub(u).div(edge));
  const horizontal = left.value.mul(right.value).toVar();
  const horizontalDerivative = left.derivative
    .mul(right.value)
    .sub(left.value.mul(right.derivative))
    .div(edge);
  // Existing roof color's scalloped lower lap; ashlar uses straight mortar.
  const gap = shingle ? sin(u.mul(Math.PI)).mul(0.1).add(0.05) : float(0.05);
  const gapDerivative = shingle
    ? cos(u.mul(Math.PI)).mul(0.1 * Math.PI)
    : float(0);
  const rise = shingle ? 0.08 : 0.06,
    fall = shingle ? 0.05 : 0.06;
  const lower = ramp(v.sub(gap).div(rise)),
    upper = ramp(float(1).sub(v).div(fall));
  const vertical = lower.value.mul(upper.value).toVar();
  const depth = shingle ? 0.004 : 0.0025;
  const coverage = horizontal.mul(vertical).toVar();
  return {
    height: coverage.mul(depth),
    gradient: vec2(
      horizontalDerivative
        .mul(vertical)
        .sub(
          horizontal
            .mul(lower.derivative)
            .mul(upper.value)
            .mul(gapDerivative)
            .div(rise),
        )
        .mul(depth / width),
      horizontal
        .mul(
          lower.derivative
            .mul(upper.value)
            .div(rise)
            .sub(lower.value.mul(upper.derivative).div(fall)),
        )
        .mul(depth / height),
    ),
    coverage,
    cellScale: vec2(1 / width, 1 / height),
  };
}

/** Smoothly suppress unresolved relief, not an exact pixel-area integration.
 * Shared coverage controls roughness and small-scale cavity occlusion. The
 * existing analytically filtered color graph remains authoritative at distance.
 */
export function createHavenSurfaceResponse(
  type: HavenSurfaceType,
  uv: Node<"vec2">,
  footprint: Node<"vec2">,
  roughness: Scalar,
) {
  const profile = createHavenReliefProfile(type, uv);
  const cellFootprint = footprint.abs().mul(profile.cellScale);
  const resolved = float(1)
    .sub(smoothstep(0.02, 0.2, max(cellFootprint.x, cellFootprint.y)))
    .toVar();
  const cavity = float(1).sub(profile.coverage).mul(resolved).toVar();
  return {
    gradient: profile.gradient.mul(resolved).toVar(),
    roughness: roughness
      .add(cavity.mul(type === "plaster" ? 0.025 : 0.07))
      .clamp(0.45, 0.98),
    ao: float(1).sub(cavity.mul(type === "plaster" ? 0 : 0.1)),
  };
}

/** Surface gradient from actual screen derivatives. Keeping unnormalized
 * position derivatives preserves meter-valued relief under UV/object scale.
 * Mirrored UVs and either screen orientation use the signed determinant.
 * Input normal is geometry-only, so normalNode never depends on normalWorld.
 */
export function havenReliefWorldNormal(
  gradient: Node<"vec2">,
  uvDx: Node<"vec2">,
  uvDy: Node<"vec2">,
  positionDx: Node<"vec3">,
  positionDy: Node<"vec3">,
  geometryNormal: Node<"vec3">,
) {
  const n = geometryNormal.normalize();
  const r1 = positionDy.cross(n),
    r2 = n.cross(positionDx);
  const determinant = positionDx.dot(r1).toVar();
  const surfaceGradient = r1
    .mul(gradient.dot(uvDx))
    .add(r2.mul(gradient.dot(uvDy)))
    .mul(determinant.sign().div(determinant.abs().max(1e-12)));
  return n.sub(surfaceGradient).normalize();
}

/** normalNode uses a direction in view space, never a row-vector multiply. */
export function havenReliefViewNormal(
  worldNormal: Node<"vec3">,
  viewMatrix: Node<"mat4">,
) {
  return viewMatrix.mul(vec4(worldNormal, 0)).xyz.normalize();
}
