import { canonicalWorldJson } from "../../../data/WorldContentIdentity";
import type {
  CompactBankPavilionManifest,
  CompactServiceCourtManifest,
  CompactServiceCourtPlacement,
  CompactServiceCourtsManifest,
  CompactServicePlantingManifest,
  WorldArea,
  WorldConfigManifest,
} from "../../../types/world/world-types";
import {
  COMPACT_POND_MODELS,
  type CompactPondPlacement,
} from "./CompactPondDressing";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";
import {
  createCompactTerrainColorOperations,
  type CompactTerrainBankVerge,
  type CompactTerrainPlantingLobe,
} from "./CompactTerrainPalette";
import pondServiceGroundRecipe from "../../../data/compact-pond-service-ground-v1.json";
import {
  getCompactPondDockDirection,
  validateCompactPondDockBindings,
  validateCompactPondDocks,
} from "./DockDefinition";
import type {
  OpenWorkshopRecipe,
  WorkshopFoot,
} from "@hyperforge/procgen/building";
import type { GrassTerrainExclusionPolygon } from "../../../utils/workers/GrassTerrainSurfaceSnapshot";

// Existing support stencil for the procgen recipe's 0.30m footing. Procgen does
// not export this dimension; actual footing-vertex tests guard their alignment.
const FOOTING_HALF_EXTENT = 0.15;

/** Appearance-only service apron from actual, mutually bound owners. Never a
 * road, exclusion polygon, terrain grade, collision tile or resource rule. */
