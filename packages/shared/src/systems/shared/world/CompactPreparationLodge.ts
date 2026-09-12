import type {
  BuildingGenerator,
  BuildingLayout,
  BuildingRecipe,
} from "@hyperforge/procgen/building";
import { canonicalWorldJson } from "../../../data/WorldContentIdentity";
import {
  DUEL_ARENA_FLOOR_SOLID_OFFSET,
  getDuelArenaGradeHeight,
} from "../../../data/arena-grading";
import { ALL_WORLD_AREAS, type WorldArea } from "../../../data/world-areas";
import type { CompactPreparationLodgeManifest } from "../../../types/world/world-types";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";

export type { CompactPreparationLodgeManifest } from "../../../types/world/world-types";

export const COMPACT_PREPARATION_LODGE_BUILDING_ID =
  "compact-preparation-lodge-v1";

/** The same seeded architecture now faces the real bank forecourt.
 * Pose is part of the full world-content identity; layout/recipe identity is unchanged.
 */
export const COMPACT_PREPARATION_LODGE: CompactPreparationLodgeManifest =
  Object.freeze({
    schemaVersion: 1,
    layoutId: COMPACT_PREPARATION_LODGE_BUILDING_ID,
    terrainProfileId: "compact-duel-island-v6",
    position: Object.freeze({ x: 350, z: 328 }),
    rotation: Math.PI,
    layoutSeed: "compact-bank-lodge01:360,318:8x8:south",
    recipeId: "compact-bank-lodge01-v1",
  });

/** Exact previous placement identity, supported only with its historical profile. */
export const COMPACT_PREPARATION_LODGE_V4_FIXTURE: CompactPreparationLodgeManifest =
  Object.freeze({
    ...COMPACT_PREPARATION_LODGE,
    terrainProfileId: "compact-duel-island-v4",
    position: Object.freeze({ x: 398, z: 370 }),
    rotation: 0,
  });

export const COMPACT_PREPARATION_LODGE_V5_FIXTURE: CompactPreparationLodgeManifest =
  Object.freeze({
    ...COMPACT_PREPARATION_LODGE_V4_FIXTURE,
    terrainProfileId: "compact-duel-island-v5",
  });

// Exact report01.proposedLayoutRecipe used by report04. Do not inherit mutable
// bank defaults: changing this contract requires another qualified recipeId.
const RECIPE: BuildingRecipe = {
  label: "Bank",
  widthRange: [2, 2],
  depthRange: [2, 2],
  floors: 1,
  floorsRange: [1, 1],
  entranceCount: 1,
  archBias: 0.8,
  extraConnectionChance: 0.4,
  entranceArchChance: 0,
  roomSpanRange: [2, 2],
  minRoomArea: 4,
  minUpperFloorCells: 3,
  minUpperFloorShrinkCells: 2,
  windowChance: 0.35,
  patioDoorChance: 0,
  patioDoorCountRange: [1, 1],
  footprintStyle: "default",
  foyerDepthRange: [1, 2],
  foyerWidthRange: [1, 2],
  excludeFoyerFromUpper: true,
  upperInsetRange: [1, 2],
  upperCarveChance: 0.1,
  frontSide: "south",
  wallMaterial: "stone",
  foundationStepsRange: [2, 2],
  hasBasement: false,
  basementChance: 0.8,
  basementLevels: 1,
  basementCoverage: 0.7,
  carveChance: 0,
};
for (const value of Object.values(RECIPE))
  if (Array.isArray(value)) Object.freeze(value);
Object.freeze(RECIPE);

function fail(field: string): never {
  throw new Error(`Invalid compactPreparationLodge: ${field}`);
}

/** Conservative rotated envelope of the roof and all six foundation steps.
 * Support qualification uses this whole envelope, not only the wall footprint.
 */
export function getCompactPreparationLodgeFootprint(
  descriptor: CompactPreparationLodgeManifest,
  includeSteps = true,
): Readonly<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
  const c = Math.cos(descriptor.rotation),
    s = Math.sin(descriptor.rotation);
  // Gable trim reaches 4.4977m laterally; retain outward float32 padding.
  const corners = [-4.5, 4.5].flatMap((x) =>
    [-4.5, includeSteps ? 6.56 : 4.5].map((z) => ({
      x: descriptor.position.x + x * c + z * s,
      z: descriptor.position.z - x * s + z * c,
    })),
  );
  return Object.freeze({
    minX: Math.min(...corners.map((p) => p.x)),
    maxX: Math.max(...corners.map((p) => p.x)),
    minZ: Math.min(...corners.map((p) => p.z)),
    maxZ: Math.max(...corners.map((p) => p.z)),
  });
}

