/**
 * Duel Manifest - Data-Driven Rule and Equipment Definitions
 *
 * Single source of truth for duel rules and equipment slot labels/metadata.
 * This eliminates hardcoded duplications across RulesScreen.tsx, ConfirmScreen.tsx,
 * and server handlers.
 *
 * @see packages/shared/src/types/game/duel-types.ts for type definitions
 */

import type {
  DuelRules,
  EquipmentSlotRestriction,
} from "../types/game/duel-types";

/** Challenge timeout in milliseconds (30 seconds) */
export const DUEL_CHALLENGE_TIMEOUT_MS = 30000;

// ============================================================================
// Rule Definitions
// ============================================================================

/**
 * Definition for a single duel rule
 */
export interface DuelRuleDefinition {
  /** Display label for the rule */
  label: string;
  /** Description shown on hover/tooltip */
  description: string;
  /** Rules that cannot be combined with this one */
  incompatibleWith: Array<keyof DuelRules>;
}

/**
 * Duel rules manifest - single source of truth
 */
export const DUEL_RULE_DEFINITIONS: Record<
  keyof DuelRules,
  DuelRuleDefinition
> = {
  noRanged: {
    label: "No Ranged",
    description: "Cannot use ranged attacks",
    incompatibleWith: [],
  },
  noMelee: {
    label: "No Melee",
    description: "Cannot use melee attacks",
    incompatibleWith: [],
  },
  noMagic: {
    label: "No Magic",
    description: "Cannot use magic attacks",
    incompatibleWith: [],
  },
  noSpecialAttack: {
    label: "No Special Attack",
    description: "Cannot use special attacks",
    incompatibleWith: [],
  },
  noPrayer: {
    label: "No Prayer",
    description: "Prayer points drained",
    incompatibleWith: [],
  },
  noPotions: {
    label: "No Potions",
    description: "Cannot drink potions",
    incompatibleWith: [],
  },
  noFood: {
    label: "No Food",
    description: "Cannot eat food",
    incompatibleWith: [],
  },
  noForfeit: {
    label: "No Forfeit",
    description: "Fight to the death",
    incompatibleWith: ["funWeapons", "noMovement"],
  },
  noMovement: {
    label: "No Movement",
    description: "Frozen in place",
    incompatibleWith: ["noForfeit"],
  },
  funWeapons: {
    label: "Fun Weapons",
    description: "Boxing gloves only",
    incompatibleWith: ["noForfeit"],
  },
};

/**
 * Get just the labels for simple display (e.g., ConfirmScreen)
 */
export const DUEL_RULE_LABELS: Record<keyof DuelRules, string> =
  Object.fromEntries(
    Object.entries(DUEL_RULE_DEFINITIONS).map(([key, def]) => [key, def.label]),
  ) as Record<keyof DuelRules, string>;

// ============================================================================
// Equipment Slot Definitions
// ============================================================================

/**
 * Equipment slots that can be restricted in duels.
 * Alias for EquipmentSlotRestriction — canonical type lives in duel-types.ts.
 */
export type DuelEquipmentSlot = EquipmentSlotRestriction;

/**
 * Definition for a single equipment slot
 */
export interface EquipmentSlotDefinition {
  /** Display label for the slot */
  label: string;
  /** Order for display (0 = first) */
  order: number;
}

/**
 * Equipment slots manifest - single source of truth
 */
export const EQUIPMENT_SLOT_DEFINITIONS: Record<
  DuelEquipmentSlot,
  EquipmentSlotDefinition
> = {
  head: { label: "Head", order: 0 },
  cape: { label: "Cape", order: 1 },
  amulet: { label: "Amulet", order: 2 },
  weapon: { label: "Weapon", order: 3 },
  body: { label: "Body", order: 4 },
  shield: { label: "Shield", order: 5 },
  legs: { label: "Legs", order: 6 },
  gloves: { label: "Gloves", order: 7 },
  boots: { label: "Boots", order: 8 },
  ring: { label: "Ring", order: 9 },
  ammo: { label: "Ammo", order: 10 },
};

/**
 * Get just the labels for simple display
 */
export const EQUIPMENT_SLOT_LABELS: Record<DuelEquipmentSlot, string> =
  Object.fromEntries(
    Object.entries(EQUIPMENT_SLOT_DEFINITIONS).map(([key, def]) => [
      key,
      def.label,
    ]),
  ) as Record<DuelEquipmentSlot, string>;

