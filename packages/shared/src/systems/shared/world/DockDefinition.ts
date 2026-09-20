/**
 * DockDefinition — data for dock placements.
 *
 * Each dock specifies a position, rotation, and dimensions.
 * Devs assign exact positions — no automatic shoreline detection.
 *
 * `rotation` is degrees (compass bearing) for the direction the dock
 * extends over water: 0° = north (−Z), 90° = east (+X), 180° = south (+Z), 270° = west (−X).
 */

import { canonicalWorldJson } from "../../../data/WorldContentIdentity";
import type {
  CompactPondDockPlacement,
  CompactPondDocksManifest,
  WorldArea,
} from "../../../types/world/world-types";
import {
  validateWorldTerrainProfile,
  type WorldTerrainProfile,
} from "./WorldTerrainProfile";

export const COMPACT_POND_DOCK_DIMENSIONS = Object.freeze({
  width: 3,
  length: 6,
  landingLength: 2,
});

export type CompactPondDockBounds = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;

export type CompactPondDockWaterBody = Readonly<{
  id: string;
  centerX: number;
  centerZ: number;
  radius: number;
  surfaceY: number;
}>;

/** Integer compass vectors avoid trigonometric drift at tile boundaries. */
export function getCompactPondDockDirection(
  rotation: CompactPondDockPlacement["rotation"],
): Readonly<{ x: number; z: number }> {
  switch (rotation) {
    case 0:
      return Object.freeze({ x: 0, z: -1 });
    case 90:
      return Object.freeze({ x: 1, z: 0 });
    case 180:
      return Object.freeze({ x: 0, z: 1 });
    case 270:
      return Object.freeze({ x: -1, z: 0 });
    default:
      throw new Error("Compact pond dock requires a cardinal compass bearing");
  }
}

function dockBounds(
  dock: CompactPondDockPlacement,
  landwardLength: number,
): CompactPondDockBounds {
  const direction = getCompactPondDockDirection(dock.rotation);
  const halfWidth = COMPACT_POND_DOCK_DIMENSIONS.width / 2;
  const endX = dock.x + direction.x * COMPACT_POND_DOCK_DIMENSIONS.length;
  const endZ = dock.z + direction.z * COMPACT_POND_DOCK_DIMENSIONS.length;
  const startX = dock.x - direction.x * landwardLength;
  const startZ = dock.z - direction.z * landwardLength;
  return Object.freeze({
    minX: Math.min(startX, endX) - Math.abs(direction.z) * halfWidth,
    maxX: Math.max(startX, endX) + Math.abs(direction.z) * halfWidth,
    minZ: Math.min(startZ, endZ) - Math.abs(direction.x) * halfWidth,
    maxZ: Math.max(startZ, endZ) + Math.abs(direction.x) * halfWidth,
  });
}

/** Exact 18-tile over-water core, excluding the landward approach. */
export function getCompactPondDockCoreBounds(
  dock: CompactPondDockPlacement,
): CompactPondDockBounds {
  return dockBounds(dock, 0);
}

/** Exact 24-tile reservation: 18 deck tiles and six landward landing tiles. */
export function getCompactPondDockSupportBounds(
  dock: CompactPondDockPlacement,
): CompactPondDockBounds {
  return dockBounds(dock, COMPACT_POND_DOCK_DIMENSIONS.landingLength);
}

const exactKeys = (row: object, keys: readonly string[]) =>
  Object.keys(row).sort().join(",") === [...keys].sort().join(",");
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);

