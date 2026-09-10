import type { WorldArea } from "../../../types/world/world-types";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";

export const COMPACT_POND_MODELS = Object.freeze({
  boulder: { file: "pond_boulder.glb", radius: 0.887 },
  stone: { file: "pond_flat_stone.glb", radius: 0.781 },
  fern: { file: "pond_fern.glb", radius: 0.873 },
  bush: { file: "pond_bush.glb", radius: 0.938 },
  reed: { file: "pond_reed_clump.glb", radius: 0.663 },
});
export type CompactPondModel = keyof typeof COMPACT_POND_MODELS;
// Authored plant support is the low central stem cluster, not low drooping
// leaves or the complete crown. Validated against the five canonical GLBs.
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
): readonly CompactPondPlacement[] {
  if (profile.algorithm !== "compact-island-sculpt-v1") return [];
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
  const layout: readonly [
    CompactPondModel,
    number,
    number,
    number,
    number,
    number,
  ][] = [
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
    // Current admitted pond has a monotonic bed-to-bank transition. Fourteen
    // bisections give <0.5 mm placement precision without a second shape model.
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
  return Object.freeze(
    layout.map(([model, angle, tangent, bankOffset, scale, rotation], i) => {
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
          throw new Error("Pond dressing rock extends onto the walkable bank");
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
    }),
  );
}