/**
 * Ordered list of equipment slots for iteration
 */
export const EQUIPMENT_SLOTS_ORDERED: DuelEquipmentSlot[] = (
  Object.entries(EQUIPMENT_SLOT_DEFINITIONS) as [
    DuelEquipmentSlot,
    EquipmentSlotDefinition,
  ][]
)
  .sort((a, b) => a[1].order - b[1].order)
  .map(([key]) => key);

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * All valid rule keys
 */
export const VALID_DUEL_RULE_KEYS = Object.keys(DUEL_RULE_DEFINITIONS) as Array<
  keyof DuelRules
>;

/**
 * All valid duel equipment slot keys
 */
export const DUEL_EQUIPMENT_SLOT_KEYS = Object.keys(
  EQUIPMENT_SLOT_DEFINITIONS,
) as DuelEquipmentSlot[];

/**
 * Type guard for valid rule key
 */
export function isValidDuelRuleKey(key: string): key is keyof DuelRules {
  return key in DUEL_RULE_DEFINITIONS;
}

/**
 * Type guard for valid equipment slot
 */
export function isValidEquipmentSlot(slot: string): slot is DuelEquipmentSlot {
  return slot in EQUIPMENT_SLOT_DEFINITIONS;
}

/**
 * Maps duel equipment slot names to ECS EquipmentSlots property names.
 * Duel system uses "head"/"ammo" while EquipmentSlots uses "helmet"/"arrows".
 */
export const DUEL_SLOT_TO_EQUIPMENT_SLOT: Record<DuelEquipmentSlot, string> = {
  head: "helmet",
  cape: "cape",
  amulet: "amulet",
  weapon: "weapon",
  body: "body",
  shield: "shield",
  legs: "legs",
  gloves: "gloves",
  boots: "boots",
  ring: "ring",
  ammo: "arrows",
};

/**
 * Get incompatible rules for a given rule
 */
export function getIncompatibleRules(
  rule: keyof DuelRules,
): Array<keyof DuelRules> {
  return DUEL_RULE_DEFINITIONS[rule].incompatibleWith;
}

/**
 * Check if two rules are compatible
 */
export function areRulesCompatible(
  rule1: keyof DuelRules,
  rule2: keyof DuelRules,
): boolean {
  const incompatible1 = DUEL_RULE_DEFINITIONS[rule1].incompatibleWith;
  const incompatible2 = DUEL_RULE_DEFINITIONS[rule2].incompatibleWith;
  return !incompatible1.includes(rule2) && !incompatible2.includes(rule1);
}

// ============================================================================
// Arena Configuration (Manifest-Driven)
// ============================================================================

import { ALL_WORLD_AREAS } from "./world-areas";
import {
  ARENA_BASE_X,
  ARENA_BASE_Z,
  ARENA_BASE_Y,
  ARENA_WIDTH,
  ARENA_LENGTH,
  ARENA_GAP,
  ARENA_COLUMNS,
  ARENA_ROWS,
  ARENA_COUNT,
  ARENA_SPAWN_OFFSET,
  LOBBY_SPAWN_X,
  LOBBY_SPAWN_Y,
  LOBBY_SPAWN_Z,
  LOBBY_CENTER_X,
  LOBBY_CENTER_Z,
  LOBBY_WIDTH,
  LOBBY_LENGTH,
} from "./arena-layout";

/**
 * Arena layout configuration derived from world-areas.json manifest.
 * Positions come from arena-layout.ts (single source of truth).
 */
export interface DuelArenaConfig {
  /** Base X coordinate for arena grid */
  baseX: number;
  /** Base Z coordinate for arena grid */
  baseZ: number;
  /** Ground level Y coordinate */
  baseY: number;
  /** Width of each arena (x-axis) */
  arenaWidth: number;
  /** Length of each arena (z-axis) */
  arenaLength: number;
  /** Gap between arenas */
  arenaGap: number;
  /** Number of columns in arena grid */
  columns: number;
  /** Number of rows in arena grid */
  rows: number;
  /** Total number of arenas */
  arenaCount: number;
  /** Distance from center to spawn point */
  spawnOffset: number;
  /** Spawns on arena length (±Z) vs width (±X) */
  spawnLayout: "alongLength" | "alongWidth";
  /** Lobby spawn point */
  lobbySpawnPoint: { x: number; y: number; z: number };
}

