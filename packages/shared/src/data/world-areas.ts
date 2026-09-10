/**
 * World Areas - Data-Driven Implementation
 *
 * ALL world area data is loaded from JSON manifests at runtime by DataManager.
 * This keeps world definitions data-driven and separate from code.
 *
 * Data loaded from: assets/manifests/world-areas.json
 *
 * To modify world areas:
 * 1. Edit assets/manifests/world-areas.json
 * 2. Restart server to reload manifests
 *
 * DO NOT add world area data here - keep it in JSON!
 */

import type {
  WorldPosition,
  BiomeResource,
  NPCLocation,
  MobSpawnPoint,
  StationLocation,
  WorldArea,
} from "../types/core/core";
import {
  ZONE_BOUNDS_MIN_X,
  ZONE_BOUNDS_MAX_X,
  ZONE_BOUNDS_MIN_Z,
  ZONE_BOUNDS_MAX_Z,
} from "./arena-layout";

// Re-export types from core
export type {
  WorldArea,
  BiomeResource,
  NPCLocation,
  MobSpawnPoint,
  StationLocation,
} from "../types/core/core";

/**
 * World Areas Database - Populated at runtime from JSON manifests
 * DataManager loads from assets/manifests/world-areas.json
 *
 * The duel arena remains as a structural bootstrap fallback until the
 * authoritative manifest replaces it. Ordinary risk areas must never be
 * embedded here: production startup validates the complete manifest before
 * external-value play can be enabled.
 */
export const ALL_WORLD_AREAS: Record<string, WorldArea> = {
  // Duel Arena - PvP dueling area with 6 arena platforms, lobby, and hospital
  // NOTE: Flat zones are registered programmatically by DuelArenaVisualsSystem.registerArenaFlatZones()
  // at startup. This ensures terrain height queries return floor-level values so players stand
  // on the floors and terrain mesh is carved to prevent grass growing through floor surfaces.
  duel_arena: {
    id: "duel_arena",
    name: "Duel Arena",
    description:
      "A gladiatorial arena where players can engage in honorable combat. Stake items and fight!",
    difficultyLevel: 0,
    bounds: {
      minX: ZONE_BOUNDS_MIN_X,
      maxX: ZONE_BOUNDS_MAX_X,
      minZ: ZONE_BOUNDS_MIN_Z,
      maxZ: ZONE_BOUNDS_MAX_Z,
    },
    biomeType: "plains",
    // Generic PvP remains disabled across the complex. Active duel sessions
    // bypass this zone gate only for their exact opponent.
    safeZone: true,
    pvpEnabled: false,
    npcs: [],
    resources: [],
    mobSpawns: [],
    // Flat zones registered programmatically by DuelArenaVisualsSystem at startup
  },
};

/**
 * Starter Towns - Populated by DataManager from world-areas.json
 */
export const STARTER_TOWNS: Record<string, WorldArea> = {};

/**
 * Helper Functions
 */
export function getAreaById(areaId: string): WorldArea | null {
  return ALL_WORLD_AREAS[areaId] || null;
}

export function getAreasByDifficulty(level: 0 | 1 | 2 | 3): WorldArea[] {
  return Object.values(ALL_WORLD_AREAS).filter(
    (area) => area.difficultyLevel === level,
  );
}

export function getSafeZones(): WorldArea[] {
  return Object.values(ALL_WORLD_AREAS).filter((area) => area.safeZone);
}

export function getNPCsInArea(areaId: string): NPCLocation[] {
  const area = getAreaById(areaId);
  return area ? area.npcs : [];
}

export function getResourcesInArea(areaId: string): BiomeResource[] {
  const area = getAreaById(areaId);
  return area ? area.resources : [];
}

export function getMobSpawnsInArea(areaId: string): MobSpawnPoint[] {
  const area = getAreaById(areaId);
  return area ? area.mobSpawns : [];
}

/**
 * Get all stations defined in a specific area
 * @param areaId - The area ID to query
 * @returns Array of station locations, or empty array if none
 */
export function getStationsInArea(areaId: string): StationLocation[] {
  const area = getAreaById(areaId);
  return area?.stations ?? [];
}

/**
 * Player Spawn Points - Computed from loaded world areas
 */
export function getPlayerSpawnPoints(): WorldPosition[] {
  const spawnPoints: WorldPosition[] = [];
  for (const area of Object.values(ALL_WORLD_AREAS)) {
    if (area.safeZone && area.difficultyLevel === 0) {
      // Use center of safe zone as spawn point
      const centerX = (area.bounds.minX + area.bounds.maxX) / 2;
      const centerZ = (area.bounds.minZ + area.bounds.maxZ) / 2;
      spawnPoints.push({ x: centerX, y: 0, z: centerZ });
    }
  }
  return spawnPoints;
}

export function getRandomSpawnPoint(): WorldPosition {
  const spawnPoints = getPlayerSpawnPoints();
  if (spawnPoints.length === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  const index = Math.floor(Math.random() * spawnPoints.length);
  return { ...spawnPoints[index] };
}

/**
 * World Generation Constants (areas, spawning, resources)
 * Note: Different from WORLD_STRUCTURE_CONSTANTS in world-structure.ts
 */
export const WORLD_GENERATION_CONSTANTS = {
  TOTAL_WORLD_SIZE: 500, // 500x500 meter world
  SAFE_ZONE_RADIUS: 25, // 25 meter radius around spawn points
  RESOURCE_RESPAWN_VARIANCE: 0.2, // ±20% respawn time variance
  MOB_SPAWN_CHECK_RADIUS: 5, // Don't spawn mobs within 5m of players
  AREA_TRANSITION_OVERLAP: 5, // 5 meter overlap between adjacent areas
} as const;
