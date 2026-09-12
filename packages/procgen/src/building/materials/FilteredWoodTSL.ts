import type { Node } from "three/webgpu";
import {
  abs,
  clamp,
  float,
  floor,
  fract,
  fwidth,
  max,
  min,
  mix,
  sin,
  smoothstep,
  vec3,
} from "three/tsl";

type Scalar = Node<"float">;
type Color = Node<"vec3">;
export const WOOD_GAP_FRACTION = 0.005 / 0.15;

function hash(x: Scalar, y: Scalar): Scalar {
  return fract(sin(x.mul(127.1).add(y.mul(311.7))).mul(43758.5453123));
}

/** Same resolved plank tint/grain as the legacy material. Its grain is constant
 * across each plank, so the second noise dimension is exactly an integer.
 * Fade subpixel longitudinal noise to its statistical mean BEFORE sampling
 * can turn it into a distracting dotted pattern. This is not exact 2D filtering.
 */
function plankColor(
  u: Scalar,
  row: Scalar,
  uWidth: Scalar,
  base: Color,
  secondary: Color,
  variation: Scalar,
): Color {
  const tint = hash(row, float(0)).toVar();
  const grain = fract(fract(u.div(2)).add(tint.mul(0.3)))
    .mul(20)
    .toVar();
  const cell = floor(grain).toVar();
  const f = fract(grain).toVar();
  const weight = f.mul(f).mul(float(3).sub(f.mul(2)));
  const noise = mix(hash(cell, row), hash(cell.add(1), row), weight);
  const filtered = mix(noise, float(0.5), smoothstep(0.5, 1, uWidth.mul(10)));
  return mix(base, secondary, tint.mul(variation)).mul(
    float(1).sub(filtered.mul(0.045)),
  );
}

/** Statistical limit, not the exact finite timber's hash average. */
export function woodStatisticalMeanNode(
  base: Color,
  secondary: Color,
  accent: Color,
  variation: Scalar,
): Color {
  return mix(
    mix(base, secondary, variation.mul(0.5)).mul(0.9775),
    accent,
    WOOD_GAP_FRACTION * 2,
  );
}

/** Fixed-work integration over at most TWO adjacent plank rows. Both gap
 * edges and discontinuous plank tint are area weighted, rather than taking a
 * hard step at the pixel center. Reduce coordinates before adding small widths
 * to avoid cancellation. For >1 row, smoothly approach the statistical mean
 * at >=2 rows; the clamped local filter is an approximation in that range.
 * This box-footprint approximation is not an exact pixel parallelogram.
 * No textures, new passes, render state, allocation per frame or dynamic loops.
 * Actual GPU duration and motion must still be measured in the application.
 */
export function integrateWoodFootprintNode(
  uv: Node<"vec2">,
  footprint: Node<"vec2">,
  base: Color,
  secondary: Color,
  accent: Color,
  variation: Scalar,
): Color {
  const rawWidth = abs(footprint.y).div(0.15).toVar();
  const width = clamp(rawWidth, 0.0001, 1).toVar();
  const v = uv.y.div(0.15).toVar();
  const origin = floor(v).toVar();
  const center = fract(v).toVar();
  const low = center.sub(width.mul(0.5)).toVar();
  const high = center.add(width.mul(0.5)).toVar();
  const first = floor(low).toVar();
  let sum: Color = vec3(0);
  let total: Scalar = float(0);
  for (let i = 0; i < 2; i++) {
    const localRow = first.add(i).toVar();
    const row = origin.add(localRow).toVar();
    const lo = clamp(low.sub(localRow), 0, 1).toVar();
    const hi = clamp(high.sub(localRow), 0, 1).toVar();
    const area = hi.sub(lo).toVar();
    const solid = max(
      0,
      min(hi, 1 - WOOD_GAP_FRACTION).sub(max(lo, WOOD_GAP_FRACTION)),
    ).toVar();
    const color = plankColor(
      uv.x,
      row,
      abs(footprint.x),
      base,
      secondary,
      variation,
    );
    sum = sum.add(color.mul(solid)).add(accent.mul(area.sub(solid)));
    total = total.add(area);
  }
  return mix(
    sum.div(max(total, 0.00000001)),
    woodStatisticalMeanNode(base, secondary, accent, variation),
    smoothstep(1, 2, rawWidth),
  );
}

/** Derivatives of continuous UVs, never floor/fract/discontinuous plank IDs. */
export function createFilteredWoodColorNode(
  uv: Node<"vec2">,
  base: Color,
  secondary: Color,
  accent: Color,
  variation: Scalar,
): Color {
  return integrateWoodFootprintNode(
    uv,
    fwidth(uv),
    base,
    secondary,
    accent,
    variation,
  );
}