/**
 * Canonical single-arena layout, also used when no sub-zone override is present.
 */
const DEFAULT_ARENA_CONFIG: DuelArenaConfig = {
  baseX: ARENA_BASE_X,
  baseZ: ARENA_BASE_Z,
  baseY: ARENA_BASE_Y,
  arenaWidth: ARENA_WIDTH,
  arenaLength: ARENA_LENGTH,
  arenaGap: ARENA_GAP,
  columns: ARENA_COLUMNS,
  rows: ARENA_ROWS,
  arenaCount: ARENA_COUNT,
  spawnOffset: ARENA_SPAWN_OFFSET,
  spawnLayout: "alongLength",
  lobbySpawnPoint: { x: LOBBY_SPAWN_X, y: LOBBY_SPAWN_Y, z: LOBBY_SPAWN_Z },
};

/**
 * Get duel arena configuration from manifest.
 * Reads from ALL_WORLD_AREAS["duel_arena"].subZones.arenas
 * The canonical layout is used when no sub-zone override is present. Invalid
 * explicit overrides fail closed instead of silently selecting another ring.
 */
export function getDuelArenaConfig(): DuelArenaConfig {
  const duelArena = ALL_WORLD_AREAS["duel_arena"];
  if (duelArena?.subZones === undefined) {
    return {
      ...DEFAULT_ARENA_CONFIG,
      lobbySpawnPoint: { ...DEFAULT_ARENA_CONFIG.lobbySpawnPoint },
    };
  }

  const arenas = duelArena.subZones?.arenas;
  const lobby = duelArena.subZones?.lobby;
  if (
    !arenas ||
    typeof arenas !== "object" ||
    !arenas.bounds ||
    typeof arenas.bounds !== "object" ||
    (lobby !== undefined && (!lobby || typeof lobby !== "object")) ||
    (arenas.arenaSize !== undefined &&
      (!arenas.arenaSize || typeof arenas.arenaSize !== "object"))
  ) {
    throw new Error("Invalid duel arena configuration: missing arena bounds");
  }

  let columns = ARENA_COLUMNS;
  let rows = ARENA_ROWS;
  if (arenas.arenaLayout !== undefined) {
    const match =
      typeof arenas.arenaLayout === "string"
        ? arenas.arenaLayout.match(/^([1-9]\d*)x([1-9]\d*)$/)
        : null;
    if (!match) {
      throw new Error("Invalid duel arena configuration: malformed layout");
    }
    columns = Number(match[1]);
    rows = Number(match[2]);
  }

  const spawnLayout =
    arenas.spawnLayout === undefined ? "alongLength" : arenas.spawnLayout;
  const lobbySpawn =
    lobby?.spawnPoint === undefined
      ? DEFAULT_ARENA_CONFIG.lobbySpawnPoint
      : lobby.spawnPoint;
  if (!lobbySpawn || typeof lobbySpawn !== "object") {
    throw new Error("Invalid duel arena configuration: malformed lobby spawn");
  }

  const config: DuelArenaConfig = {
    baseX: arenas.bounds.minX,
    baseZ: arenas.bounds.minZ,
    baseY: 0,
    arenaWidth:
      arenas.arenaSize === undefined
        ? DEFAULT_ARENA_CONFIG.arenaWidth
        : arenas.arenaSize.width,
    arenaLength:
      arenas.arenaSize === undefined
        ? DEFAULT_ARENA_CONFIG.arenaLength
        : arenas.arenaSize.length,
    arenaGap:
      arenas.arenaGap === undefined
        ? DEFAULT_ARENA_CONFIG.arenaGap
        : arenas.arenaGap,
    columns,
    rows,
    arenaCount:
      arenas.arenaCount === undefined ? ARENA_COUNT : arenas.arenaCount,
    spawnOffset: DEFAULT_ARENA_CONFIG.spawnOffset,
    spawnLayout,
    lobbySpawnPoint: { ...lobbySpawn },
  };
  const areaBounds = duelArena.bounds;

  // Exactly one authoritative ring. Keep numeric/grid/bounds admission aligned
  // with pool allocation, floor generation and both containment queries.
  if (
    ![
      config.baseX,
      config.baseZ,
      config.baseY,
      config.arenaWidth,
      config.arenaLength,
      config.arenaGap,
      config.spawnOffset,
      arenas.bounds.maxX,
      arenas.bounds.maxZ,
      lobbySpawn.x,
      lobbySpawn.y,
      lobbySpawn.z,
      areaBounds?.minX,
      areaBounds?.maxX,
      areaBounds?.minZ,
      areaBounds?.maxZ,
    ].every(Number.isFinite) ||
    config.arenaWidth <= 0 ||
    config.arenaLength <= 0 ||
    config.arenaGap < 0 ||
    config.columns !== ARENA_COLUMNS ||
    config.rows !== ARENA_ROWS ||
    config.arenaCount !== ARENA_COUNT ||
    config.arenaCount !== config.columns * config.rows ||
    (spawnLayout !== "alongLength" && spawnLayout !== "alongWidth") ||
    config.spawnOffset <= 0 ||
    config.spawnOffset >=
      (spawnLayout === "alongWidth" ? config.arenaWidth : config.arenaLength) /
        2 ||
    arenas.bounds.maxX !== config.baseX + config.arenaWidth ||
    arenas.bounds.maxZ !== config.baseZ + config.arenaLength ||
    arenas.bounds.maxX <= config.baseX ||
    arenas.bounds.maxZ <= config.baseZ ||
    config.baseX < areaBounds.minX ||
    arenas.bounds.maxX > areaBounds.maxX ||
    config.baseZ < areaBounds.minZ ||
    arenas.bounds.maxZ > areaBounds.maxZ ||
    Math.abs(lobbySpawn.x - LOBBY_CENTER_X) >= LOBBY_WIDTH / 2 ||
    Math.abs(lobbySpawn.z - LOBBY_CENTER_Z) >= LOBBY_LENGTH / 2
  ) {
    throw new Error(
      "Invalid duel arena configuration: expected one valid ring",
    );
  }

  return config;
}

