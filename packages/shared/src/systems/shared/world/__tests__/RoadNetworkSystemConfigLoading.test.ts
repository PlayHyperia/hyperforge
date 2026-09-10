/**
 * Tests for RoadNetworkSystem config loading from world-config.json
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DataManager } from "../../../../data/DataManager";
import type { WorldConfigManifest } from "../../../../types/world/world-types";
import { loadRoadConfig, getDirections } from "../RoadNetworkSystem";

const DEFAULTS = {
  roadWidth: 6, // Updated from 4 to match RoadNetworkSystem default
  pathStepSize: 20,
  maxPathIterations: 10000,
  extraConnectionsRatio: 0.25,
  costBase: 1.0,
  costSlopeMultiplier: 5.0,
  costWaterPenalty: 1000,
  smoothingIterations: 2,
  noiseDisplacementScale: 0.01,
  noiseDisplacementStrength: 3,
  minPointSpacing: 4,
  heuristicWeight: 2.5,
} as const;

const DEFAULT_BIOME_COSTS: Record<string, number> = {
  forest: 1.0,
  tundra: 1.5,
  canyon: 2.0,
};

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

describe("RoadNetworkSystem Config Loading", () => {
  it("defaults to admitted content without mutating it during explicit projections", () => {
    const admitted = DataManager.getWorldConfig();
    const identity = DataManager.getWorldContentIdentity();
    expect(loadRoadConfig()).toEqual(loadRoadConfig(admitted));
    const input = makeConfig({ roads: { roadWidth: 3 } });
    const before = JSON.stringify(input);
    expect(loadRoadConfig(input).roadWidth).toBe(3);
    expect(JSON.stringify(input)).toBe(before);
    expect(DataManager.getWorldConfig()).toBe(admitted);
    expect(DataManager.getWorldContentIdentity()).toBe(identity);
  });

  describe("no manifest", () => {
    it("returns all defaults", () => {
      const input = null;
      const config = loadRoadConfig(input);

      expect(config.roadWidth).toBe(DEFAULTS.roadWidth);
      expect(config.pathStepSize).toBe(DEFAULTS.pathStepSize);
      expect(config.costWaterPenalty).toBe(DEFAULTS.costWaterPenalty);
      expect(config.biomeCosts.forest).toBe(DEFAULT_BIOME_COSTS.forest);
      expect(config.biomeCosts.canyon).toBe(DEFAULT_BIOME_COSTS.canyon);
    });
  });

  describe("complete manifest", () => {
    it("uses config values and merges biome costs", () => {
      const input = makeConfig({
        roads: {
          roadWidth: 6,
          pathStepSize: 25,
          maxPathIterations: 15000,
          extraConnectionsRatio: 0.35,
          costBase: 1.5,
          costWaterPenalty: 1500,
          costBiomeMultipliers: { forest: 0.8, canyon: 3.0, tundra: 5.0 },
        },
      });
      const config = loadRoadConfig(input);

      expect(config.roadWidth).toBe(6);
      expect(config.pathStepSize).toBe(25);
      expect(config.biomeCosts.forest).toBe(0.8);
      expect(config.biomeCosts.canyon).toBe(3.0);
      expect(config.biomeCosts.tundra).toBe(5.0);
    });
  });

  describe("partial manifest", () => {
    it("falls back to defaults for missing fields", () => {
      const input = makeConfig({
        roads: {
          roadWidth: 8,
          pathStepSize: undefined as unknown as number,
          costBiomeMultipliers: undefined as unknown as Record<string, number>,
        },
      });
      const config = loadRoadConfig(input);

      expect(config.roadWidth).toBe(8);
      expect(config.pathStepSize).toBe(DEFAULTS.pathStepSize);
      expect(config.biomeCosts.forest).toBe(DEFAULT_BIOME_COSTS.forest);
    });
  });

  describe("getDirections", () => {
    it("generates 8 directions with correct values", () => {
      const dirs = getDirections(20);
      expect(dirs.length).toBe(8);

      const cardinals = dirs.filter((d) => d.dx === 0 || d.dz === 0);
      const diagonals = dirs.filter((d) => d.dx !== 0 && d.dz !== 0);
      expect(cardinals.length).toBe(4);
      expect(diagonals.length).toBe(4);
    });

    it("scales with step size", () => {
      expect(getDirections(10)[0].dx).toBe(10);
      expect(getDirections(50)[0].dx).toBe(50);
      expect(getDirections(100)[0].dx).toBe(100);
    });

    it("handles edge cases", () => {
      expect(getDirections(0).every((d) => d.dx === 0 && d.dz === 0)).toBe(
        true,
      );
      expect(getDirections(-10)[0].dx).toBe(-10);
    });
  });

  describe("boundary conditions", () => {
    it("handles zero values", () => {
      const input = makeConfig({
        roads: { roadWidth: 0, maxPathIterations: 0 },
      });
      const config = loadRoadConfig(input);

      expect(config.roadWidth).toBe(0);
      expect(config.maxPathIterations).toBe(0);
    });

    it("handles extreme values", () => {
      const input = makeConfig({
        roads: {
          extraConnectionsRatio: 10.0,
          costBiomeMultipliers: {
            free: 0.0,
            expensive: 10000,
            epsilon: 0.000001,
          },
        },
      });
      const config = loadRoadConfig(input);

      expect(config.extraConnectionsRatio).toBe(10.0);
      expect(config.biomeCosts.free).toBe(0.0);
      expect(config.biomeCosts.expensive).toBe(10000);
    });
  });

  describe("edge cases", () => {
    it("accepts negative values (validation at usage time)", () => {
      const input = makeConfig({
        roads: {
          roadWidth: -4,
          pathStepSize: -20,
          costWaterPenalty: -1000,
          costBiomeMultipliers: { negativeCost: -100 },
        },
      });
      const config = loadRoadConfig(input);

      expect(config.roadWidth).toBe(-4);
      expect(config.biomeCosts.negativeCost).toBe(-100);
    });

    it("handles custom biome types", () => {
      const input = makeConfig({
        roads: {
          costBiomeMultipliers: { customBiome1: 1.5, volcanoRegion: 50.0 },
        },
      });
      const config = loadRoadConfig(input);

      expect(config.biomeCosts.customBiome1).toBe(1.5);
      expect(config.biomeCosts.volcanoRegion).toBe(50.0);
    });
  });

  describe("config consistency", () => {
    it("multiple loads return consistent results", () => {
      const input = makeConfig({ roads: { roadWidth: 5, pathStepSize: 30 } });

      const c1 = loadRoadConfig(input);
      const c2 = loadRoadConfig(input);

      expect(c1.roadWidth).toBe(c2.roadWidth);
      expect(c1.pathStepSize).toBe(c2.pathStepSize);
    });

    it("directions update when step size changes", () => {
      const smallStepInput = makeConfig({ roads: { pathStepSize: 10 } });
      const d1 = getDirections(loadRoadConfig(smallStepInput).pathStepSize);

      const largeStepInput = makeConfig({ roads: { pathStepSize: 50 } });
      const d2 = getDirections(loadRoadConfig(largeStepInput).pathStepSize);

      expect(d1[0].dx).toBe(10);
      expect(d2[0].dx).toBe(50);
    });
  });

  describe("cost calculations", () => {
    it("cost scales with costBase", () => {
      const baseCostInput = makeConfig({ roads: { costBase: 1.0 } });
      const c1 = loadRoadConfig(baseCostInput);

      const doubleCostInput = makeConfig({ roads: { costBase: 2.0 } });
      const c2 = loadRoadConfig(doubleCostInput);

      expect(100 * c2.costBase).toBe(100 * c1.costBase * 2);
    });

    it("water penalty exceeds typical step costs", () => {
      const input = makeConfig();
      const config = loadRoadConfig(input);

      const typicalStepCost = config.pathStepSize * config.costBase * 3.0;
      expect(config.costWaterPenalty).toBeGreaterThan(typicalStepCost * 10);
    });
  });
});
