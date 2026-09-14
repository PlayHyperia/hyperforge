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
import type { CompactTerrainPlantingLobe } from "./CompactTerrainPalette";
import type { WorkshopFoot } from "@hyperforge/procgen/building";
import type { GrassTerrainExclusionPolygon } from "../../../utils/workers/GrassTerrainSurfaceSnapshot";

// Existing support stencil for the procgen recipe's 0.30m footing. Procgen does
// not export this dimension; actual footing-vertex tests guard their alignment.
const FOOTING_HALF_EXTENT = 0.15;

export const COMPACT_SERVICE_COURT: CompactServiceCourtManifest = Object.freeze(
  {
    schemaVersion: 1,
    layoutId: "compact-service-court-v1",
    terrainProfileId: "compact-duel-island-v6",
    position: Object.freeze({ x: 336.5, z: 337.5 }),
    rotation: 0,
    recipeId: "open-timber-smithy-haven-v3",
  },
);

/** Exact pre-finish identity retained for comparison captures. */
export const COMPACT_SERVICE_COURT_LEGACY_FIXTURE: CompactServiceCourtManifest =
  Object.freeze({
    ...COMPACT_SERVICE_COURT,
    recipeId: "open-timber-smithy-v2",
  });

/** No runtime procgen dependency on the content-admission path. */
export function validateCompactServiceCourt(
  value: unknown,
  profile: WorldTerrainProfile,
): CompactServiceCourtManifest | undefined {
  if (value === undefined) return undefined;
  const canonical = canonicalWorldJson(value);
  if (
    profile.id !== "compact-duel-island-v6" ||
    profile.algorithm !== "compact-island-sculpt-v5" ||
    profile.terrainTileSize !== 100 ||
    ![COMPACT_SERVICE_COURT, COMPACT_SERVICE_COURT_LEGACY_FIXTURE].some(
      (descriptor) => canonical === canonicalWorldJson(descriptor),
    )
  )
    throw new Error("Invalid compactServiceCourt profile, placement or recipe");
  const copy = JSON.parse(canonical) as CompactServiceCourtManifest;
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
    !(
      (copy.schemaVersion === 1 &&
        copy.layoutId === "compact-smithy-planting-v1") ||
      (copy.schemaVersion === 2 &&
        copy.layoutId === "compact-smithy-planting-v2")
    ) ||
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
      !exactKeys(
        bed,
        copy.schemaVersion === 2
          ? ["id", "plants", "soilLobes"]
          : ["id", "plants"],
      ) ||
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
    if (copy.schemaVersion === 2) {
      if (!Array.isArray(bed.soilLobes) || bed.soilLobes.length !== 2)
        throw new Error(
          "Compact service planting requires two soil lobes per bed",
        );
      for (const lobe of bed.soilLobes) {
        if (
          !lobe ||
          typeof lobe !== "object" ||
          !exactKeys(lobe, ["centerX", "centerZ", "radiusX", "radiusZ"]) ||
          ![lobe.centerX, lobe.centerZ, lobe.radiusX, lobe.radiusZ].every(
            Number.isFinite,
          ) ||
          lobe.radiusX < 0.75 ||
          lobe.radiusX > 3 ||
          lobe.radiusZ < 0.75 ||
          lobe.radiusZ > 3 ||
          lobe.centerX - lobe.radiusX < minX ||
          lobe.centerX + lobe.radiusX > maxX ||
          lobe.centerZ - lobe.radiusZ < 334 ||
          lobe.centerZ + lobe.radiusZ > 343.2
        )
          throw new Error("Compact service soil exceeds its admitted bed");
        Object.freeze(lobe);
      }
      Object.freeze(bed.soilLobes);
    }
    for (const plant of bed.plants) {
      if (
        !plant ||
        typeof plant !== "object" ||
        !exactKeys(
          plant,
          copy.schemaVersion === 2
            ? ["model", "x", "z", "scale", "yaw"]
            : ["x", "z", "scale", "yaw"],
        ) ||
        (copy.schemaVersion === 2 &&
          plant.model !== "bush" &&
          plant.model !== "fern") ||
        ![plant.x, plant.z, plant.scale, plant.yaw].every(Number.isFinite) ||
        plant.scale < (plant.model === "fern" ? 0.5 : 0.65) ||
        plant.scale > 1 ||
        plant.yaw < 0 ||
        plant.yaw >= Math.PI * 2
      )
        throw new Error("Invalid compactServicePlanting plant");
      const model = plant.model === "fern" ? "fern" : "bush";
      const radius = COMPACT_POND_MODELS[model].radius * plant.scale;
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

/** Reuse the pond's genuine foliage geometry, palette and instance batches. */
export function createCompactServicePlanting(
  descriptor: CompactServicePlantingManifest | undefined,
): readonly CompactPondPlacement[] {
  return Object.freeze(
    descriptor?.beds.flatMap((bed) =>
      bed.plants.map((p, i) =>
        Object.freeze({
          ...p,
          id: `smithy_${bed.id}_${i}`,
          model: p.model ?? ("bush" as const),
          burial: 0.04,
        }),
      ),
    ) ?? [],
  );
}

/** Flatten already admitted content once per terrain lifetime, not per blade. */
export function createCompactServiceSoil(
  descriptor: CompactServicePlantingManifest | undefined,
): readonly CompactTerrainPlantingLobe[] {
  return Object.freeze(
    descriptor?.beds.flatMap((bed) => bed.soilLobes ?? []) ?? [],
  );
}

export type OwnedCompactServiceCourt = Readonly<{
  descriptor: CompactServiceCourtManifest;
  position: Readonly<{ x: number; y: number; z: number }>;
  feet: readonly WorkshopFoot[];
  blockingTiles: readonly Readonly<{ x: number; z: number }>[];
}>;

/** Grass-only footprints, never a roof/floor pad or a terrain-height edit.
 * Use the same procgen post locations and support extent as ground sampling.
 * The terrain owner admits and detaches these private, newly allocated records.
 */
export function createCompactServiceCourtGrassExclusions(
  record: OwnedCompactServiceCourt,
  posts: readonly Readonly<{ x: number; z: number }>[],
): GrassTerrainExclusionPolygon[] {
  if (
    record.descriptor.rotation !== 0 ||
    posts.length !== 4 ||
    record.feet.length !== 4 ||
    record.blockingTiles.length !== 4
  )
    throw new Error("Compact service court grass requires four admitted feet");
  return posts.map((post, index) => {
    const x = record.position.x + post.x,
      z = record.position.z + post.z;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      x !== record.blockingTiles[index].x + 0.5 ||
      z !== record.blockingTiles[index].z + 0.5
    )
      throw new Error("Compact service court grass footing owner mismatch");
    const minX = x - FOOTING_HALF_EXTENT,
      maxX = x + FOOTING_HALF_EXTENT,
      minZ = z - FOOTING_HALF_EXTENT,
      maxZ = z + FOOTING_HALF_EXTENT;
    return {
      id: `${record.descriptor.layoutId}-footing-${index}`,
      minX,
      maxX,
      minZ,
      maxZ,
      vertices: [
        { x: minX, z: minZ },
        { x: maxX, z: minZ },
        { x: maxX, z: maxZ },
        { x: minX, z: maxZ },
      ],
    };
  });
}

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
    for (const dx of [-FOOTING_HALF_EXTENT, 0, FOOTING_HALF_EXTENT])
      for (const dz of [-FOOTING_HALF_EXTENT, 0, FOOTING_HALF_EXTENT])
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
