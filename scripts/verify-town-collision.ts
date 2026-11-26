#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath } from "node:url";

import { DataManager } from "../packages/shared/src/data/DataManager";
import { CollisionMatrix } from "../packages/shared/src/systems/shared/movement/CollisionMatrix";
import { TownSystem } from "../packages/shared/src/systems/shared/world/TownSystem";
import { TerrainSystem } from "../packages/shared/src/systems/shared/world/TerrainSystem";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
process.env.ASSETS_DIR ??= path.join(
  workspaceRoot,
  "packages/server/world/assets",
);
process.env.TOWN_COLLISION_DEEP_VALIDATION = "true";

await DataManager.getInstance().initialize();

const systems = new Map<string, unknown>();
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
const world = {
  id: "town-collision-verifier",
  config: { terrainSeed: 0 },
  isServer: true,
  isClient: false,
  network: { isServer: true, isClient: false },
  collision: new CollisionMatrix(),
  entities: { items: new Map(), players: new Map(), get: () => null },
  getSystem: (name: string) => systems.get(name) ?? null,
  getPlayer: () => null,
  emit: (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  },
  on: (event: string, listener: (...args: unknown[]) => void) => {
    let eventListeners = listeners.get(event);
    if (!eventListeners) {
      eventListeners = new Set();
      listeners.set(event, eventListeners);
    }
    eventListeners.add(listener);
  },
  off: (event: string, listener: (...args: unknown[]) => void) => {
    listeners.get(event)?.delete(listener);
  },
};

const terrain = new TerrainSystem(world as never);
const towns = new TownSystem(world as never);
systems.set("terrain", terrain);
systems.set("towns", towns);

try {
  await terrain.init();
  const terrainInternals = terrain as unknown as {
    loadWaterBodiesFromManifest(): void;
    loadFlatZonesFromManifest(): void;
  };
  terrainInternals.loadWaterBodiesFromManifest();
  terrainInternals.loadFlatZonesFromManifest();

  await towns.init();
  try {
    await towns.start();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const townInternals = towns as unknown as {
      buildingLayouts: Map<
        string,
        {
          width: number;
          depth: number;
          floorPlans: Array<{
            footprint: boolean[][];
            roomMap: number[][];
            externalOpenings: Map<string, string>;
            internalOpenings: Map<string, string>;
          }>;
        }
      >;
      collisionService: {
        getBuilding(buildingId: string):
          | {
              worldPosition: { x: number; y: number; z: number };
              rotation: number;
              cellWidth: number;
              cellDepth: number;
              boundingBox: Record<string, number>;
              floors: Array<{
                floorIndex: number;
                walkableTiles: Set<string>;
                wallSegments: Array<{
                  tileX: number;
                  tileZ: number;
                  side: string;
                  hasOpening: boolean;
                  openingType?: string;
                }>;
              }>;
            }
          | undefined;
        getEntranceTiles(buildingId: string): Array<{
          tileX: number;
          tileZ: number;
          direction: string;
        }>;
        isTileWalkableInBuilding(
          tileX: number,
          tileZ: number,
          floorIndex: number,
        ): boolean;
      };
    };
    const buildingId = errorMessage.match(/\btown_\d+_building_\d+\b/)?.[0];
    const service = townInternals.collisionService;
    const building = buildingId ? service.getBuilding(buildingId) : undefined;
    const sourceTown = buildingId
      ? towns
          .getTowns()
          .find((town) =>
            town.buildings.some((entry) => entry.id === buildingId),
          )
      : undefined;
    const sourceBuilding = sourceTown?.buildings.find(
      (entry) => entry.id === buildingId,
    );
    const layout = buildingId
      ? townInternals.buildingLayouts.get(buildingId)
      : undefined;
    const layoutFloor = layout?.floorPlans[0];
    const groundFloor = building?.floors.find(
      (floor) => floor.floorIndex === 0,
    );
    const entrances = buildingId ? service.getEntranceTiles(buildingId) : [];
    const entranceKeys = new Set(
      entrances.map((entry) => `${entry.tileX},${entry.tileZ}`),
    );
    const openingKeys = new Set(
      (groundFloor?.wallSegments ?? [])
        .filter((wall) => wall.hasOpening)
        .map((wall) => `${wall.tileX},${wall.tileZ}`),
    );
    const walkability = building
      ? Array.from(
          {
            length:
              building.boundingBox.maxTileZ - building.boundingBox.minTileZ + 5,
          },
          (_, row) => {
            const z = building.boundingBox.minTileZ - 2 + row;
            let cells = "";
            for (
              let x = building.boundingBox.minTileX - 2;
              x <= building.boundingBox.maxTileX + 2;
              x++
            ) {
              const key = `${x},${z}`;
              cells += entranceKeys.has(key)
                ? "E"
                : openingKeys.has(key)
                  ? "O"
                  : service.isTileWalkableInBuilding(x, z, 0)
                    ? "."
                    : "#";
            }
            return { z, cells };
          },
        )
      : [];
    console.error(
      JSON.stringify(
        {
          ok: false,
          buildingId,
          source: sourceBuilding
            ? {
                townId: sourceTown?.id,
                type: sourceBuilding.type,
                position: sourceBuilding.position,
                rotation: sourceBuilding.rotation,
                recipeSeed: `${sourceTown?.id}_${sourceBuilding.id}`,
              }
            : null,
          layout: layoutFloor
            ? {
                width: layout?.width,
                depth: layout?.depth,
                footprint: layoutFloor.footprint.map((row) =>
                  row.map((cell) => (cell ? "#" : ".")).join(""),
                ),
                roomMap: layoutFloor.roomMap,
                externalOpenings: Array.from(
                  layoutFloor.externalOpenings.entries(),
                ),
                internalOpenings: Array.from(
                  layoutFloor.internalOpenings.entries(),
                ),
              }
            : null,
          building: building
            ? {
                worldPosition: building.worldPosition,
                rotation: building.rotation,
                cellWidth: building.cellWidth,
                cellDepth: building.cellDepth,
                boundingBox: building.boundingBox,
                walkableTiles: groundFloor?.walkableTiles.size ?? 0,
                openings: (groundFloor?.wallSegments ?? []).filter(
                  (wall) => wall.hasOpening,
                ),
                entrances,
                walkability,
              }
            : null,
          error: errorMessage,
        },
        null,
        2,
      ),
    );
    throw error;
  }

  const townInternals = towns as unknown as {
    collisionService: { getBuildingCount(): number };
  };
  console.log(
    JSON.stringify({
      ok: true,
      terrainSeed: 0,
      towns: towns.getTowns().length,
      buildings: townInternals.collisionService.getBuildingCount(),
      deepValidation: true,
    }),
  );
} finally {
  towns.destroy();
  terrain.destroy();
}
