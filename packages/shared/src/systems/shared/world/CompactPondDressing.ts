import type {
  CompactPondDocksManifest,
  WorldArea,
} from "../../../types/world/world-types";
import northernHabitat from "../../../data/compact-pond-northern-habitat-v1.json";
import inlandHabitat from "../../../data/compact-pond-inland-habitat-v1.json";
import {
  getCompactPondDockSupportBounds,
  validateCompactPondDockBindings,
  validateCompactPondDocks,
} from "./DockDefinition";
import {
  isCompactSculptProfile,
  type WorldTerrainProfile,
} from "./WorldTerrainProfile";

export const COMPACT_POND_MODELS = Object.freeze({
  boulder: { file: "pond_boulder.glb", radius: 0.887 },
  stone: { file: "pond_flat_stone.glb", radius: 0.781 },
  fern: { file: "pond_fern.glb", radius: 0.873 },
  bush: { file: "pond_bush.glb", radius: 0.938 },
  reed: { file: "pond_reed_clump.glb", radius: 0.663 },
  sorrel: {
    file: northernHabitat.sorrel.file,
    radius: northernHabitat.sorrel.radius,
  },
});
export type CompactPondModel = keyof typeof COMPACT_POND_MODELS;
// Authored plant support is the low central stem cluster, not low drooping
// leaves or the complete crown. Validated against the canonical GLBs.
export const COMPACT_POND_ROOT_SUPPORT = Object.freeze({
  sliceHeight: 0.05,
  centerRadius: 0.18,
});
export type CompactPondPlacement = Readonly<{
  id: string;
  model: CompactPondModel;
  x: number;
  z: number;
  scale: number;
  yaw: number;
  burial: number;
}>;

type HabitatTuple = readonly [
  CompactPondModel,
  number,
  number,
  number,
  number,
  number,
];

// This is bounded authoring data for the already-admitted multi-knot bank,
// not a second placement/terrain system. Refuse invalid content rather than
// silently moving plants, changing the rock footprint, or exceeding 64 total
// pond + service-court instances.
function northernHabitatLayout(
  original: readonly HabitatTuple[],
): readonly HabitatTuple[] {
  if (
    northernHabitat.schemaVersion !== 1 ||
    northernHabitat.layoutId !== "compact-pond-northern-habitat-v1" ||
    northernHabitat.replacements.length !== 16 ||
    northernHabitat.additions.length !== 8 ||
    original.length !== 32
  )
    throw new Error("Invalid northern pond habitat budget");
  const tuple = (
    row: (typeof northernHabitat.additions)[number],
  ): HabitatTuple => {
    if (
      !["fern", "bush", "reed", "sorrel"].includes(row.model) ||
      ![row.bearing, row.tangent, row.bankOffset, row.scale, row.yaw].every(
        Number.isFinite,
      ) ||
      row.bearing < 215 ||
      row.bearing > 280 ||
      Math.abs(row.tangent) > 2 ||
      row.bankOffset < 0.05 ||
      row.bankOffset > 2.5 ||
      row.scale < 0.3 ||
      row.scale > 1.25 ||
      row.yaw < 0 ||
      row.yaw >= 360
    )
      throw new Error("Invalid northern pond habitat plant");
    return Object.freeze([
      row.model as CompactPondModel,
      row.bearing,
      row.tangent,
      row.bankOffset,
      row.scale,
      row.yaw,
    ]);
  };
  const result = [...original];
  const replaced = new Set<number>();
  for (const row of northernHabitat.replacements) {
    if (
      !Number.isInteger(row.index) ||
      !(
        (row.index >= 5 && row.index <= 14) ||
        (row.index >= 18 && row.index <= 23)
      ) ||
      replaced.has(row.index) ||
      original[row.index][0] !== row.model
    )
      throw new Error(
        "Northern pond habitat may replace only its original plants",
      );
    replaced.add(row.index);
    result[row.index] = tuple(row);
  }
  if (
    northernHabitat.additions.filter((row) => row.model === "reed").length !==
      4 ||
    northernHabitat.additions.filter((row) => row.model === "sorrel").length !==
      4
  )
    throw new Error("Invalid northern pond habitat addition budget");
  result.push(...northernHabitat.additions.map(tuple));
  return Object.freeze(result);
}