export function createCompactPondServiceGround(
  profile: WorldTerrainProfile,
  config:
    | Pick<WorldConfigManifest, "compactServiceCourts" | "compactPondDocks">
    | null
    | undefined,
  areas: Readonly<Record<string, WorldArea>>,
): CompactTerrainBankVerge | null {
  const recipe = pondServiceGroundRecipe;
  const layout = config?.compactServiceCourts;
  if (!layout) return null;
  const admitted = validateCompactServiceCourts(layout, profile)!;
  const courts = admitted.courts.filter(
    (court) => court.recipeId === recipe.courtRecipeId,
  );
  if (courts.length === 0) return null;
  validateCompactServiceCourtBindings(admitted, areas);
  const docks = validateCompactPondDocks(config?.compactPondDocks, profile);
  const water = validateCompactPondDockBindings(docks, areas);
  if (
    recipe.schemaVersion !== 1 ||
    recipe.terrainProfileId !== profile.id ||
    courts.length !== 1 ||
    courts[0].layoutId === admitted.primaryBankId ||
    !docks ||
    !water ||
    recipe.lobes.length !== 3
  )
    throw new Error("Pond service ground requires its bound court and landing");
  const court = courts[0];
  const pondArea = areas.haven_pond;
  const chests =
    pondArea?.stations?.filter((row) => court.stationIds.includes(row.id)) ??
    [];
  const clerks =
    pondArea?.npcs?.filter((row) => court.npcIds.includes(row.id)) ?? [];
  const landings = docks.docks.filter(
    (dock) => dock.recipeId === recipe.landingRecipeId,
  );
  if (
    chests.length !== 1 ||
    chests[0].type !== "bank" ||
    clerks.length !== 1 ||
    clerks[0].type !== "bank" ||
    court.npcIds.length !== 1 ||
    landings.length !== 1 ||
    !pondArea.waterBodies?.some((body) => body.id === water.id)
  )
    throw new Error(
      "Pond service ground has missing or ambiguous local anchors",
    );
  const center = court.position,
    chest = chests[0].position;
  const landing = landings[0],
    direction = getCompactPondDockDirection(landing.rotation);
  // Match the existing landward apron; its station route remains unmodified.
  const arrival = {
    x: landing.x - direction.x * recipe.landwardApronDistance,
    z: landing.z - direction.z * recipe.landwardApronDistance,
  };
  const distance = Math.hypot(arrival.x - center.x, arrival.z - center.z);
  if (
    !Number.isFinite(distance) ||
    distance < 6 ||
    !Number.isFinite(recipe.entryDistance) ||
    recipe.entryDistance <= 0 ||
    !Number.isFinite(recipe.landwardApronDistance) ||
    recipe.landwardApronDistance <= 0 ||
    recipe.entryDistance >= distance
  )
    throw new Error("Pond service ground requires a separate landward arrival");
  const anchors: Readonly<Record<string, Readonly<{ x: number; z: number }>>> =
    {
      center,
      standing: {
        x: Math.floor(chest.x) + Math.sign(center.x - chest.x) + 0.5,
        z: Math.floor(chest.z) + Math.sign(center.z - chest.z) + 0.5,
      },
      clerk: clerks[0].position,
      entry: {
        x:
          center.x + ((arrival.x - center.x) / distance) * recipe.entryDistance,
        z:
          center.z + ((arrival.z - center.z) / distance) * recipe.entryDistance,
      },
    };
  const wear = recipe.lobes.map((lobe) => {
    const start = anchors[lobe.from],
      end = anchors[lobe.to];
    if (!start || !end)
      throw new Error("Unknown pond service ground anchor role");
    return {
      startX: start.x,
      startZ: start.z,
      endX: end.x,
      endZ: end.z,
      coreRadius: lobe.coreRadius,
      outerRadius: lobe.outerRadius,
      strength: lobe.strength,
    };
  });
  const candidate = {
    minX:
      Math.min(...wear.map((r) => Math.min(r.startX, r.endX) - r.outerRadius)) -
      recipe.feather,
    maxX:
      Math.max(...wear.map((r) => Math.max(r.startX, r.endX) + r.outerRadius)) +
      recipe.feather,
    minZ:
      Math.min(...wear.map((r) => Math.min(r.startZ, r.endZ) - r.outerRadius)) -
      recipe.feather,
    maxZ:
      Math.max(...wear.map((r) => Math.max(r.startZ, r.endZ) + r.outerRadius)) +
      recipe.feather,
    feather: recipe.feather,
    wearStart: 0.1,
    wearEnd: 0.8,
    minimumScale: 1,
    heightScale: 1,
    wornHeightScale: recipe.wornHeightScale,
    tipBrightness: 1,
    grassTint: [1, 1, 1],
    wear,
  };
  if (
    candidate.minX < profile.bounds.minX ||
    candidate.maxX > profile.bounds.maxX ||
    candidate.minZ < profile.bounds.minZ ||
    candidate.maxZ > profile.bounds.maxZ
  )
    throw new Error("Pond service ground exceeds its admitted terrain");
  const colors = createCompactTerrainColorOperations();
  const primary = colors.macroField(profile)?.bankVerge;
  if (
    primary &&
    candidate.minX < primary.maxX &&
    candidate.maxX > primary.minX &&
    candidate.minZ < primary.maxZ &&
    candidate.maxZ > primary.minZ
  )
    throw new Error("Pond service ground overlaps the primary bank treatment");
  return colors.captureGroundVerge(
    { pondServiceGround: candidate },
    "pondServiceGround",
  )!;
}

export const MAX_COMPACT_SERVICE_COURTS = 8;
export type CompactCourtDescriptor =
  | CompactServiceCourtManifest
  | CompactBankPavilionManifest
  | CompactServiceCourtPlacement;

export function isCompactBankCourt(
  descriptor: CompactCourtDescriptor,
): boolean {
  return (
    descriptor.recipeId === "open-timber-bank-haven-v2" ||
    descriptor.recipeId === "open-timber-pond-bank-haven-v1"
  );
}

/** Shared by physical and visual owners; no independent recipe interpretation. */
export function getCompactServiceCourtRecipe(
  descriptor: CompactCourtDescriptor,
): OpenWorkshopRecipe {
  if (descriptor.recipeId === "open-timber-pond-bank-haven-v1")
    return "pond-bank-pavilion-v1";
  return isCompactBankCourt(descriptor) ? "bank-pavilion-v1" : "smithy-v1";
}

/** Conservative roof/trim half-extents, guarded against actual recipe vertices. */
export function getCompactServiceCourtHalfExtents(
  descriptor: CompactCourtDescriptor,
) {
  return isCompactBankCourt(descriptor) ? { x: 5, z: 5 } : { x: 6, z: 4 };
}

