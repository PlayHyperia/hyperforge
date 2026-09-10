import type { FlatZone } from "../types/world/terrain";
import { createAuthoredTerrainSurfaceOperations } from "../systems/shared/world/AuthoredTerrainSurface";
import { ALL_WORLD_AREAS, type WorldArea } from "./world-areas";
import { getDuelArenaConfig, type DuelArenaConfig } from "./duel-manifest";
import {
  HOSPITAL_CENTER_X,
  HOSPITAL_CENTER_Z,
  HOSPITAL_WIDTH,
  HOSPITAL_LENGTH,
  LOBBY_CENTER_X,
  LOBBY_CENTER_Z,
  LOBBY_WIDTH,
  LOBBY_LENGTH,
} from "./arena-layout";

export const DUEL_ARENA_CAMPUS_GRADE_ID = "duel_arena_campus_grade";
export const DUEL_ARENA_FLOOR_GROUND_OFFSET = 0.4;
export const DUEL_ARENA_FLOOR_CENTER_OFFSET = 0.27;
export const DUEL_ARENA_FLOOR_THICKNESS = 0.3;

function lobbyDestination(offsetX: number): {
  x: number;
  y: number;
  z: number;
} {
  const spawn = getDuelArenaConfig().lobbySpawnPoint;
  const x = spawn.x + offsetX;
  const z = spawn.z;
  if (
    ![x, z].every(Number.isFinite) ||
    Math.abs(x - LOBBY_CENTER_X) >= LOBBY_WIDTH / 2 ||
    Math.abs(z - LOBBY_CENTER_Z) >= LOBBY_LENGTH / 2
  ) {
    throw new Error(
      "Duel lobby destination must remain inside the shared lobby floor",
    );
  }
  return {
    x,
    y: getDuelArenaGradeHeight() + DUEL_ARENA_FLOOR_GROUND_OFFSET,
    z,
  };
}

/** Resolve at use time, after manifest admission, with separated return marks. */
export function getDuelArenaLobbyReturnPosition(isWinner: boolean): {
  x: number;
  y: number;
  z: number;
} {
  return lobbyDestination(isWinner ? -3 : 3);
}

/** The canonical lobby lies outside every combat ring, inside the active island. */
export function getDuelArenaEgressPosition(): {
  x: number;
  y: number;
  z: number;
} {
  return lobbyDestination(0);
}

/** Explicit authored base shared by gameplay terrain and visual/collision floors. */
export function getDuelArenaGradeHeight(
  areas: Readonly<Record<string, WorldArea>> = ALL_WORLD_AREAS,
): number {
  const area = areas.duel_arena;
  const zones = area?.flatZones?.filter(
    (zone) => zone.id === DUEL_ARENA_CAMPUS_GRADE_ID,
  );
  if (!area || zones?.length !== 1) {
    throw new Error("Duel arena requires exactly one authored campus grade");
  }
  const zone = zones[0];
  const bounds = area.bounds;
  if (
    ![
      zone.centerX,
      zone.centerZ,
      zone.width,
      zone.depth,
      zone.height,
      zone.blendRadius,
      bounds.minX,
      bounds.maxX,
      bounds.minZ,
      bounds.maxZ,
    ].every(Number.isFinite) ||
    zone.width <= 0 ||
    zone.depth <= 0 ||
    zone.blendRadius < 0 ||
    zone.radialPond !== undefined ||
    zone.heightOffset !== undefined ||
    zone.centerX - zone.width / 2 > bounds.minX ||
    zone.centerX + zone.width / 2 < bounds.maxX ||
    zone.centerZ - zone.depth / 2 > bounds.minZ ||
    zone.centerZ + zone.depth / 2 < bounds.maxZ
  ) {
    throw new Error(
      "Duel arena authored campus grade must cover its complete area bounds at one explicit finite height",
    );
  }
  return zone.height!;
}

/**
 * Register these exact zones on both client and server BEFORE terrain generation.
 * The visual system borrows the resulting surfaces; it never owns their lifetime.
 */
export function createDuelArenaFloorZones(
  config: DuelArenaConfig,
  baseHeight: number,
): FlatZone[] {
  if (
    ![
      baseHeight,
      config.baseX,
      config.baseZ,
      config.arenaWidth,
      config.arenaLength,
      config.arenaGap,
    ].every(Number.isFinite) ||
    config.arenaWidth <= 0 ||
    config.arenaLength <= 0 ||
    config.arenaGap < 0 ||
    !Number.isSafeInteger(config.columns) ||
    config.columns < 1 ||
    !Number.isSafeInteger(config.rows) ||
    config.rows < 1 ||
    !Number.isSafeInteger(config.arenaCount) ||
    config.arenaCount < 1 ||
    config.arenaCount > config.columns * config.rows ||
    config.arenaCount > 256
  ) {
    throw new Error("Invalid duel arena floor layout or authored base height");
  }
  const floor = (
    id: string,
    centerX: number,
    centerZ: number,
    width: number,
    depth: number,
  ): FlatZone => ({
    id,
    centerX,
    centerZ,
    width,
    depth,
    height: baseHeight + DUEL_ARENA_FLOOR_GROUND_OFFSET,
    blendRadius: 1,
    carveInset: 1,
  });
  const zones: FlatZone[] = [];
  for (let i = 0; i < config.arenaCount; i++) {
    const col = i % config.columns;
    const row = Math.floor(i / config.columns);
    zones.push(
      floor(
        `duel_arena_floor_${i + 1}`,
        config.baseX +
          col * (config.arenaWidth + config.arenaGap) +
          config.arenaWidth / 2,
        config.baseZ +
          row * (config.arenaLength + config.arenaGap) +
          config.arenaLength / 2,
        config.arenaWidth,
        config.arenaLength,
      ),
    );
  }
  zones.push(
    floor(
      "duel_lobby_floor",
      LOBBY_CENTER_X,
      LOBBY_CENTER_Z,
      LOBBY_WIDTH,
      LOBBY_LENGTH,
    ),
  );
  zones.push(
    floor(
      "duel_hospital_floor",
      HOSPITAL_CENTER_X,
      HOSPITAL_CENTER_Z,
      HOSPITAL_WIDTH,
      HOSPITAL_LENGTH,
    ),
  );
  return zones;
}

/**
 * Narrow authoritative floor overlay. Its perimeter meets the authored campus,
 * never the unrelated procedural mountain beneath it. Call only for factory IDs;
 * a broad campus core must not win normal nearest-core ranking over a platform.
 * carveInset remains a mesh-carving setting, not a change to walkable heights.
 */
export function resolveDuelArenaFloorHeight(
  zone: FlatZone,
  x: number,
  z: number,
  baseHeight: number,
): number | null {
  return authoredSurface.resolveDuelArenaFloorHeight(zone, x, z, baseHeight);
}

const authoredSurface = createAuthoredTerrainSurfaceOperations();
