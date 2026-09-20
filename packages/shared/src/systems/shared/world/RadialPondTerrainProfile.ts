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
  if ("bankSectors" in profile) {
    const field = Object.getOwnPropertyDescriptor(profile, "bankSectors");
    if (!field || !field.enumerable || !("value" in field))
      return "bankSectors must be an own data field";
    const sectors: unknown = field.value;
    if (
      !Array.isArray(sectors) ||
      Object.getPrototypeOf(sectors) !== Array.prototype ||
      sectors.length > 4 ||
      Reflect.ownKeys(sectors).length !== sectors.length + 1
    )
      return "bankSectors must be a dense plain array of at most four sectors";
    const baseKeys = [
      "bearing",
      "halfWidth",
      "innerRadius",
      "innerHeight",
    ] as const;
    for (let index = 0; index < sectors.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(sectors, String(index));
      if (!entry || !entry.enumerable || !("value" in entry))
        return "bankSectors must contain own dense data rows";
      const row: unknown = entry.value;
      if (
        !row ||
        typeof row !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(row))
      )
        return "bankSectors rows must contain plain data fields";
      const hasOuterRadius = Object.prototype.hasOwnProperty.call(
        row,
        "outerRadius",
      );
      const hasOuterHeight = Object.prototype.hasOwnProperty.call(
        row,
        "outerHeight",
      );
      if (hasOuterRadius !== hasOuterHeight)
        return "bankSectors outerRadius and outerHeight must be paired";
      const keys = hasOuterRadius
        ? [...baseKeys, "outerRadius", "outerHeight"]
        : baseKeys;
      if (Reflect.ownKeys(row).length !== keys.length)
        return "bankSectors rows must contain exactly four or six plain data fields";
      const values: number[] = [];
      for (const key of keys) {
        const value = Object.getOwnPropertyDescriptor(row, key);
        if (
          !value ||
          !value.enumerable ||
          !("value" in value) ||
          typeof value.value !== "number" ||
          !Number.isFinite(value.value)
        )
          return "bankSectors fields must be own finite data values";
        values.push(value.value);
      }
      const [bearing, halfWidth, innerRadius, innerHeight] = values;
      if (
        bearing < -Math.PI ||
        bearing > Math.PI ||
        halfWidth <= 0 ||
        halfWidth > Math.PI / 2 ||
        innerRadius <= profile.bedRadius ||
        innerRadius >= profile.bankOuterRadius ||
        innerHeight <= zone.height ||
        innerHeight > profile.bankHeight
      )
        return "bankSectors exceeds angular or monotonic bank-profile bounds";
      if (hasOuterRadius) {
        const [, , , , outerRadius, outerHeight] = values;
        if (
          outerRadius <= innerRadius ||
          outerRadius >= profile.bankOuterRadius + zone.blendRadius ||
          outerHeight < innerHeight ||
          outerHeight > profile.bankHeight + 0.6
        )
          return "bankSectors exceeds paired outer-knot bounds";
      }
    }
  }
  if ("bankComposition" in profile) {
    const field = Object.getOwnPropertyDescriptor(profile, "bankComposition");
    if (!field?.enumerable || !("value" in field))
      return "bankComposition must be an own data field";
    const composition: unknown = field.value;
    if (
      !composition ||
      typeof composition !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(composition)) ||
      Reflect.ownKeys(composition).length !== 2
    )
      return "bankComposition must contain exactly two plain data fields";
    const version = Object.getOwnPropertyDescriptor(
      composition,
      "schemaVersion",
    );
    const list = Object.getOwnPropertyDescriptor(composition, "sectors");
    if (!version?.enumerable || !("value" in version) || version.value !== 1)
      return "bankComposition requires schemaVersion 1 as own data";
    if (!list?.enumerable || !("value" in list))
      return "bankComposition sectors must be an own data field";
    const rows: unknown = list.value;
    if (
      !Array.isArray(rows) ||
      Object.getPrototypeOf(rows) !== Array.prototype ||
      rows.length > 4 ||
      Reflect.ownKeys(rows).length !== rows.length + 1
    )
      return "bankComposition sectors must be a dense plain array of at most four rows";
    const seen = new Set<number>();
    for (let index = 0; index < rows.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(rows, String(index));
      if (!entry?.enumerable || !("value" in entry))
        return "bankComposition sectors must contain own data rows";
      const row: unknown = entry.value;
      if (
        !row ||
        typeof row !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
        Reflect.ownKeys(row).length !== ("groundCover" in row ? 3 : 2)
      )
        return "bankComposition rows must contain two or three plain data fields";
      const reference = Object.getOwnPropertyDescriptor(row, "sectorIndex");
      const role = Object.getOwnPropertyDescriptor(row, "surface");
      if (
        !reference?.enumerable ||
        !("value" in reference) ||
        !Number.isInteger(reference.value) ||
        reference.value < 0 ||
        reference.value >= (profile.bankSectors?.length ?? 0) ||
        seen.has(reference.value)
      )
        return "bankComposition sectorIndex must uniquely reference an existing sector";
      if (
        !role?.enumerable ||
        !("value" in role) ||
        (role.value !== "sedge-shelf" &&
          role.value !== "cutbank" &&
          role.value !== "dry-turf" &&
          role.value !== "mineral-shore")
      )
        return "bankComposition surface must be a supported own data value";
      if ("groundCover" in row) {
        if (role.value === "mineral-shore")
          return "bankComposition mineral-shore cannot establish groundCover";
        const property = Object.getOwnPropertyDescriptor(row, "groundCover");
        if (!property?.enumerable || !("value" in property))
          return "bankComposition groundCover must be an own data field";
        const cover: unknown = property.value;
        if (
          !cover ||
          typeof cover !== "object" ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(cover)) ||
          Reflect.ownKeys(cover).length !== 2
        )
          return "bankComposition groundCover must contain exactly two plain data fields";
        const emergence = Object.getOwnPropertyDescriptor(
          cover,
          "emergenceHeight",
        );
        const full = Object.getOwnPropertyDescriptor(cover, "fullHeight");
        if (
          !emergence?.enumerable ||
          !("value" in emergence) ||
          !full?.enumerable ||
          !("value" in full) ||
          typeof emergence.value !== "number" ||
          !Number.isFinite(emergence.value) ||
          typeof full.value !== "number" ||
          !Number.isFinite(full.value) ||
          emergence.value <= 0 ||
          full.value < emergence.value + 0.01 ||
          full.value > 0.6
        )
          return "bankComposition groundCover requires positive emergenceHeight, at least 0.01m transition width, and fullHeight <= 0.6";
      }
      seen.add(reference.value);
    }
  }
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