/** One source for owner/visual/readiness enumeration; no implicit first-bank lookup. */
export function getCompactServiceCourtDescriptors(
  config:
    | Pick<
        WorldConfigManifest,
        "compactServiceCourt" | "compactBankPavilion" | "compactServiceCourts"
      >
    | null
    | undefined,
): readonly CompactCourtDescriptor[] {
  if (config?.compactServiceCourts) return config.compactServiceCourts.courts;
  return Object.freeze(
    [config?.compactServiceCourt, config?.compactBankPavilion].filter(
      (row): row is CompactServiceCourtManifest | CompactBankPavilionManifest =>
        row !== undefined,
    ),
  );
}

/** JSON-only bounded placement admission; station/NPC bindings are checked at startup. */
export function validateCompactServiceCourts(
  value: unknown,
  profile: WorldTerrainProfile,
): CompactServiceCourtsManifest | undefined {
  if (value === undefined) return undefined;
  const copy = JSON.parse(
    canonicalWorldJson(value),
  ) as CompactServiceCourtsManifest;
  const exact = (row: object, keys: readonly string[]) =>
    Object.keys(row).sort().join(",") === [...keys].sort().join(",");
  const id = (v: unknown): v is string =>
    typeof v === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(v);
  if (
    !copy ||
    typeof copy !== "object" ||
    Array.isArray(copy) ||
    !exact(copy, [
      "schemaVersion",
      "layoutId",
      "terrainProfileId",
      "primaryBankId",
      "courts",
    ]) ||
    copy.schemaVersion !== 1 ||
    copy.layoutId !== "compact-service-courts-v1" ||
    copy.terrainProfileId !== "compact-duel-island-v6" ||
    profile.id !== copy.terrainProfileId ||
    profile.algorithm !== "compact-island-sculpt-v5" ||
    profile.terrainTileSize !== 100 ||
    !id(copy.primaryBankId) ||
    !Array.isArray(copy.courts) ||
    copy.courts.length < 2 ||
    copy.courts.length > MAX_COMPACT_SERVICE_COURTS
  )
    throw new Error("Invalid compactServiceCourts profile or layout");
  const ids = new Set<string>(),
    stations = new Set<string>(),
    npcs = new Set<string>();
  for (const court of copy.courts) {
    if (
      !court ||
      typeof court !== "object" ||
      Array.isArray(court) ||
      !exact(court, [
        "schemaVersion",
        "layoutId",
        "terrainProfileId",
        "position",
        "rotation",
        "recipeId",
        "stationIds",
        "npcIds",
      ]) ||
      court.schemaVersion !== 2 ||
      !id(court.layoutId) ||
      ids.has(court.layoutId) ||
      court.terrainProfileId !== profile.id ||
      court.rotation !== 0 ||
      ![
        "open-timber-smithy-haven-v3",
        "open-timber-bank-haven-v2",
        "open-timber-pond-bank-haven-v1",
      ].includes(court.recipeId) ||
      !court.position ||
      typeof court.position !== "object" ||
      Array.isArray(court.position) ||
      !exact(court.position, ["x", "z"]) ||
      !Number.isFinite(court.position.x) ||
      !Number.isFinite(court.position.z)
    )
      throw new Error("Invalid compact service court placement");
    const bank = isCompactBankCourt(court);
    // Both current recipes require axis-aligned, capsule-safe half-cell post
    // centres. Rotation is deliberately explicit and not silently ignored.
    const offset = bank ? 0 : 0.5;
    const envelope = getCompactServiceCourtHalfExtents(court);
    if (
      !Number.isInteger(court.position.x - offset) ||
      !Number.isInteger(court.position.z - offset) ||
      court.position.x - envelope.x < profile.bounds.minX ||
      court.position.x + envelope.x > profile.bounds.maxX ||
      court.position.z - envelope.z < profile.bounds.minZ ||
      court.position.z + envelope.z > profile.bounds.maxZ
    )
      throw new Error("Compact service court exceeds bounds or support grid");
    if (
      !Array.isArray(court.stationIds) ||
      court.stationIds.length !== (bank ? 1 : 2) ||
      !Array.isArray(court.npcIds) ||
      court.npcIds.length > 4
    )
      throw new Error("Invalid compact service court bindings");
    for (const [values, claimed] of [
      [court.stationIds, stations],
      [court.npcIds, npcs],
    ] as const)
      for (const value of values) {
        if (!id(value) || claimed.has(value))
          throw new Error("Duplicate or invalid compact service binding");
        claimed.add(value);
      }
    for (const previous of copy.courts.slice(0, ids.size)) {
      const other = getCompactServiceCourtHalfExtents(previous);
      if (
        Math.abs(previous.position.x - court.position.x) <
          envelope.x + other.x &&
        Math.abs(previous.position.z - court.position.z) < envelope.z + other.z
      )
        throw new Error("Compact service court roof envelopes overlap");
    }
    ids.add(court.layoutId);
    Object.freeze(court.position);
    Object.freeze(court.stationIds);
    Object.freeze(court.npcIds);
    Object.freeze(court);
  }
  const primary = copy.courts.find(
    (court) => court.layoutId === copy.primaryBankId,
  );
  if (!primary || !isCompactBankCourt(primary) || primary.npcIds.length !== 1)
    throw new Error(
      "Compact service courts require an explicit primary bank and clerk",
    );
  Object.freeze(copy.courts);
  return Object.freeze(copy);
}

