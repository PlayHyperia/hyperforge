import { float, max, mix, smoothstep } from "../../../extras/three/three";
import type { Node } from "three/webgpu";

/** Artist calibration of the existing optical parameter, not horizontal shore distance. */
export const COASTAL_WATER_OPTICS = Object.freeze({
  id: "coastal-water-optics-v1",
  transitionStart: 6,
  transitionEnd: 8,
} as const);

/**
 * Construct once for nearshore ocean opacity. Keep the established deep-water
 * color curve on its original parameter; using this short depth range for tint
 * produced an artificial bright band along steep shores.
 * The caller owns the single bilinear signed-depth sample and supplies actual
 * displaced fragment Y minus sea Y. Interpolation must precede this function;
 * negative texels must not be clamped before interpolation or wave addition.
 *
 * Enabled is a finite 0/1 uniform. The static-depth weight intentionally ignores
 * displacement: disabled optics and signed depths >= 8 retain the old optical
 * parameter independently of wave height, including the deep field gutter.
 * This graph creates no texture lookup and does not change vertex waves, normals,
 * foam, or geometry. Its output is an artistic optical parameter, not bathymetry.
 */
export function createCoastalWaterOpticalDistanceNode(
  legacyShore: Node<"float">,
  signedDepth: Node<"float">,
  displacementY: Node<"float">,
  enabled: Node<"float">,
): Node<"float"> {
  const nearWeight = enabled
    .mul(
      float(1).sub(
        smoothstep(
          COASTAL_WATER_OPTICS.transitionStart,
          COASTAL_WATER_OPTICS.transitionEnd,
          signedDepth,
        ),
      ),
    )
    .toVar("coastalWaterOpticsNearWeight");
  return mix(
    legacyShore,
    max(signedDepth.add(displacementY), 0),
    nearWeight,
  ).toVar("coastalWaterOpticalDistance");
}
