#!/usr/bin/env bun

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARENA_BASE_X,
  ARENA_BASE_Y,
  ARENA_BASE_Z,
  ARENA_COLUMNS,
  ARENA_COUNT,
  ARENA_FORFEIT_PILLAR_INSET,
  ARENA_GAP,
  ARENA_LENGTH,
  ARENA_ROWS,
  ARENA_SPAWN_OFFSET,
  ARENA_WIDTH,
  HOSPITAL_CENTER_X,
  HOSPITAL_CENTER_Z,
  HOSPITAL_LENGTH,
  HOSPITAL_WIDTH,
  LOBBY_CENTER_X,
  LOBBY_CENTER_Z,
  LOBBY_LENGTH,
  LOBBY_SPAWN_X,
  LOBBY_SPAWN_Y,
  LOBBY_SPAWN_Z,
  LOBBY_WIDTH,
  ZONE_BOUNDS_MAX_X,
  ZONE_BOUNDS_MAX_Z,
  ZONE_BOUNDS_MIN_X,
  ZONE_BOUNDS_MIN_Z,
} from "../packages/shared/src/data/arena-layout";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const manifestsRoot = path.resolve(
  process.env.ASSETS_DIR
    ? path.join(process.env.ASSETS_DIR, "manifests")
    : path.join(workspaceRoot, "packages/server/world/assets/manifests"),
);

async function readJson(relativePath: string): Promise<unknown> {
  const source = await readFile(path.join(manifestsRoot, relativePath), "utf8");
  return JSON.parse(source) as unknown;
}

const arenas = Array.from({ length: ARENA_COUNT }, (_, index) => {
  const arenaId = index + 1;
  const col = index % ARENA_COLUMNS;
  const row = Math.floor(index / ARENA_COLUMNS);
  const minX = ARENA_BASE_X + col * (ARENA_WIDTH + ARENA_GAP);
  const minZ = ARENA_BASE_Z + row * (ARENA_LENGTH + ARENA_GAP);
  const maxX = minX + ARENA_WIDTH;
  const maxZ = minZ + ARENA_LENGTH;
  const centerX = minX + ARENA_WIDTH / 2;
  const centerZ = minZ + ARENA_LENGTH / 2;
  const pillarOffsetX = ARENA_WIDTH / 2 - ARENA_FORFEIT_PILLAR_INSET;
  const pillarOffsetZ = ARENA_LENGTH / 2 - ARENA_FORFEIT_PILLAR_INSET;

  return {
    arenaId,
    center: { x: centerX, z: centerZ },
    bounds: { minX, maxX, minZ, maxZ },
    spawnPoints: [
      { x: centerX, y: ARENA_BASE_Y, z: centerZ - ARENA_SPAWN_OFFSET },
      { x: centerX, y: ARENA_BASE_Y, z: centerZ + ARENA_SPAWN_OFFSET },
    ],
    forfeitPillarPositions: [
      { x: centerX - pillarOffsetX, z: centerZ + pillarOffsetZ },
      { x: centerX + pillarOffsetX, z: centerZ - pillarOffsetZ },
    ],
  };
});

const expectedArenaManifest = {
  schemaVersion: 2,
  runtimeSource: "packages/shared/src/data/arena-layout.ts",
  layout: {
    base: { x: ARENA_BASE_X, y: ARENA_BASE_Y, z: ARENA_BASE_Z },
    arenaSize: { width: ARENA_WIDTH, length: ARENA_LENGTH },
    gap: ARENA_GAP,
    columns: ARENA_COLUMNS,
    rows: ARENA_ROWS,
    spawnOffset: ARENA_SPAWN_OFFSET,
    spawnLayout: "alongLength",
  },
  arenas,
  lobby: {
    center: { x: LOBBY_CENTER_X, z: LOBBY_CENTER_Z },
    size: { width: LOBBY_WIDTH, depth: LOBBY_LENGTH },
    spawnPoint: {
      x: LOBBY_SPAWN_X,
      y: LOBBY_SPAWN_Y,
      z: LOBBY_SPAWN_Z,
    },
  },
  hospital: {
    center: { x: HOSPITAL_CENTER_X, z: HOSPITAL_CENTER_Z },
    size: { width: HOSPITAL_WIDTH, depth: HOSPITAL_LENGTH },
  },
};

const arenaManifest = await readJson("duel-arenas.json");
assert.deepStrictEqual(
  arenaManifest,
  expectedArenaManifest,
  "duel-arenas.json drifted from the authoritative runtime arena layout",
);

const worldAreas = (await readJson("world-areas.json")) as {
  specialAreas?: {
    duel_arena?: {
      bounds?: unknown;
      safeZone?: unknown;
      pvpEnabled?: unknown;
    };
  };
};
const duelArea = worldAreas.specialAreas?.duel_arena;
assert.ok(duelArea, "world-areas.json must define specialAreas.duel_arena");
assert.deepStrictEqual(
  duelArea.bounds,
  {
    minX: ZONE_BOUNDS_MIN_X,
    maxX: ZONE_BOUNDS_MAX_X,
    minZ: ZONE_BOUNDS_MIN_Z,
    maxZ: ZONE_BOUNDS_MAX_Z,
  },
  "world-areas.json duel bounds drifted from the runtime arena complex",
);
assert.equal(
  duelArea.safeZone,
  true,
  "the duel complex must block ordinary hostile behavior",
);
assert.equal(
  duelArea.pvpEnabled,
  false,
  "generic PvP must stay disabled; exact active duel sessions own the combat bypass",
);

console.log(
  JSON.stringify({
    ok: true,
    arenaCount: arenas.length,
    arenaGrid: `${ARENA_COLUMNS}x${ARENA_ROWS}`,
    bounds: duelArea.bounds,
    lobbySpawn: expectedArenaManifest.lobby.spawnPoint,
  }),
);
