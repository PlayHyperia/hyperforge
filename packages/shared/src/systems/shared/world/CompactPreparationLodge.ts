import type {
  BuildingGenerator,
  BuildingLayout,
  BuildingRecipe,
} from "@hyperforge/procgen/building";
import { canonicalWorldJson } from "../../../data/WorldContentIdentity";
import { getDuelArenaSolidSurfaceHeight } from "../../../data/arena-grading";
import {
  LOBBY_CENTER_X,
  LOBBY_CENTER_Z,
  LOBBY_WIDTH,
  LOBBY_LENGTH,
} from "../../../data/arena-layout";
import type { CompactPreparationLodgeManifest } from "../../../types/world/world-types";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";

export type { CompactPreparationLodgeManifest } from "../../../types/world/world-types";

export const COMPACT_PREPARATION_LODGE_BUILDING_ID =
  "compact-preparation-lodge-v1";

/** Immutable first placement; the legacy coordinate text in the seed is intentional.
 * report04 retained report01's exact recipe and RNG seed when moving to this site.
 */
export const COMPACT_PREPARATION_LODGE: CompactPreparationLodgeManifest =
  Object.freeze({
    schemaVersion: 1,
    layoutId: COMPACT_PREPARATION_LODGE_BUILDING_ID,
    terrainProfileId: "compact-duel-island-v4",
    position: Object.freeze({ x: 398, z: 370 }),
    rotation: 0,
    layoutSeed: "compact-bank-lodge01:360,318:8x8:south",
    recipeId: "compact-bank-lodge01-v1",
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

/** Pure admission: no procgen runtime import, scene, renderer or generated mesh. */
export function validateCompactPreparationLodge(
  value: unknown,
  profile: WorldTerrainProfile,
): CompactPreparationLodgeManifest | undefined {
  if (value === undefined) return undefined;
  if (
    profile.id !== "compact-duel-island-v4" ||
    profile.algorithm !== "compact-island-sculpt-v3" ||
    profile.terrainTileSize !== 100
  )
    fail("profile");
  // The existing descriptor-aware JSON validator rejects getters, cycles,
  // non-finite numbers and oversized input before inspecting caller values.
  const canonical = canonicalWorldJson(value);
  if (
    canonical.length > 1024 ||
    canonical !== canonicalWorldJson(COMPACT_PREPARATION_LODGE)
  )
    fail("unsupported descriptor, pose or recipe");
  const copy = JSON.parse(canonical) as CompactPreparationLodgeManifest;
  const { x, z } = copy.position;
  // Include roof overhang and the complete six-step envelope, not just 8x8 walls.
  if (
    x - 4.45 < LOBBY_CENTER_X - LOBBY_WIDTH / 2 ||
    x + 4.45 > LOBBY_CENTER_X + LOBBY_WIDTH / 2 ||
    z - 4.45 < LOBBY_CENTER_Z - LOBBY_LENGTH / 2 ||
    z + 6.55 > LOBBY_CENTER_Z + LOBBY_LENGTH / 2 ||
    x - 4.45 < profile.bounds.minX ||
    x + 4.45 > profile.bounds.maxX ||
    z - 4.45 < profile.bounds.minZ ||
    z + 6.55 > profile.bounds.maxZ
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
): CompactPreparationLodgePlacement {
  const { x, z } = descriptor.position;
  const y = getDuelArenaSolidSurfaceHeight(x, z);
  if (y === null || !Number.isFinite(y))
    fail("solid lobby platform is unavailable");
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