/**
 * Three unequal habitat groups, not another evenly spaced ring. The entire
 * southern bank stays open for the bank path, static and dynamic fishing.
 * Rocks occupy existing non-walkable water only; no new collision exemptions,
 * invisible blockers or changes to authoritative terrain are introduced.
 */
export function createCompactPondDressing(
  profile: WorldTerrainProfile,
  areas: Readonly<Record<string, WorldArea>>,
  heightAt: (x: number, z: number) => number,
  compactPondDocks?: CompactPondDocksManifest,
): readonly CompactPondPlacement[] {
  if (compactPondDocks)
    return createInlandPondDressing(profile, areas, heightAt, compactPondDocks);
  if (!isCompactSculptProfile(profile)) return [];
  const ponds = areas.haven_pond?.waterBodies;
  if (ponds?.length !== 1)
    throw new Error("Compact dressing requires Haven pond");
  const pond = ponds[0];
  if (
    ![pond.centerX, pond.centerZ, pond.radius, pond.surfaceY].every(
      Number.isFinite,
    ) ||
    pond.radius < 7 ||
    pond.radius > 9
  )
    throw new Error("Unsupported compact dressing pond dimensions");

  // Habitat direction, tangent offset in metres, bank offset in metres,
  // scale, yaw. Unequal, interlocking groups replace concentric specimens.
  // Rock offset is additional to its complete radius: the shore-marker band
  // stays clear even where the authored shoreline moves in or out.
  const contactBank =
    profile.id === "compact-duel-island-v6" &&
    profile.southernMeadow !== undefined &&
    areas.haven_pond.flatZones?.some(
      (zone) => (zone.radialPond?.bankSectors?.length ?? 0) > 0,
    );
  // Only the explicit multi-knot landform admits the authored northern habitat.
  // Historical sector-only layouts retain every tuple and their five assets.
  const shapedBank =
    contactBank &&
    areas.haven_pond.flatZones?.some((zone) =>
      zone.radialPond?.bankSectors?.some(
        (sector) =>
          sector.outerRadius !== undefined && sector.outerHeight !== undefined,
      ),
    );
  const layout: readonly HabitatTuple[] = contactBank
    ? [
        // The shelf is the strongest planted contact, the north link is
        // sparse, and the eastern shoulder is mostly stone. A few outer
        // roots bridge to the separate, collidable landscape outcrops.
        // Keep the same assets/instance budget and explicit fail-closed
        // underwater guards; never silently slide a rejected rock inland.
        ["boulder", 227, -0.65, -0.4, 1.05, 24],
        ["boulder", 227, 0.55, -0.4, 0.82, 153],
        ["stone", 227, -1.15, -0.25, 0.55, 31],
        ["stone", 227, 0.05, -0.25, 0.58, 116],
        ["stone", 227, 1.0, -0.25, 0.44, 241],
        ["fern", 227, -1.0, 0.35, 0.95, 17],
        ["fern", 227, -0.15, 1.1, 0.8, 125],
        ["fern", 227, 0.75, 0.4, 1.05, 240],
        ["fern", 227, 1.2, 0.75, 0.75, 73],
        ["bush", 227, -0.3, 1.3, 0.9, 27],
        ["reed", 227, -1.05, 0.15, 0.9, 27],
        ["reed", 227, -0.45, 0.3, 0.73, 121],
        ["reed", 227, 0.1, 0.1, 1.08, 232],
        ["reed", 227, 0.6, 0.25, 0.82, 67],
        ["reed", 227, 1.0, 0.1, 0.92, 178],
        ["boulder", 294, 0.05, -0.25, 0.8, 270],
        ["stone", 294, -0.6, -0.18, 0.55, 23],
        ["stone", 294, 0.65, -0.2, 0.43, 172],
        ["fern", 294, -0.55, 0.55, 0.72, 112],
        ["fern", 294, 0.3, 1.15, 0.6, 267],
        ["bush", 294, 0.65, 1.25, 0.62, 211],
        ["reed", 294, -0.8, 0.25, 0.7, 300],
        ["reed", 294, -0.05, 0.15, 0.85, 57],
        ["reed", 294, 0.65, 0.3, 0.64, 213],
        ["boulder", 333, -0.25, -0.25, 1.05, 83],
        ["stone", 333, 0.6, -0.18, 0.46, 96],
        ["fern", 333, -0.4, 0.4, 0.65, 38],
        ["fern", 333, 0.45, 0.8, 0.6, 195],
        ["bush", 333, -0.15, 1.1, 0.65, 130],
        ["reed", 333, -0.65, 0.25, 0.6, 147],
        ["reed", 333, 0.05, 0.1, 0.8, 19],
        ["reed", 333, 0.65, 0.3, 0.64, 271],
      ]
    : [
        ["boulder", 227, -0.65, -0.7, 1.25, 24],
        ["boulder", 227, 0.55, -0.8, 1.07, 153],
        ["stone", 227, -1.15, -0.18, 0.55, 31],
        ["stone", 227, 0.05, -0.18, 0.58, 116],
        ["stone", 227, 1.0, -0.2, 0.44, 241],
        ["fern", 227, -1.0, 1.2, 0.95, 17],
        ["fern", 227, -0.15, 1.8, 0.8, 125],
        ["fern", 227, 0.75, 1.1, 1.05, 240],
        ["fern", 227, 1.2, 1.6, 0.75, 73],
        ["bush", 227, -0.3, 2.05, 0.9, 27],
        ["reed", 227, -1.05, 0.5, 0.9, 27],
        ["reed", 227, -0.45, 0.8, 0.73, 121],
        ["reed", 227, 0.1, 0.45, 1.08, 232],
        ["reed", 227, 0.6, 0.7, 0.82, 67],
        ["reed", 227, 1.0, 0.35, 0.92, 178],
        ["boulder", 294, 0.05, -0.8, 1.16, 270],
        ["stone", 294, -0.6, -0.18, 0.55, 23],
        ["stone", 294, 0.65, -0.2, 0.43, 172],
        ["fern", 294, -0.55, 1.3, 1.0, 112],
        ["fern", 294, 0.3, 1.7, 0.75, 267],
        ["bush", 294, 0.65, 2.0, 0.85, 211],
        ["reed", 294, -0.8, 0.65, 0.88, 300],
        ["reed", 294, -0.05, 0.4, 1.04, 57],
        ["reed", 294, 0.65, 0.65, 0.78, 213],
        ["boulder", 333, -0.25, -0.75, 1.11, 83],
        ["stone", 333, 0.6, -0.18, 0.46, 96],
        ["fern", 333, -0.4, 1.15, 0.85, 38],
        ["fern", 333, 0.45, 1.5, 0.7, 195],
        ["bush", 333, -0.15, 1.9, 0.72, 130],
        ["reed", 333, -0.65, 0.7, 0.72, 147],
        ["reed", 333, 0.05, 0.35, 0.96, 19],
        ["reed", 333, 0.65, 0.65, 0.75, 271],
      ];
  const shorelineAt = (angle: number): number => {
    let low = 0,
      high = pond.radius;
    const sample = (radius: number) =>
      heightAt(
        pond.centerX + Math.cos(angle) * radius,
        pond.centerZ + Math.sin(angle) * radius,
      );
    if (!(sample(low) < pond.surfaceY) || !(sample(high) > pond.surfaceY))
      throw new Error(
        "Pond dressing requires a finite underwater-to-bank shoreline",
      );
    // Admitted profiles require one submerged-to-dry crossing in this interval;
    // their dry shoulders may roll down farther inland. Fourteen bisections
    // give <0.5 mm placement precision without a second shape model.
    for (let step = 0; step < 14; step++) {
      const mid = (low + high) / 2,
        height = sample(mid);
      if (!Number.isFinite(height))
        throw new Error("Invalid pond shoreline height");
      if (height < pond.surfaceY) low = mid;
      else high = mid;
    }
    return (low + high) / 2;
  };
  const selectedLayout = shapedBank ? northernHabitatLayout(layout) : layout;
  return Object.freeze(
    selectedLayout.map(
      ([model, sourceAngle, tangent, bankOffset, scale, rotation], i) => {
        const angle = shapedBank && sourceAngle === 294 ? 271 : sourceAngle;
        const radians =
          (angle * Math.PI) / 180 +
          Math.atan2(tangent, shorelineAt((angle * Math.PI) / 180));
        const radius = COMPACT_POND_MODELS[model].radius * scale;
        const rock = model === "boulder" || model === "stone";
        const radial = shorelineAt(radians) + bankOffset - (rock ? radius : 0);
        const x = pond.centerX + Math.cos(radians) * radial;
        const z = pond.centerZ + Math.sin(radians) * radial;
        if (model === "boulder" || model === "stone") {
          // Conservative disk bounds contain every rotated model vertex. Also
          // check a bounded .25 m lattice including the enclosing square edges;
          // do not rely on the centre alone to declare a rock underwater.
          if (
            Math.hypot(x - pond.centerX, z - pond.centerZ) + radius >=
            pond.radius
          )
            throw new Error(
              "Pond dressing rock extends onto the walkable bank",
            );
          const steps = Math.ceil((radius * 2) / 0.25);
          for (let iz = 0; iz <= steps; iz++)
            for (let ix = 0; ix <= steps; ix++) {
              const sx = x - radius + (ix / steps) * radius * 2;
              const sz = z - radius + (iz / steps) * radius * 2;
              if (Math.hypot(sx - x, sz - z) > radius) continue;
              const height = heightAt(sx, sz);
              if (!Number.isFinite(height) || height >= pond.surfaceY - 0.04)
                throw new Error(
                  `Pond dressing rock requires existing underwater terrain: ${model} ${i} at ${sx},${sz} height ${height}`,
                );
            }
        }
        if (z + radius >= pond.centerZ)
          throw new Error(
            "Pond dressing must leave the southern fishing bank open",
          );
        return Object.freeze({
          id: `haven_pond_${model}_${i}`,
          model,
          x,
          z,
          scale,
          yaw: (rotation * Math.PI) / 180,
          burial: model === "boulder" ? 0.12 : 0.04,
        });
      },
    ),
  );
}

