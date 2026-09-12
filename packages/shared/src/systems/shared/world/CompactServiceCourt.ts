import { canonicalWorldJson } from "../../../data/WorldContentIdentity";
import type {
  CompactServiceCourtManifest,
  CompactServicePlantingManifest,
} from "../../../types/world/world-types";
import {
  COMPACT_POND_MODELS,
  type CompactPondPlacement,
} from "./CompactPondDressing";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";
import type { WorkshopFoot } from "@hyperforge/procgen/building";

export const COMPACT_SERVICE_COURT: CompactServiceCourtManifest = Object.freeze(
  {
    schemaVersion: 1,
    layoutId: "compact-service-court-v1",
    terrainProfileId: "compact-duel-island-v6",
    position: Object.freeze({ x: 336.5, z: 337.5 }),
    rotation: 0,
    recipeId: "open-timber-smithy-v1",
  },
);

/** No runtime procgen dependency on the content-admission path. */
export function validateCompactServiceCourt(
  value: unknown,
  profile: WorldTerrainProfile,
): CompactServiceCourtManifest | undefined {
  if (value === undefined) return undefined;
  if (
    profile.id !== "compact-duel-island-v6" ||
    profile.algorithm !== "compact-island-sculpt-v5" ||
    profile.terrainTileSize !== 100 ||
    canonicalWorldJson(value) !== canonicalWorldJson(COMPACT_SERVICE_COURT)
  )
    throw new Error("Invalid compactServiceCourt profile, placement or recipe");
  const copy = JSON.parse(
    canonicalWorldJson(value),
  ) as CompactServiceCourtManifest;
  Object.freeze(copy.position);
  return Object.freeze(copy);
}

/** Separate content admission; does not broaden the 64-instance renderer cap.
 * Authored coordinates live in the world manifest and its content identity.
 */
export function validateCompactServicePlanting(
  value: unknown,
  profile: WorldTerrainProfile,
  court: CompactServiceCourtManifest | undefined,
): CompactServicePlantingManifest | undefined {
  if (value === undefined) return undefined;
  // Reject accessors/non-JSON values before reading any submitted property.
  const copy = JSON.parse(
    canonicalWorldJson(value),
  ) as CompactServicePlantingManifest;
  const exactKeys = (row: object, keys: readonly string[]) =>
    Object.keys(row).sort().join(",") === [...keys].sort().join(",");
  if (
    !copy ||
    typeof copy !== "object" ||
    !exactKeys(copy, [
      "schemaVersion",
      "layoutId",
      "terrainProfileId",
      "beds",
    ]) ||
    copy.schemaVersion !== 1 ||
    copy.layoutId !== "compact-smithy-planting-v1" ||
    copy.terrainProfileId !== "compact-duel-island-v6" ||
    !court ||
    profile.id !== court.terrainProfileId ||
    profile.algorithm !== "compact-island-sculpt-v5" ||
    profile.terrainTileSize !== 100 ||
    !Array.isArray(copy.beds) ||
    copy.beds.length !== 2
  )
    throw new Error("Invalid compactServicePlanting profile or layout");
  const ids = new Set<string>();
  let count = 0;
  for (const bed of copy.beds) {
    if (
      !bed ||
      typeof bed !== "object" ||
      !exactKeys(bed, ["id", "plants"]) ||
      !["west", "east"].includes(bed.id) ||
      ids.has(bed.id) ||
      !Array.isArray(bed.plants) ||
      !bed.plants.length ||
      bed.plants.length > 16
    )
      throw new Error("Invalid compactServicePlanting bed");
    ids.add(bed.id);
    const minX = bed.id === "west" ? 327.5 : 342.2;
    const maxX = bed.id === "west" ? 331 : 345.5;
    for (const plant of bed.plants) {
      if (
        !plant ||
        typeof plant !== "object" ||
        !exactKeys(plant, ["x", "z", "scale", "yaw"]) ||
        ![plant.x, plant.z, plant.scale, plant.yaw].every(Number.isFinite) ||
        plant.scale < 0.65 ||
        plant.scale > 1 ||
        plant.yaw < 0 ||
        plant.yaw >= Math.PI * 2
      )
        throw new Error("Invalid compactServicePlanting plant");
      const radius = COMPACT_POND_MODELS.bush.radius * plant.scale;
      if (
        plant.x - radius < minX ||
        plant.x + radius > maxX ||
        plant.z - radius < 334 ||
        plant.z + radius > 343.2
      )
        throw new Error("Compact service plant crown exceeds its admitted bed");
      Object.freeze(plant);
      count++;
    }
    Object.freeze(bed.plants);
    Object.freeze(bed);
  }
  if (count > 24) throw new Error("Compact service planting exceeds 24 plants");
  Object.freeze(copy.beds);
  return Object.freeze(copy);
}