/** Opt-in bounded JSON admission; never invent or snap a shoreline position. */
export function validateCompactPondDocks(
  value: unknown,
  terrainProfile: WorldTerrainProfile,
): CompactPondDocksManifest | undefined {
  if (value === undefined) return undefined;
  const profile = validateWorldTerrainProfile(terrainProfile);
  const copy = JSON.parse(
    canonicalWorldJson(value),
  ) as CompactPondDocksManifest;
  if (
    !copy ||
    typeof copy !== "object" ||
    Array.isArray(copy) ||
    !exactKeys(copy, [
      "schemaVersion",
      "layoutId",
      "terrainProfileId",
      "waterBodyId",
      "docks",
    ]) ||
    copy.schemaVersion !== 1 ||
    copy.layoutId !== "compact-pond-docks-v1" ||
    copy.terrainProfileId !== "compact-duel-island-v6" ||
    profile.id !== copy.terrainProfileId ||
    profile.kind !== "compact-candidate" ||
    profile.algorithm !== "compact-island-sculpt-v5" ||
    profile.terrainTileSize !== 100 ||
    !validId(copy.waterBodyId) ||
    !Array.isArray(copy.docks) ||
    copy.docks.length !== 2
  )
    throw new Error("Invalid compactPondDocks profile or layout");
  const ids = new Set<string>();
  const recipes = new Set<string>();
  const reservations: CompactPondDockBounds[] = [];
  for (const dock of copy.docks) {
    if (
      !dock ||
      typeof dock !== "object" ||
      Array.isArray(dock) ||
      !exactKeys(dock, ["id", "x", "z", "rotation", "recipeId"]) ||
      !validId(dock.id) ||
      ids.has(dock.id) ||
      !Number.isFinite(dock.x) ||
      !Number.isFinite(dock.z) ||
      ![0, 90, 180, 270].includes(dock.rotation) ||
      !["haven-fishing-landing-v1", "haven-reed-jetty-v1"].includes(
        dock.recipeId,
      ) ||
      recipes.has(dock.recipeId)
    )
      throw new Error("Invalid or duplicate compact pond dock placement");
    const northSouth = dock.rotation === 0 || dock.rotation === 180;
    if (
      !Number.isInteger(dock.x - (northSouth ? 0.5 : 0)) ||
      !Number.isInteger(dock.z - (northSouth ? 0 : 0.5))
    )
      throw new Error("Compact pond dock anchor does not match its tile grid");
    const bounds = getCompactPondDockSupportBounds(dock);
    if (
      bounds.minX < profile.bounds.minX ||
      bounds.maxX > profile.bounds.maxX ||
      bounds.minZ < profile.bounds.minZ ||
      bounds.maxZ > profile.bounds.maxZ
    )
      throw new Error(
        "Compact pond dock landing or deck exceeds profile bounds",
      );
    for (const previous of reservations)
      if (
        bounds.minX <= previous.maxX &&
        bounds.maxX >= previous.minX &&
        bounds.minZ <= previous.maxZ &&
        bounds.maxZ >= previous.minZ
      )
        throw new Error("Compact pond dock reservations overlap or touch");
    reservations.push(bounds);
    ids.add(dock.id);
    recipes.add(dock.recipeId);
    Object.freeze(dock);
  }
  Object.freeze(copy.docks);
  return Object.freeze(copy);
}

/** Mandatory explicit-water binding, not a substitute for wet/dry or navigation
 * checks. Runtime owners compare this immutable datum with the live registry
 * before allocating geometry, collision flags, or deck-height overrides. */
export function validateCompactPondDockBindings(
  layout: CompactPondDocksManifest | undefined,
  areas: Readonly<Record<string, WorldArea>>,
): CompactPondDockWaterBody | undefined {
  if (!layout) return undefined;
  const matches = Object.values(areas)
    .flatMap((area) => area.waterBodies ?? [])
    .filter((body) => body.id === layout.waterBodyId);
  if (matches.length !== 1)
    throw new Error("Compact pond dock water binding is missing or ambiguous");
  const body = JSON.parse(
    canonicalWorldJson(matches[0]),
  ) as CompactPondDockWaterBody;
  if (
    !exactKeys(body, ["id", "centerX", "centerZ", "radius", "surfaceY"]) ||
    ![body.centerX, body.centerZ, body.radius, body.surfaceY].every(
      Number.isFinite,
    ) ||
    body.radius <= 0 ||
    body.radius > 32
  )
    throw new Error(
      "Compact pond docks require a finite bounded explicit basin",
    );
  for (const dock of layout.docks) {
    const bounds = getCompactPondDockCoreBounds(dock);
    const x = Math.max(bounds.minX, Math.min(bounds.maxX, body.centerX));
    const z = Math.max(bounds.minZ, Math.min(bounds.maxZ, body.centerZ));
    if ((x - body.centerX) ** 2 + (z - body.centerZ) ** 2 >= body.radius ** 2)
      throw new Error(
        "Compact pond dock core does not intersect its bound basin",
      );
  }
  return Object.freeze(body);
}

export interface DockDefinition {
  id: string;
  /** Shore-side anchor X (where the dock meets land) */
  x: number;
  /** Shore-side anchor Z */
  z: number;
  /** Compass bearing in degrees — direction the dock extends over water */
  rotation: number;
  /** Deck width in meters (tiles across, default 3) */
  width?: number;
  /** Deck length in meters (tiles into water, default 12) */
  length?: number;
  /** Label shown on interaction (default "Dock") */
  label?: string;
}

/**
 * The compact island currently has no authored dock placements.
 * Future placements must fit the admitted terrain profile.
 */
export const ISLAND_DOCKS: DockDefinition[] = [];
