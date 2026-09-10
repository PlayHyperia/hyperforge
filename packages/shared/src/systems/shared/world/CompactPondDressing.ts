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

  // angle degrees, fraction of water radius, uniform scale, rotation degrees.
  const layout: readonly [CompactPondModel, number, number, number, number][] =
    [
      ["boulder", 219, 0.68, 1.15, 24],
      ["boulder", 233, 0.76, 0.72, 153],
      ["boulder", 302, 0.73, 0.92, 270],
      ["boulder", 341, 0.73, 0.82, 83],
      ["stone", 212, 0.78, 0.55, 31],
      ["stone", 226, 0.77, 0.58, 116],
      ["stone", 240, 0.79, 0.44, 241],
      ["stone", 298, 0.78, 0.55, 23],
      ["stone", 312, 0.79, 0.43, 172],
      ["stone", 339, 0.79, 0.46, 96],
      ["fern", 216, 1.15, 0.95, 17],
      ["fern", 224, 1.2, 0.8, 125],
      ["fern", 236, 1.12, 1.05, 240],
      ["fern", 246, 1.19, 0.75, 73],
      ["fern", 300, 1.16, 1.0, 112],
      ["fern", 310, 1.2, 0.75, 267],
      ["fern", 337, 1.15, 0.85, 38],
      ["fern", 348, 1.12, 0.7, 195],
      ["bush", 228, 1.35, 0.9, 27],
      ["bush", 305, 1.35, 0.85, 211],
      ["bush", 343, 1.32, 0.72, 130],
      ["reed", 209, 0.95, 0.9, 27],
      ["reed", 217, 0.94, 0.73, 121],
      ["reed", 225, 0.99, 1.08, 232],
      ["reed", 234, 0.94, 0.82, 67],
      ["reed", 243, 0.97, 0.92, 178],
      ["reed", 294, 0.95, 0.88, 300],
      ["reed", 303, 0.97, 1.04, 57],
      ["reed", 313, 0.94, 0.78, 213],
      ["reed", 332, 0.95, 0.72, 147],
      ["reed", 341, 0.97, 0.96, 19],
      ["reed", 350, 0.96, 0.75, 271],
    ];
  return Object.freeze(
    layout.map(([model, angle, radial, scale, rotation], i) => {
      const radians = (angle * Math.PI) / 180;
      const x = pond.centerX + Math.cos(radians) * pond.radius * radial;
      const z = pond.centerZ + Math.sin(radians) * pond.radius * radial;
      const radius = COMPACT_POND_MODELS[model].radius * scale;
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
