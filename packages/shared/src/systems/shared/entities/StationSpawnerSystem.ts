/**
 * StationSpawnerSystem - Spawns world stations from world-areas.json
 *
 * Spawns permanent stations (banks, furnaces, anvils, altars, ranges)
 * defined in world-areas.json. Uses stations.json for model/config data.
 *
 * Pattern follows MobNPCSpawnerSystem:
 * - Extends SystemBase
 * - Depends on entity-manager and terrain
 * - Spawns at world start (not reactively like mobs)
 */

import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import { stationDataProvider } from "../../../data/StationDataProvider";
import type { World } from "../../../types/index";
import { SystemBase } from "../infrastructure/SystemBase";
import { EntityType } from "../../../types/entities";

// Authored station model offsets compensate for this entity-origin clearance.
// Keep it shared with the real-asset grounding regression, not duplicated there.
export const STATION_GROUND_CLEARANCE = 0.1;

export class StationSpawnerSystem extends SystemBase {
  constructor(world: World) {
    super(world, {
      name: "station-spawner",
      dependencies: {
        required: ["entity-manager", "terrain"],
        optional: [],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // No event subscriptions needed - stations are static
  }

  async start(): Promise<void> {
    // Only server spawns stations
    if (this.world.isServer) {
      await this.spawnAllStationsFromManifest();
    }
  }

  /**
   * Spawn all stations defined in world-areas.json
   * Similar to MobNPCSpawnerSystem.spawnAllNPCsFromManifest()
   */
  private async spawnAllStationsFromManifest(): Promise<void> {
    // Wait for EntityManager to be ready (same pattern as MobNPCSpawnerSystem)
    let entityManager = this.world.getSystem("entity-manager") as {
      spawnEntity?: (config: unknown) => Promise<unknown>;
    } | null;
    let attempts = 0;

    while ((!entityManager || !entityManager.spawnEntity) && attempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      entityManager = this.world.getSystem("entity-manager") as {
        spawnEntity?: (config: unknown) => Promise<unknown>;
      } | null;
      attempts++;
    }

    if (!entityManager?.spawnEntity) {
      console.error(
        "[StationSpawnerSystem] EntityManager not available for station spawning",
      );
      return;
    }

    // Get terrain height function
    const terrainSystem = this.world.getSystem("terrain") as {
      getHeightAt?: (x: number, z: number) => number | null;
    } | null;

    // Iterate through all world areas
    for (const area of Object.values(ALL_WORLD_AREAS)) {
      if (!area.stations || area.stations.length === 0) continue;

      for (const station of area.stations) {
        // Get ground height at station position
        const groundY =
          terrainSystem?.getHeightAt?.(
            station.position.x,
            station.position.z,
          ) ?? 40;
        const spawnY = groundY + STATION_GROUND_CLEARANCE;

        // Get station manifest data for display name
        const stationData = stationDataProvider.getStationData(station.type);
        const stationName = stationData?.name ?? station.type;

        // Map station type to EntityType
        const entityTypeMap: Record<string, string> = {
          bank: EntityType.BANK,
          furnace: EntityType.FURNACE,
          anvil: EntityType.ANVIL,
          altar: EntityType.ALTAR,
          range: EntityType.RANGE,
          runecrafting_altar: EntityType.RUNECRAFTING_ALTAR,
        };

        const entityType = entityTypeMap[station.type] ?? station.type;

        // Build entity config based on station type
        const stationConfig = {
          id: `station_${station.id}`,
          name: stationName,
          type: entityType,
          position: { x: station.position.x, y: spawnY, z: station.position.z },
          // Bank-specific: include bankId in properties (BankEntity expects config.properties.bankId)
          ...(station.type === "bank" && {
            properties: {
              bankId: station.bankId ?? "spawn_bank",
            },
          }),
          // Runecrafting altar: pass runeType and derive name (e.g. "Air Altar")
          ...(station.type === "runecrafting_altar" && {
            runeType:
              (station as unknown as { runeType?: string }).runeType ?? "air",
            name: `${((station as unknown as { runeType?: string }).runeType ?? "air").charAt(0).toUpperCase()}${((station as unknown as { runeType?: string }).runeType ?? "air").slice(1)} Altar`,
          }),
        };

        try {
          await entityManager.spawnEntity(stationConfig);
        } catch (err) {
          console.error(
            `[StationSpawnerSystem] Failed to spawn ${station.type} ${station.id}:`,
            err,
          );
        }
      }
    }
  }

  update(_dt: number): void {
    // Stations are static, no update needed
  }
}