/**
 * Check if a position is inside the overall duel arena zone bounds.
 * Includes lobby, hospital, and combat arenas.
 *
 * @param x - World X coordinate
 * @param z - World Z coordinate
 * @returns true if position is inside duel arena bounds
 */
export function isPositionInsideDuelArenaZone(x: number, z: number): boolean {
  const duelArena = ALL_WORLD_AREAS["duel_arena"];
  if (!duelArena?.bounds) {
    return false;
  }

  const { minX, maxX, minZ, maxZ } = duelArena.bounds;
  return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
}

/**
 * Check if a position is inside any combat arena.
 * Used for zone validation (e.g., preventing challenges inside arenas).
 *
 * @param x - World X coordinate
 * @param z - World Z coordinate
 * @returns true if position is inside a combat arena
 */
export function isPositionInsideCombatArena(x: number, z: number): boolean {
  const config = getDuelArenaConfig();

  for (let index = 0; index < config.arenaCount; index++) {
    const row = Math.floor(index / config.columns);
    const col = index % config.columns;
    const arenaMinX =
      config.baseX + col * (config.arenaWidth + config.arenaGap);
    const arenaMaxX = arenaMinX + config.arenaWidth;
    const arenaMinZ =
      config.baseZ + row * (config.arenaLength + config.arenaGap);
    const arenaMaxZ = arenaMinZ + config.arenaLength;

    if (x >= arenaMinX && x <= arenaMaxX && z >= arenaMinZ && z <= arenaMaxZ) {
      return true;
    }
  }

  return false;
}

export type DuelCombatArenaBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

/** Resolve one exact combat ring containing every supplied world position. */
export function getCombatArenaBoundsContainingPositions(
  positions: readonly (readonly [number, number, number])[],
): DuelCombatArenaBounds | null {
  if (positions.length === 0) return null;
  const config = getDuelArenaConfig();

  for (let index = 0; index < config.arenaCount; index += 1) {
    const row = Math.floor(index / config.columns);
    const column = index % config.columns;
    const minX = config.baseX + column * (config.arenaWidth + config.arenaGap);
    const minZ = config.baseZ + row * (config.arenaLength + config.arenaGap);
    const bounds = {
      minX,
      maxX: minX + config.arenaWidth,
      minZ,
      maxZ: minZ + config.arenaLength,
    };
    if (
      positions.every(
        ([x, , z]) =>
          Number.isFinite(x) &&
          Number.isFinite(z) &&
          x >= bounds.minX &&
          x <= bounds.maxX &&
          z >= bounds.minZ &&
          z <= bounds.maxZ,
      )
    ) {
      return bounds;
    }
  }

  return null;
}
