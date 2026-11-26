import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { TerrainSystem } from "../TerrainSystem";
import { WaterBodyRegistry } from "../WaterBodyRegistry";

describe("TerrainSystem explicit water-body manifest", () => {
  const originalAreas = new Map(Object.entries(ALL_WORLD_AREAS));

  beforeEach(() => {
    for (const key of Object.keys(ALL_WORLD_AREAS)) {
      delete ALL_WORLD_AREAS[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(ALL_WORLD_AREAS)) {
      delete ALL_WORLD_AREAS[key];
    }
    for (const [key, area] of originalAreas) {
      ALL_WORLD_AREAS[key] = area;
    }
    vi.restoreAllMocks();
  });

  it("registers exact manifest geometry before terrain generation", () => {
    ALL_WORLD_AREAS.launch_pond = {
      id: "launch_pond",
      name: "Launch Pond",
      description: "test",
      difficultyLevel: 0,
      bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
      biomeType: "plains",
      safeZone: true,
      npcs: [],
      resources: [],
      mobSpawns: [],
      waterBodies: [
        {
          id: "launch_pond_water",
          centerX: -24,
          centerZ: -10,
          radius: 6,
          surfaceY: 22.5,
        },
      ],
    };

    const terrain = new TerrainSystem({} as never);
    const registry = new WaterBodyRegistry(16);
    const internals = terrain as unknown as {
      waterBodyRegistry: WaterBodyRegistry;
      loadWaterBodiesFromManifest(): void;
    };
    internals.waterBodyRegistry = registry;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    internals.loadWaterBodiesFromManifest();

    expect(registry.getAllBodies()).toHaveLength(1);
    expect(registry.getBodyAt(-24, -10)).toMatchObject({
      id: "launch_pond_water",
      centerX: -24,
      centerZ: -10,
      radius: 6,
      radiusSq: 36,
      surfaceY: 22.5,
      sourceType: "explicit",
    });
    expect(registry.getWaterSurfaceAt(-24, -10)).toBe(22.5);
    expect(registry.getWaterSurfaceAt(30, 30)).toBe(16);
    expect(registry.getBodiesInTile(0, 0, 100)).toHaveLength(1);
  });

  it("fails closed on duplicate manifest identities", () => {
    const waterBody = {
      id: "duplicate_pond",
      centerX: 0,
      centerZ: 0,
      radius: 5,
      surfaceY: 20,
    };
    for (const areaId of ["one", "two"]) {
      ALL_WORLD_AREAS[areaId] = {
        id: areaId,
        name: areaId,
        description: "test",
        difficultyLevel: 0,
        bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
        biomeType: "plains",
        safeZone: true,
        npcs: [],
        resources: [],
        mobSpawns: [],
        waterBodies: [waterBody],
      };
    }

    const terrain = new TerrainSystem({} as never);
    const internals = terrain as unknown as {
      waterBodyRegistry: WaterBodyRegistry;
      loadWaterBodiesFromManifest(): void;
    };
    internals.waterBodyRegistry = new WaterBodyRegistry(16);

    expect(() => internals.loadWaterBodiesFromManifest()).toThrow(
      "Duplicate water body ID duplicate_pond",
    );
  });
});
