/**
 * Arena Layout Constants — Single Source of Truth
 *
 * ALL arena positioning derives from the values in this file.
 * To relocate the arena complex, edit the constants here and
 * everything (visuals, server logic, zone bounds) follows automatically.
 */

// ---------------------------------------------------------------------------
// Arena Grid
// ---------------------------------------------------------------------------
export const ARENA_BASE_X = 340;
export const ARENA_BASE_Z = 394;
export const ARENA_BASE_Y = 0.42;
export const ARENA_WIDTH = 20;
export const ARENA_LENGTH = 24;
export const ARENA_GAP = 4;
export const ARENA_COLUMNS = 1;
export const ARENA_ROWS = 1;
export const ARENA_COUNT = 1;
export const ARENA_SPAWN_OFFSET = 8;
export const ARENA_FORFEIT_PILLAR_INSET = 2;

// ---------------------------------------------------------------------------
// Lobby (south of arenas, right side)
// ---------------------------------------------------------------------------
export const LOBBY_CENTER_X = 385;
export const LOBBY_CENTER_Z = 376;
export const LOBBY_WIDTH = 40;
export const LOBBY_LENGTH = 25;

// ---------------------------------------------------------------------------
// Hospital (south of arenas, left side)
// ---------------------------------------------------------------------------
export const HOSPITAL_CENTER_X = 345;
export const HOSPITAL_CENTER_Z = 376;
export const HOSPITAL_WIDTH = 28;
export const HOSPITAL_LENGTH = 23;

// ---------------------------------------------------------------------------
// Lobby Spawn Point (where players appear in the lobby)
// ---------------------------------------------------------------------------
export const LOBBY_SPAWN_X = 385;
export const LOBBY_SPAWN_Y = 0.42;
export const LOBBY_SPAWN_Z = 374;

// ---------------------------------------------------------------------------
// Derived: overall zone bounds (encompasses arenas + lobby + hospital + margin)
// ---------------------------------------------------------------------------
const gridMaxX =
  ARENA_BASE_X + ARENA_COLUMNS * ARENA_WIDTH + (ARENA_COLUMNS - 1) * ARENA_GAP;
const gridMaxZ =
  ARENA_BASE_Z + ARENA_ROWS * ARENA_LENGTH + (ARENA_ROWS - 1) * ARENA_GAP;
const lobbyMinX = LOBBY_CENTER_X - LOBBY_WIDTH / 2;
const lobbyMaxX = LOBBY_CENTER_X + LOBBY_WIDTH / 2;
const lobbyMinZ = LOBBY_CENTER_Z - LOBBY_LENGTH / 2;
const lobbyMaxZ = LOBBY_CENTER_Z + LOBBY_LENGTH / 2;
const hospMinX = HOSPITAL_CENTER_X - HOSPITAL_WIDTH / 2;
const hospMaxX = HOSPITAL_CENTER_X + HOSPITAL_WIDTH / 2;
const hospMinZ = HOSPITAL_CENTER_Z - HOSPITAL_LENGTH / 2;
const hospMaxZ = HOSPITAL_CENTER_Z + HOSPITAL_LENGTH / 2;

const MARGIN = 15;
export const ZONE_BOUNDS_MIN_X =
  Math.min(ARENA_BASE_X, lobbyMinX, hospMinX) - MARGIN;
export const ZONE_BOUNDS_MAX_X =
  Math.max(gridMaxX, lobbyMaxX, hospMaxX) + MARGIN;
export const ZONE_BOUNDS_MIN_Z =
  Math.min(ARENA_BASE_Z, lobbyMinZ, hospMinZ) - MARGIN;
export const ZONE_BOUNDS_MAX_Z =
  Math.max(gridMaxZ, lobbyMaxZ, hospMaxZ) + MARGIN;
