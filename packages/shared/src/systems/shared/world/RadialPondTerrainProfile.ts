import type { FlatZone } from "../../../types/world/terrain";
import { createAuthoredTerrainSurfaceOperations } from "./AuthoredTerrainSurface";

const surface = createAuthoredTerrainSurfaceOperations();

export function validateRadialPondTerrainProfile(
  zone: FlatZone,
): string | null {
  const profile = zone.radialPond;
  if (!profile) return null;
  const values = [
    profile.bedRadius,
    profile.bankInnerRadius,
    profile.bankOuterRadius,
    profile.bankHeight,
    zone.height,
    zone.blendRadius,
  ];
  if (!values.every(Number.isFinite)) {
    return "contains a non-finite radial pond value";
  }
  if (profile.bedRadius <= 0) return "bedRadius must be positive";
  if (profile.bankInnerRadius <= profile.bedRadius) {
    return "bankInnerRadius must exceed bedRadius";
  }
  if (profile.bankOuterRadius < profile.bankInnerRadius) {
    return "bankOuterRadius must be at least bankInnerRadius";
  }
  if (profile.bankHeight <= zone.height) {
    return "bankHeight must exceed the bed height";
  }
  if (zone.blendRadius <= 0) return "blendRadius must be positive";
  if (
    profile.shorelineAmplitude !== undefined &&
    (!Number.isFinite(profile.shorelineAmplitude) ||
      profile.shorelineAmplitude < 0 ||
      profile.shorelineAmplitude >
        Math.min(
          1,
          profile.bedRadius * 0.25,
          (profile.bankOuterRadius - profile.bankInnerRadius) * 0.5,
        ))
  )
    return "shorelineAmplitude exceeds the bounded monotonic shoreline profile";
  const requiredDiameter = 2 * (profile.bankOuterRadius + zone.blendRadius);
  if (zone.width < requiredDiameter || zone.depth < requiredDiameter) {
    return `width and depth must each be at least ${requiredDiameter}m`;
  }
  return null;
}

export function resolveRadialPondTerrainHeight(
  zone: FlatZone,
  worldX: number,
  worldZ: number,
  getProceduralHeight: () => number,
): number | null {
  return surface.resolveRadialPondTerrainHeight(
    zone,
    worldX,
    worldZ,
    getProceduralHeight,
  );
}