/** Mandatory cross-manifest check, also used by real owners before allocation. */
export function validateCompactServiceCourtBindings(
  layout: CompactServiceCourtsManifest | undefined,
  areas: Readonly<Record<string, WorldArea>>,
): void {
  if (!layout) return;
  const stations = Object.values(areas).flatMap((area) => area.stations ?? []);
  const npcs = Object.values(areas).flatMap((area) => area.npcs ?? []);
  for (const court of layout.courts) {
    const types: string[] = [];
    const inCourt = (point: { x: number; z: number }) =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.z) &&
      Math.abs(point.x - court.position.x) <= 4 &&
      Math.abs(point.z - court.position.z) <= 4;
    for (const stationId of court.stationIds) {
      const rows = stations.filter((station) => station.id === stationId);
      if (rows.length !== 1 || !inCourt(rows[0].position))
        throw new Error(
          "Compact service court station binding is missing, ambiguous or outside its court",
        );
      types.push(rows[0].type);
    }
    if (
      types.sort().join(",") !==
      (isCompactBankCourt(court) ? "bank" : "anvil,furnace")
    )
      throw new Error(
        "Compact service court station roles do not match its recipe",
      );
    for (const npcId of court.npcIds) {
      const rows = npcs.filter((npc) => npc.id === npcId);
      if (rows.length !== 1 || !inCourt(rows[0].position))
        throw new Error(
          "Compact service court NPC binding is missing, ambiguous or outside its court",
        );
      if (isCompactBankCourt(court) && rows[0].type !== "bank")
        throw new Error("Compact bank court requires a bank-service NPC");
    }
  }
}

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

export const COMPACT_BANK_PAVILION: CompactBankPavilionManifest = Object.freeze(
  {
    schemaVersion: 1,
    layoutId: "compact-bank-pavilion-v1",
    terrainProfileId: "compact-duel-island-v6",
    position: Object.freeze({ x: 350, z: 320 }),
    rotation: 0,
    recipeId: "open-timber-bank-haven-v2",
  },
);

/** CPU-only, exact content admission; no renderer or procgen import is needed. */
export function validateCompactBankPavilion(
  value: unknown,
  profile: WorldTerrainProfile,
): CompactBankPavilionManifest | undefined {
  if (value === undefined) return undefined;
  const canonical = canonicalWorldJson(value);
  if (
    profile.id !== "compact-duel-island-v6" ||
    profile.algorithm !== "compact-island-sculpt-v5" ||
    profile.terrainTileSize !== 100 ||
    canonical !== canonicalWorldJson(COMPACT_BANK_PAVILION)
  )
    throw new Error("Invalid compactBankPavilion profile, placement or recipe");
  const copy = JSON.parse(canonical) as CompactBankPavilionManifest;
  Object.freeze(copy.position);
  return Object.freeze(copy);
}

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
  descriptor: CompactCourtDescriptor;
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
  descriptor: OwnedCompactServiceCourt["descriptor"],
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
