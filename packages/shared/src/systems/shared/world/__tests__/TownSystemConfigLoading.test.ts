/**
 * Tests for TownSystem config loading from world-config.json
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DataManager } from "../../../../data/DataManager";
import type { WorldConfigManifest } from "../../../../types/world/world-types";
import { loadTownConfig } from "../TownSystem";
import { DEFAULT_LANDMARK_CONFIG } from "@hyperforge/procgen/building/town";

const DEFAULTS = {
  townCount: 25,
  worldSize: 10000,
  minTownSpacing: 800,
  flatnessSampleRadius: 40,
  flatnessSampleCount: 16,
  waterThreshold: 5.4,
  optimalWaterDistanceMin: 30,
  optimalWaterDistanceMax: 150,
} as const;

const DEFAULT_TOWN_SIZES = {
  hamlet: { buildingCount: { min: 3, max: 5 }, radius: 25, safeZoneRadius: 40 },
  village: {
    buildingCount: { min: 6, max: 10 },
    radius: 40,
    safeZoneRadius: 60,
  },
  town: { buildingCount: { min: 11, max: 16 }, radius: 60, safeZoneRadius: 80 },
};

const DEFAULT_BIOME_SUITABILITY: Record<string, number> = {
  forest: 0.8,
  tundra: 0.4,
  canyon: 0.3,
};

// Factory for creating test configs with minimal boilerplate
function makeConfig(
  overrides: {
    towns?: Partial<WorldConfigManifest["towns"]>;
    roads?: Partial<WorldConfigManifest["roads"]>;
  } = {},
): WorldConfigManifest {
  const config = JSON.parse(
    readFileSync(
      new URL(
        "../../../../../../server/world/assets/manifests/world-config.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as WorldConfigManifest;
  return {
    ...config,
    towns: { ...config.towns, ...overrides.towns },
    roads: { ...config.roads, ...overrides.roads },
  };
}

describe("TownSystem Config Loading", () => {
  it("defaults to admitted content without mutating it during explicit projections", () => {
    const admitted = DataManager.getWorldConfig();
    const identity = DataManager.getWorldContentIdentity();
    expect(loadTownConfig()).toEqual(loadTownConfig(admitted));
    const input = makeConfig({ towns: { townCount: 3 } });
    const before = JSON.stringify(input);
    expect(loadTownConfig(input).townCount).toBe(3);
    expect(JSON.stringify(input)).toBe(before);
    expect(DataManager.getWorldConfig()).toBe(admitted);
    expect(DataManager.getWorldContentIdentity()).toBe(identity);
  });

  describe("no manifest", () => {
    it("returns all defaults", () => {
      const input = null;
      const config = loadTownConfig(input);

      expect(config.townCount).toBe(DEFAULTS.townCount);
      expect(config.minTownSpacing).toBe(DEFAULTS.minTownSpacing);
      expect(config.townSizes.hamlet.buildingCount.min).toBe(
        DEFAULT_TOWN_SIZES.hamlet.buildingCount.min,
      );
      expect(config.biomeSuitability.forest).toBe(
        DEFAULT_BIOME_SUITABILITY.forest,
      );
      expect(config.landmarks).toEqual(DEFAULT_LANDMARK_CONFIG);
    });
  });

  describe("complete manifest", () => {
    it("uses config values", () => {
      const input = makeConfig({
        towns: {
          townCount: 50,
          minTownSpacing: 1000,
          flatnessSampleRadius: 50,
          flatnessSampleCount: 20,
          waterThreshold: 6.0,
          optimalWaterDistanceMin: 40,
          optimalWaterDistanceMax: 200,
          townSizes: {
            hamlet: {
              minBuildings: 4,
              maxBuildings: 6,
              radius: 30,
              safeZoneRadius: 45,
            },
            village: {
              minBuildings: 8,
              maxBuildings: 12,
              radius: 50,
              safeZoneRadius: 70,
            },
            town: {
              minBuildings: 15,
              maxBuildings: 20,
              radius: 70,
              safeZoneRadius: 90,
            },
          },
          biomeSuitability: { forest: 0.9, canyon: 0.5, tundra: 0.1 },
          landmarks: {
            fencesEnabled: false,
            fenceDensity: 0.25,
            fencePostHeight: 1.4,
            lamppostsInVillages: false,
            lamppostSpacing: 20,
            marketStallsEnabled: false,
            decorationsEnabled: true,
          },
        },
      });
      const config = loadTownConfig(input);

      expect(config.townCount).toBe(50);
      expect(config.minTownSpacing).toBe(1000);
      expect(config.townSizes.hamlet.buildingCount.min).toBe(4);
      expect(config.townSizes.town.safeZoneRadius).toBe(90);
      expect(config.biomeSuitability.forest).toBe(0.9);
      expect(config.biomeSuitability.tundra).toBe(0.1);
      expect(config.landmarks.fencesEnabled).toBe(false);
      expect(config.landmarks.lamppostSpacing).toBe(20);
    });
  });

  describe("partial manifest", () => {
    it("falls back to defaults for missing fields", () => {
      const input = makeConfig({
        towns: {
          townCount: 30,
          minTownSpacing: undefined as unknown as number,
          townSizes:
            undefined as unknown as WorldConfigManifest["towns"]["townSizes"],
        },
      });
      const config = loadTownConfig(input);

      expect(config.townCount).toBe(30);
      expect(config.minTownSpacing).toBe(DEFAULTS.minTownSpacing);
      expect(config.townSizes.hamlet.buildingCount).toEqual(
        DEFAULT_TOWN_SIZES.hamlet.buildingCount,
      );
    });
  });

  describe("boundary conditions", () => {
    it("handles zero and large values", () => {
      const zeroInput = makeConfig({ towns: { townCount: 0 } });
      expect(loadTownConfig(zeroInput).townCount).toBe(0);

      const largeInput = makeConfig({
        towns: { townCount: 10000, minTownSpacing: 10 },
      });
      const config = loadTownConfig(largeInput);
      expect(config.townCount).toBe(10000);
      expect(config.minTownSpacing).toBe(10);
    });

    it("handles biome suitability at 0.0 and 1.0", () => {
      const input = makeConfig({
        towns: {
          biomeSuitability: {
            perfect: 1.0,
            impossible: 0.0,
            epsilon: 0.000001,
          },
        },
      });
      const config = loadTownConfig(input);

      expect(config.biomeSuitability.perfect).toBe(1.0);
      expect(config.biomeSuitability.impossible).toBe(0.0);
      expect(config.biomeSuitability.epsilon).toBeCloseTo(0.000001, 10);
    });
  });

  describe("edge cases", () => {
    it("accepts negative values (validation at usage time)", () => {
      const input = makeConfig({
        towns: {
          townCount: -5,
          minTownSpacing: -100,
          townSizes: {
            hamlet: {
              minBuildings: -3,
              maxBuildings: -5,
              radius: -25,
              safeZoneRadius: -40,
            },
            village: {
              minBuildings: 6,
              maxBuildings: 10,
              radius: 40,
              safeZoneRadius: 60,
            },
            town: {
              minBuildings: 11,
              maxBuildings: 16,
              radius: 60,
              safeZoneRadius: 80,
            },
          },
          biomeSuitability: { negativeBiome: -0.5 },
        },
      });
      const config = loadTownConfig(input);

      expect(config.townCount).toBe(-5);
      expect(config.townSizes.hamlet.buildingCount.min).toBe(-3);
      expect(config.biomeSuitability.negativeBiome).toBe(-0.5);
    });

    it("only supports predefined town sizes", () => {
      const input = makeConfig({
        towns: {
          townSizes: {
            hamlet: {
              minBuildings: 3,
              maxBuildings: 5,
              radius: 25,
              safeZoneRadius: 40,
            },
            village: {
              minBuildings: 6,
              maxBuildings: 10,
              radius: 40,
              safeZoneRadius: 60,
            },
            town: {
              minBuildings: 11,
              maxBuildings: 16,
              radius: 60,
              safeZoneRadius: 80,
            },
            metropolis: {
              minBuildings: 50,
              maxBuildings: 100,
              radius: 150,
              safeZoneRadius: 200,
            },
          } as unknown as WorldConfigManifest["towns"]["townSizes"],
        },
      });
      const config = loadTownConfig(input);

      expect(Object.keys(config.townSizes)).toEqual([
        "hamlet",
        "village",
        "town",
      ]);
    });
  });

  describe("config consistency", () => {
    it("worldSize converts manifest tiles into meters", () => {
      const input = makeConfig();
      expect(loadTownConfig(input).worldSize).toBe(
        input.terrain.worldSize * input.terrain.tileSize,
      );
    });

    it("multiple loads return consistent results", () => {
      const input = makeConfig({
        towns: { townCount: 42, minTownSpacing: 900 },
      });

      const c1 = loadTownConfig(input);
      const c2 = loadTownConfig(input);

      expect(c1.townCount).toBe(c2.townCount);
      expect(c1.minTownSpacing).toBe(c2.minTownSpacing);
    });
  });
});