/** Reuse the pond's genuine bush geometry, palette and instance batch. */
export function createCompactServicePlanting(
  descriptor: CompactServicePlantingManifest | undefined,
): readonly CompactPondPlacement[] {
  return Object.freeze(
    descriptor?.beds.flatMap((bed) =>
      bed.plants.map((p, i) =>
        Object.freeze({
          ...p,
          id: `smithy_${bed.id}_${i}`,
          model: "bush" as const,
          burial: 0.04,
        }),
      ),
    ) ?? [],
  );
}

export type OwnedCompactServiceCourt = Readonly<{
  descriptor: CompactServiceCourtManifest;
  position: Readonly<{ x: number; y: number; z: number }>;
  feet: readonly WorkshopFoot[];
  blockingTiles: readonly Readonly<{ x: number; z: number }>[];
}>;

/** Once-per-startup ground support, sampled across every actual post footing.
 * The 0.08m embed allowance is explicit; steep/unsupported placements fail closed.
 */
export function groundCompactServiceCourt(
  descriptor: CompactServiceCourtManifest,
  posts: readonly Readonly<{ x: number; z: number }>[],
  heightAt: (x: number, z: number) => number,
): OwnedCompactServiceCourt {
  const { x, z } = descriptor.position,
    y = heightAt(x, z);
  if (!Number.isFinite(y) || posts.length !== 4)
    throw new Error("Compact service court ground datum is unavailable");
  const blockingTiles: { x: number; z: number }[] = [];
  const feet = posts.map((post) => {
    const px = x + post.x,
      pz = z + post.z;
    const samples: number[] = [];
    for (const dx of [-0.15, 0, 0.15])
      for (const dz of [-0.15, 0, 0.15])
        samples.push(heightAt(px + dx, pz + dz));
    const min = Math.min(...samples),
      max = Math.max(...samples);
    if (
      !samples.every(Number.isFinite) ||
      max - min > 0.3 ||
      Math.abs(min - y) > 0.6 ||
      Math.abs(max - y) > 0.6
    )
      throw new Error(
        "Compact service court footing lacks bounded terrain support",
      );
    // Tile centers are 0.5m from boundaries; the 0.15m post plus a 0.3m
    // character capsule remains inside its cell. Do not block the open roof area.
    if (px % 1 !== 0.5 || pz % 1 !== 0.5)
      throw new Error(
        "Compact service court posts must retain capsule-safe cell centers",
      );
    blockingTiles.push(Object.freeze({ x: Math.floor(px), z: Math.floor(pz) }));
    return Object.freeze({ bottom: min - y - 0.08, top: max - y + 0.22 });
  });
  if (new Set(blockingTiles.map((t) => `${t.x},${t.z}`)).size !== 4)
    throw new Error("Compact service court post footprints overlap");
  return Object.freeze({
    descriptor,
    position: Object.freeze({ x, y, z }),
    feet: Object.freeze(feet),
    blockingTiles: Object.freeze(blockingTiles),
  });
}