/** Separate, explicitly selected habitat recipe. It follows the actual basin
 * surface, not the historical pond's positions or a scaled decorative ring. */
function createInlandPondDressing(
  profile: WorldTerrainProfile,
  areas: Readonly<Record<string, WorldArea>>,
  heightAt: (x: number, z: number) => number,
  value: CompactPondDocksManifest,
): readonly CompactPondPlacement[] {
  const layout = validateCompactPondDocks(value, profile)!;
  const pond = validateCompactPondDockBindings(layout, areas)!;
  const zones = Object.values(areas).flatMap((area) => area.flatZones ?? []);
  const matches = zones.filter((zone) => zone.id === inlandHabitat.flatZoneId);
  const zone = matches[0];
  if (
    inlandHabitat.schemaVersion !== 1 ||
    inlandHabitat.layoutId !== "compact-pond-inland-habitat-v1" ||
    inlandHabitat.groups.length !== 3 ||
    inlandHabitat.dockClearance !== 1.25 ||
    pond.id !== inlandHabitat.waterBodyId ||
    pond.radius !== inlandHabitat.radius ||
    matches.length !== 1 ||
    !zone.radialPond ||
    zone.centerX !== pond.centerX ||
    zone.centerZ !== pond.centerZ ||
    !Number.isFinite(zone.height) ||
    zone.height! >= pond.surfaceY ||
    zone.radialPond.bankHeight <= pond.surfaceY ||
    zone.radialPond.bankComposition?.schemaVersion !== 1 ||
    zone.radialPond.bankSectors?.length !== 4
  )
    throw new Error("Inland pond habitat requires its admitted shaped basin");

  const dockBounds = layout.docks.map(getCompactPondDockSupportBounds);
  const sample = (x: number, z: number) => {
    const y = heightAt(x, z);
    if (!Number.isFinite(y))
      throw new Error("Inland habitat ground is nonfinite");
    return y;
  };
  const shorelineAt = (angle: number): number => {
    const at = (radius: number) =>
      sample(
        pond.centerX + Math.cos(angle) * radius,
        pond.centerZ + Math.sin(angle) * radius,
      );
    let low = 0,
      high = pond.radius;
    if (at(low) >= pond.surfaceY || at(high) <= pond.surfaceY)
      throw new Error(
        "Inland habitat requires a closed underwater-to-dry bank",
      );
    for (let step = 0; step < 16; step++) {
      const mid = (low + high) / 2;
      if (at(mid) < pond.surfaceY) low = mid;
      else high = mid;
    }
    return (low + high) / 2;
  };
  const result: CompactPondPlacement[] = [];
  for (const group of inlandHabitat.groups) {
    if (
      !/^[a-z][a-z-]+$/.test(group.id) ||
      !Number.isFinite(group.bearing) ||
      group.bearing < 0 ||
      group.bearing >= 360 ||
      group.placements.length === 0 ||
      group.placements.length > 12
    )
      throw new Error("Invalid inland habitat group");
    // This wider span belongs only to the seven plants in the named cutbank
    // drift. Rocks and every other pocket retain the original two-metre cap.
    const drift = group.plantDrift;
    if (
      drift !== undefined &&
      (group.id !== "northwest-cutbank" ||
        group.bearing !== 225 ||
        group.placements.length !== 10 ||
        drift.id !== "northwest-bank-drift-v1" ||
        drift.tangentMin !== -3.4 ||
        drift.tangentMax !== 3.2)
    )
      throw new Error("Invalid inland habitat plant drift");
    for (const [index, row] of group.placements.entries()) {
      const [modelValue, tangent, bankOffset, scale, rotation] = row;
      const rock = modelValue === "boulder" || modelValue === "stone";
      const driftPlant =
        drift !== undefined && index >= 3 && index < 10 && !rock;
      if (
        row.length !== 5 ||
        typeof modelValue !== "string" ||
        !Object.prototype.hasOwnProperty.call(
          COMPACT_POND_MODELS,
          modelValue,
        ) ||
        ![tangent, bankOffset, scale, rotation].every(
          (v) => typeof v === "number" && Number.isFinite(v),
        ) ||
        typeof tangent !== "number" ||
        tangent < (driftPlant ? drift.tangentMin : -2) ||
        tangent > (driftPlant ? drift.tangentMax : 2) ||
        typeof bankOffset !== "number" ||
        bankOffset < -1.5 ||
        bankOffset > 3 ||
        typeof scale !== "number" ||
        scale < 0.3 ||
        scale > 1.25 ||
        typeof rotation !== "number" ||
        rotation < 0 ||
        rotation >= 360
      )
        throw new Error("Invalid inland habitat placement");
      const model = modelValue as CompactPondModel;
      const baseAngle = (group.bearing * Math.PI) / 180;
      const angle = baseAngle + Math.atan2(tangent, shorelineAt(baseAngle));
      const radius = COMPACT_POND_MODELS[model].radius * scale;
      const distance = shorelineAt(angle) + bankOffset - (rock ? radius : 0);
      const x = pond.centerX + Math.cos(angle) * distance;
      const z = pond.centerZ + Math.sin(angle) * distance;
      for (const bounds of dockBounds) {
        const nearestX = Math.max(bounds.minX, Math.min(bounds.maxX, x));
        const nearestZ = Math.max(bounds.minZ, Math.min(bounds.maxZ, z));
        if (
          Math.hypot(x - nearestX, z - nearestZ) <=
          radius + inlandHabitat.dockClearance
        )
          throw new Error(
            "Inland habitat intrudes into dock or shore access clearance",
          );
      }
      if (rock) {
        if (
          Math.hypot(x - pond.centerX, z - pond.centerZ) + radius >=
          pond.radius
        )
          throw new Error("Inland habitat rock escapes its water envelope");
        const steps = Math.ceil((radius * 2) / 0.25);
        for (let iz = 0; iz <= steps; iz++)
          for (let ix = 0; ix <= steps; ix++) {
            const sx = x - radius + (ix / steps) * radius * 2;
            const sz = z - radius + (iz / steps) * radius * 2;
            if (Math.hypot(sx - x, sz - z) > radius) continue;
            if (sample(sx, sz) >= pond.surfaceY - 0.04)
              throw new Error(
                "Inland habitat rock footprint requires underwater ground",
              );
          }
      } else if (sample(x, z) <= pond.surfaceY) {
        throw new Error("Inland habitat plant roots require exposed ground");
      }
      result.push(
        Object.freeze({
          id: `inland_pond_${group.id}_${index}`,
          model,
          x,
          z,
          scale,
          yaw: (rotation * Math.PI) / 180,
          burial: rock ? 0.1 : 0.04,
        }),
      );
    }
  }
  // Three nonempty groups, each capped at twelve, leave room for the 24
  // service-court instances within the owner's unchanged 64-instance cap.
  if (
    result.length === 0 ||
    result.length > 36 ||
    new Set(result.map((row) => row.id)).size !== result.length
  )
    throw new Error("Inland habitat exceeds its explicit instance budget");
  return Object.freeze(result);
}