/** Pure admission: no procgen runtime import, scene, renderer or generated mesh. */
export function validateCompactPreparationLodge(
  value: unknown,
  profile: WorldTerrainProfile,
): CompactPreparationLodgeManifest | undefined {
  if (value === undefined) return undefined;
  if (
    !(
      (profile.id === "compact-duel-island-v4" &&
        profile.algorithm === "compact-island-sculpt-v3") ||
      (profile.id === "compact-duel-island-v5" &&
        profile.algorithm === "compact-island-sculpt-v4") ||
      (profile.id === "compact-duel-island-v6" &&
        profile.algorithm === "compact-island-sculpt-v5")
    ) ||
    profile.terrainTileSize !== 100
  )
    fail("profile");
  // The existing descriptor-aware JSON validator rejects getters, cycles,
  // non-finite numbers and oversized input before inspecting caller values.
  const canonical = canonicalWorldJson(value);
  if (
    canonical.length > 1024 ||
    canonical !==
      canonicalWorldJson(
        profile.id === "compact-duel-island-v4"
          ? COMPACT_PREPARATION_LODGE_V4_FIXTURE
          : profile.id === "compact-duel-island-v5"
            ? COMPACT_PREPARATION_LODGE_V5_FIXTURE
            : COMPACT_PREPARATION_LODGE,
      )
  )
    fail("unsupported descriptor, pose or recipe");
  const copy = JSON.parse(canonical) as CompactPreparationLodgeManifest;
  const bounds = getCompactPreparationLodgeFootprint(copy);
  if (
    bounds.minX < profile.bounds.minX ||
    bounds.maxX > profile.bounds.maxX ||
    bounds.minZ < profile.bounds.minZ ||
    bounds.maxZ > profile.bounds.maxZ
  )
    fail("footprint containment");
  Object.freeze(copy.position);
  return Object.freeze(copy);
}

export type CompactPreparationLodgePlacement = Readonly<{
  x: number;
  y: number;
  z: number;
  rotation: number;
}>;

/** Called at startup after world areas are loaded; never substitute raw terrain. */
export function getCompactPreparationLodgePlacement(
  descriptor: CompactPreparationLodgeManifest,
  areas: Readonly<Record<string, WorldArea>> = ALL_WORLD_AREAS,
): CompactPreparationLodgePlacement {
  const { x, z } = descriptor.position;
  // Historical compact-profile fixtures retain their original platform datum.
  // The active lodge is grounded at the services, never on an invented platform.
  if (descriptor.terrainProfileId !== "compact-duel-island-v6")
    return Object.freeze({
      x,
      z,
      rotation: descriptor.rotation,
      y: getDuelArenaGradeHeight(areas) + DUEL_ARENA_FLOOR_SOLID_OFFSET,
    });
  const grades = areas.central_haven?.flatZones?.filter(
    (zone) => zone.id === "central_haven_plaza",
  );
  if (grades?.length !== 1) fail("bank plaza support is unavailable");
  const grade = grades[0];
  const bounds = getCompactPreparationLodgeFootprint(descriptor);
  if (
    ![
      grade.height,
      grade.centerX,
      grade.centerZ,
      grade.width,
      grade.depth,
    ].every((value) => typeof value === "number" && Number.isFinite(value)) ||
    grade.width <= 0 ||
    grade.depth <= 0 ||
    grade.heightOffset !== undefined ||
    grade.radialPond !== undefined ||
    bounds.minX < grade.centerX - grade.width / 2 ||
    bounds.maxX > grade.centerX + grade.width / 2 ||
    bounds.minZ < grade.centerZ - grade.depth / 2 ||
    bounds.maxZ > grade.centerZ + grade.depth / 2
  )
    fail("bank plaza must support the complete lodge footprint");
  const y = grade.height!;
  return Object.freeze({ x, y, z, rotation: descriptor.rotation });
}

/** The only layout RNG call; dynamic import keeps DataManager admission CPU-only. */
export async function createCompactPreparationLodgeLayout(
  descriptor: CompactPreparationLodgeManifest,
  generator: BuildingGenerator,
): Promise<BuildingLayout> {
  const { createRng } = await import("@hyperforge/procgen/building");
  return generator.generateLayout(
    structuredClone(RECIPE),
    createRng(descriptor.layoutSeed),
  );
}

/** Published only after its exact collision registration succeeds. */
export type OwnedCompactPreparationLodge = Readonly<{
  buildingId: typeof COMPACT_PREPARATION_LODGE_BUILDING_ID;
  descriptor: CompactPreparationLodgeManifest;
  layout: BuildingLayout;
  position: Readonly<{ x: number; y: number; z: number }>;
  rotation: number;
}>;
