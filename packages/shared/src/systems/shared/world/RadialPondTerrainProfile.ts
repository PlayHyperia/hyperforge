import type { FlatZone } from "../../../types/world/terrain";

const smoothstep = (value: number): number => value * value * (3 - 2 * value);

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
  const profile = zone.radialPond;
  if (!profile) return null;
  const radius = Math.hypot(worldX - zone.centerX, worldZ - zone.centerZ);
  if (radius <= profile.bedRadius) return zone.height;
  if (radius < profile.bankInnerRadius) {
    const progress =
      (radius - profile.bedRadius) /
      (profile.bankInnerRadius - profile.bedRadius);
    const weight = smoothstep(progress);
    return zone.height + (profile.bankHeight - zone.height) * weight;
  }
  if (radius <= profile.bankOuterRadius) return profile.bankHeight;
  const effectRadius = profile.bankOuterRadius + zone.blendRadius;
  if (radius >= effectRadius) return null;
  const progress = (radius - profile.bankOuterRadius) / zone.blendRadius;
  const weight = smoothstep(progress);
  return (
    profile.bankHeight + (getProceduralHeight() - profile.bankHeight) * weight
  );
}
