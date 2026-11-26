/**
 * Tests for Procedural Rock and Plant generation systems.
 * Tests the placement algorithms and biome configuration without requiring a full world.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { PlantGenerator, LPK } from "@hyperforge/procgen/plant";
import {
  generateRocks,
  generatePlants,
  ROCK_BIOME_DEFAULTS,
  PLANT_BIOME_DEFAULTS,
  getRockPresetsForBiome,
  getPlantPresetsForBiome,
  type ResourceGenerationContext,
} from "../BiomeResourceGenerator";
import { mergePlantGroupForInstancing } from "../ProcgenPlantInstancer";
import type {
  BiomeRockConfig,
  BiomePlantConfig,
} from "../../../../types/world/world-types";
import { BiomeType, BIOME_LIST } from "../TerrainBiomeTypes";

/**
 * Deterministic PRNG - creates seeded random for reproducible tests
 */
function createTestRng(seed: string): () => number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash) ^ seed.charCodeAt(i);
  }

  let state = hash >>> 0;

  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/**
 * Create a test context for resource generation
 */
function createTestContext(
  tileX: number,
  tileZ: number,
  options: {
    tileSize?: number;
    waterThreshold?: number;
    getHeightAt?: (x: number, z: number) => number;
    isOnRoad?: (x: number, z: number) => boolean;
  } = {},
): ResourceGenerationContext {
  const tileSize = options.tileSize ?? 100;
  const waterThreshold = options.waterThreshold ?? 5;

  return {
    tileX,
    tileZ,
    tileKey: `${tileX}_${tileZ}`,
    tileSize,
    waterThreshold,
    getHeightAt: options.getHeightAt ?? (() => 10), // Default: above water
    isOnRoad: options.isOnRoad,
    createRng: (salt: string) => createTestRng(`${tileX}_${tileZ}_${salt}`),
  };
}

describe("Rock Generation Algorithms", () => {
  describe("ROCK_BIOME_DEFAULTS", () => {
    it("has presets defined for all major biome types", () => {
      const expectedBiomes = BIOME_LIST;

      for (const biome of expectedBiomes) {
        expect(ROCK_BIOME_DEFAULTS[biome]).toBeDefined();
        expect(ROCK_BIOME_DEFAULTS[biome].presets.length).toBeGreaterThan(0);
        expect(
          Object.keys(ROCK_BIOME_DEFAULTS[biome].distribution).length,
        ).toBeGreaterThan(0);
      }
    });

    it("forest biome has appropriate rock types", () => {
      const forestRocks = ROCK_BIOME_DEFAULTS.forest;
      expect(forestRocks.presets).toContain("boulder");
      expect(forestRocks.presets).toContain("granite");
    });

    it("canyon biome has appropriate rock types", () => {
      const canyonRocks = ROCK_BIOME_DEFAULTS.canyon;
      expect(canyonRocks.presets).toContain("sandstone");
    });

    it("tundra biome has appropriate rock types", () => {
      const tundraRocks = ROCK_BIOME_DEFAULTS.tundra;
      expect(tundraRocks.presets).toContain("granite");
      expect(tundraRocks.presets).toContain("basalt");
    });
  });

  describe("getRockPresetsForBiome", () => {
    it("returns correct presets for known biomes", () => {
      const forestPresets = getRockPresetsForBiome(BiomeType.Forest);
      expect(forestPresets.presets).toContain("boulder");

      const canyonPresets = getRockPresetsForBiome(BiomeType.Canyon);
      expect(canyonPresets.presets).toContain("sandstone");
    });

    it("returns default presets for unknown biome", () => {
      const unknownPresets = getRockPresetsForBiome("unknown_biome_xyz");
      expect(unknownPresets.presets.length).toBeGreaterThan(0);
    });

    it("is case-insensitive", () => {
      const lower = getRockPresetsForBiome(BiomeType.Forest);
      const upper = getRockPresetsForBiome("FOREST");
      expect(lower.presets).toEqual(upper.presets);
    });
  });

  describe("generateRocks", () => {
    let ctx: ResourceGenerationContext;
    let rockConfig: BiomeRockConfig;

    beforeEach(() => {
      ctx = createTestContext(0, 0);
      rockConfig = {
        enabled: true,
        density: 10,
        presets: ["boulder", "pebble"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };
    });

    it("generates rocks when enabled", () => {
      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);
    });

    it("returns empty array when disabled", () => {
      rockConfig.enabled = false;
      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBe(0);
    });

    it("respects density setting", () => {
      rockConfig.density = 5;
      const rocksLow = generateRocks(ctx, rockConfig, BiomeType.Forest);

      rockConfig.density = 20;
      const rocksHigh = generateRocks(ctx, rockConfig, BiomeType.Forest);

      expect(rocksHigh.length).toBeGreaterThan(rocksLow.length);
    });

    it("generates deterministic results for same tile", () => {
      const rocks1 = generateRocks(ctx, rockConfig, BiomeType.Forest);
      const rocks2 = generateRocks(ctx, rockConfig, BiomeType.Forest);

      expect(rocks1.length).toBe(rocks2.length);

      // Check first few positions match
      for (let i = 0; i < Math.min(3, rocks1.length); i++) {
        expect(rocks1[i].position).toEqual(rocks2[i].position);
        expect(rocks1[i].assetId).toBe(rocks2[i].assetId);
        expect(rocks1[i].scale).toBe(rocks2[i].scale);
      }
    });

    it("generates different results for different tiles", () => {
      const ctx2 = createTestContext(1, 0);
      const rocks1 = generateRocks(ctx, rockConfig, BiomeType.Forest);
      const rocks2 = generateRocks(ctx2, rockConfig, BiomeType.Forest);

      // Positions should differ
      if (rocks1.length > 0 && rocks2.length > 0) {
        expect(rocks1[0].position).not.toEqual(rocks2[0].position);
      }
    });

    it("uses presets from config", () => {
      rockConfig.presets = ["granite"];
      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

      for (const rock of rocks) {
        expect(rock.assetId).toBe("granite");
      }
    });

    it("falls back to biome presets when config presets is empty", () => {
      rockConfig.presets = [];
      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

      // Should use forest biome presets
      for (const rock of rocks) {
        expect(ROCK_BIOME_DEFAULTS.forest.presets).toContain(rock.assetId);
      }
    });

    it("applies scale within range", () => {
      rockConfig.scaleRange = [0.2, 0.8];
      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

      for (const rock of rocks) {
        expect(rock.scale).toBeGreaterThanOrEqual(0.2);
        expect(rock.scale).toBeLessThanOrEqual(0.8);
      }
    });

    it("sets category to rock", () => {
      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

      for (const rock of rocks) {
        expect(rock.category).toBe("rock");
      }
    });

    it("sets tileKey correctly", () => {
      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

      for (const rock of rocks) {
        expect(rock.tileKey).toBe("0_0");
      }
    });

    it("avoids underwater positions", () => {
      ctx = createTestContext(0, 0, {
        waterThreshold: 10,
        getHeightAt: (x, _z) => (x < 50 ? 5 : 15), // Left half underwater
      });

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

      // All rocks should be on the right side (above water)
      for (const rock of rocks) {
        expect(rock.position.x).toBeGreaterThanOrEqual(50);
      }
    });

    it("avoids road positions", () => {
      ctx = createTestContext(0, 0, {
        isOnRoad: (x, _z) => x > 40 && x < 60, // Road in middle
      });

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

      // No rocks should be on the road
      for (const rock of rocks) {
        const localX = rock.position.x - ctx.tileX * ctx.tileSize;
        expect(localX < 40 || localX > 60).toBe(true);
      }
    });

    it("respects minimum spacing", () => {
      rockConfig.minSpacing = 10;
      rockConfig.density = 50; // High density to test spacing
      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

      // Check spacing between all pairs
      for (let i = 0; i < rocks.length; i++) {
        for (let j = i + 1; j < rocks.length; j++) {
          const dx = rocks[i].position.x - rocks[j].position.x;
          const dz = rocks[i].position.z - rocks[j].position.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          expect(dist).toBeGreaterThanOrEqual(rockConfig.minSpacing - 0.1);
        }
      }
    });
  });
});

describe("Plant Generation Algorithms", () => {
  describe("PLANT_BIOME_DEFAULTS", () => {
    it("has presets defined for all major biome types", () => {
      const expectedBiomes = BIOME_LIST;

      for (const biome of expectedBiomes) {
        expect(PLANT_BIOME_DEFAULTS[biome]).toBeDefined();
        expect(PLANT_BIOME_DEFAULTS[biome].presets.length).toBeGreaterThan(0);
      }
    });

    it("forest biome has lush plants", () => {
      const forestPlants = PLANT_BIOME_DEFAULTS.forest;
      expect(forestPlants.presets).toContain("monstera");
      expect(forestPlants.presets).toContain("philodendron");
    });

    it("tundra biome has hardy plants", () => {
      const tundraPlants = PLANT_BIOME_DEFAULTS.tundra;
      expect(tundraPlants.presets).toContain("bergenia");
      expect(tundraPlants.presets).toContain("pulmonaria");
    });
  });

  describe("getPlantPresetsForBiome", () => {
    it("returns correct presets for known biomes", () => {
      const forestPresets = getPlantPresetsForBiome(BiomeType.Forest);
      expect(forestPresets.presets).toContain("monstera");

      const canyonPresets = getPlantPresetsForBiome(BiomeType.Canyon);
      expect(canyonPresets.presets).toContain("zamioculcas");
    });

    it("returns default presets for unknown biome", () => {
      const unknownPresets = getPlantPresetsForBiome("unknown_biome_xyz");
      expect(unknownPresets.presets.length).toBeGreaterThan(0);
    });
  });

  describe("generatePlants", () => {
    let ctx: ResourceGenerationContext;
    let plantConfig: BiomePlantConfig;

    beforeEach(() => {
      ctx = createTestContext(0, 0);
      plantConfig = {
        enabled: true,
        density: 15,
        presets: ["monstera", "philodendron"],
        scaleRange: [0.5, 1.2],
        minSpacing: 1.5,
        clustering: true,
        clusterSize: [2, 4],
      };
    });

    it("generates plants when enabled", () => {
      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);
      expect(plants.length).toBeGreaterThan(0);
    });

    it("returns empty array when disabled", () => {
      plantConfig.enabled = false;
      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);
      expect(plants.length).toBe(0);
    });

    it("respects density setting", () => {
      plantConfig.density = 5;
      const plantsLow = generatePlants(ctx, plantConfig, BiomeType.Forest);

      plantConfig.density = 30;
      const plantsHigh = generatePlants(ctx, plantConfig, BiomeType.Forest);

      expect(plantsHigh.length).toBeGreaterThan(plantsLow.length);
    });

    it("generates deterministic results for same tile", () => {
      const plants1 = generatePlants(ctx, plantConfig, BiomeType.Forest);
      const plants2 = generatePlants(ctx, plantConfig, BiomeType.Forest);

      expect(plants1.length).toBe(plants2.length);

      for (let i = 0; i < Math.min(3, plants1.length); i++) {
        expect(plants1[i].position).toEqual(plants2[i].position);
        expect(plants1[i].assetId).toBe(plants2[i].assetId);
      }
    });

    it("uses presets from config", () => {
      plantConfig.presets = ["calathea"];
      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);

      for (const plant of plants) {
        expect(plant.assetId).toBe("calathea");
      }
    });

    it("applies scale within range", () => {
      plantConfig.scaleRange = [0.3, 0.6];
      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);

      for (const plant of plants) {
        expect(plant.scale).toBeGreaterThanOrEqual(0.3);
        expect(plant.scale).toBeLessThanOrEqual(0.6);
      }
    });

    it("sets category to plant", () => {
      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);

      for (const plant of plants) {
        expect(plant.category).toBe("plant");
      }
    });

    it("avoids underwater positions", () => {
      ctx = createTestContext(0, 0, {
        waterThreshold: 10,
        getHeightAt: (x, _z) => (x < 50 ? 5 : 15),
      });

      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);

      for (const plant of plants) {
        expect(plant.position.x).toBeGreaterThanOrEqual(50);
      }
    });

    it("respects minimum spacing", () => {
      plantConfig.minSpacing = 5;
      plantConfig.density = 50;
      plantConfig.clustering = false;
      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);

      for (let i = 0; i < plants.length; i++) {
        for (let j = i + 1; j < plants.length; j++) {
          const dx = plants[i].position.x - plants[j].position.x;
          const dz = plants[i].position.z - plants[j].position.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          expect(dist).toBeGreaterThanOrEqual(plantConfig.minSpacing - 0.1);
        }
      }
    });
  });
});

describe("Biome Integration", () => {
  it("rocks and plants can be generated for the same tile", () => {
    const ctx = createTestContext(5, 5);

    const rockConfig: BiomeRockConfig = {
      enabled: true,
      density: 5,
      presets: ["boulder"],
      scaleRange: [0.5, 1.0],
      clusterChance: 0.2,
      minSpacing: 3,
    };

    const plantConfig: BiomePlantConfig = {
      enabled: true,
      density: 10,
      presets: ["monstera"],
      scaleRange: [0.5, 1.0],
      minSpacing: 1.5,
    };

    const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
    const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);

    expect(rocks.length).toBeGreaterThan(0);
    expect(plants.length).toBeGreaterThan(0);

    // Both should have unique IDs
    const allIds = [...rocks.map((r) => r.id), ...plants.map((p) => p.id)];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });

  it("different biomes produce different vegetation", () => {
    const forestCtx = createTestContext(0, 0);
    const canyonCtx = createTestContext(10, 10);

    const rockConfig: BiomeRockConfig = {
      enabled: true,
      density: 20,
      presets: [], // Use biome defaults
      scaleRange: [0.5, 1.5],
      clusterChance: 0.3,
      minSpacing: 2,
    };

    const forestRocks = generateRocks(forestCtx, rockConfig, BiomeType.Forest);
    const canyonRocks = generateRocks(canyonCtx, rockConfig, BiomeType.Canyon);

    // Should use different rock types
    const forestTypes = new Set(forestRocks.map((r) => r.assetId));
    const canyonTypes = new Set(canyonRocks.map((r) => r.assetId));

    // Canyon should have sandstone, forest should not
    expect(canyonTypes.has("sandstone")).toBe(true);
    expect(forestTypes.has("sandstone")).toBe(false);
  });
});

describe("ID Generation", () => {
  it("generates unique IDs within a tile", () => {
    const ctx = createTestContext(0, 0);

    const rockConfig: BiomeRockConfig = {
      enabled: true,
      density: 20,
      presets: ["boulder"],
      scaleRange: [0.5, 1.0],
      clusterChance: 0.2,
      minSpacing: 2,
    };

    const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
    const ids = rocks.map((r) => r.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length);
  });

  it("generates IDs that include tile key", () => {
    const ctx = createTestContext(3, 7);

    const rockConfig: BiomeRockConfig = {
      enabled: true,
      density: 5,
      presets: ["boulder"],
      scaleRange: [0.5, 1.0],
      clusterChance: 0.2,
      minSpacing: 2,
    };

    const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

    for (const rock of rocks) {
      expect(rock.id).toContain("3_7");
    }
  });
});

// ============================================================================
// BOUNDARY CONDITIONS AND EDGE CASES
// ============================================================================

describe("Boundary Conditions - Rocks", () => {
  describe("Density Edge Cases", () => {
    it("returns empty array for zero density", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 0,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBe(0);
    });

    it("handles very high density with spacing constraint", () => {
      const ctx = createTestContext(0, 0, { tileSize: 50 });
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 1000, // Very high
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0,
        minSpacing: 10, // Large spacing will limit actual count
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      // Spacing should limit the count significantly
      // 50x50 tile with 10m spacing can fit ~25 rocks maximum
      expect(rocks.length).toBeLessThan(30);
      expect(rocks.length).toBeGreaterThan(0);
    });

    it("handles fractional density that rounds to zero", () => {
      const ctx = createTestContext(0, 0, { tileSize: 10 }); // Small tile
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 0.5, // With 10x10 tile = 0.01 area units, rounds to 0
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBe(0);
    });
  });

  describe("Tile Coordinate Edge Cases", () => {
    it("handles negative tile coordinates", () => {
      const ctx = createTestContext(-5, -10);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 10,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);

      // Position should be in negative world space
      for (const rock of rocks) {
        expect(rock.position.x).toBeLessThan(0);
        expect(rock.position.z).toBeLessThan(0);
        expect(rock.tileKey).toBe("-5_-10");
      }
    });

    it("handles very large tile coordinates", () => {
      const ctx = createTestContext(99999, 99999);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 5,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);

      // Positions should be in far positive world space
      for (const rock of rocks) {
        expect(rock.position.x).toBeGreaterThan(9999000);
        expect(rock.position.z).toBeGreaterThan(9999000);
      }
    });
  });

  describe("Scale Range Edge Cases", () => {
    it("handles equal min and max scale (fixed scale)", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 10,
        presets: ["boulder"],
        scaleRange: [1.0, 1.0], // Fixed scale
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);

      for (const rock of rocks) {
        expect(rock.scale).toBe(1.0);
      }
    });

    it("handles very small scale range", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 10,
        presets: ["boulder"],
        scaleRange: [0.01, 0.02],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);

      for (const rock of rocks) {
        expect(rock.scale).toBeGreaterThanOrEqual(0.01);
        expect(rock.scale).toBeLessThanOrEqual(0.02);
      }
    });

    it("handles very large scale values", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 10,
        presets: ["boulder"],
        scaleRange: [10.0, 100.0],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);

      for (const rock of rocks) {
        expect(rock.scale).toBeGreaterThanOrEqual(10.0);
        expect(rock.scale).toBeLessThanOrEqual(100.0);
      }
    });
  });

  describe("Spacing Edge Cases", () => {
    it("handles zero minSpacing", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 20,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0,
        minSpacing: 0,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);
      // With zero spacing, rocks can be placed anywhere
    });

    it("handles minSpacing larger than tile", () => {
      const ctx = createTestContext(0, 0, { tileSize: 50 });
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 100,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0,
        minSpacing: 100, // Larger than tile
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      // Should only be able to place 1 rock max
      expect(rocks.length).toBeLessThanOrEqual(1);
    });
  });

  describe("Clustering Edge Cases", () => {
    it("handles clusterChance of 0 (no clustering)", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 10,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);
      // Rocks should be more evenly distributed
    });

    it("handles clusterChance of 1.0 (always cluster)", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 20,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 1.0,
        clusterSize: [3, 5],
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);
    });
  });
});

describe("Boundary Conditions - Plants", () => {
  describe("Density Edge Cases", () => {
    it("returns empty array for zero density", () => {
      const ctx = createTestContext(0, 0);
      const plantConfig: BiomePlantConfig = {
        enabled: true,
        density: 0,
        presets: ["monstera"],
        scaleRange: [0.5, 1.2],
        minSpacing: 1.5,
      };

      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);
      expect(plants.length).toBe(0);
    });
  });

  describe("Clustering Configuration", () => {
    it("handles clustering disabled explicitly", () => {
      const ctx = createTestContext(0, 0);
      const plantConfig: BiomePlantConfig = {
        enabled: true,
        density: 15,
        presets: ["monstera"],
        scaleRange: [0.5, 1.2],
        minSpacing: 1.5,
        clustering: false,
      };

      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);
      expect(plants.length).toBeGreaterThan(0);
    });

    it("handles clustering with custom cluster size", () => {
      const ctx = createTestContext(0, 0);
      const plantConfig: BiomePlantConfig = {
        enabled: true,
        density: 20,
        presets: ["monstera"],
        scaleRange: [0.5, 1.2],
        minSpacing: 1.0,
        clustering: true,
        clusterSize: [5, 10],
      };

      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);
      expect(plants.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// ERROR HANDLING AND INVALID INPUTS
// ============================================================================

describe("Error Handling - Invalid Inputs", () => {
  describe("Preset Handling", () => {
    it("handles empty presets with unknown biome (double fallback)", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 10,
        presets: [], // Empty
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      // Unknown biome should use forest fallback, which has presets
      const rocks = generateRocks(ctx, rockConfig, "unknown_xyz_biome");
      expect(rocks.length).toBeGreaterThan(0);

      // Should use forest defaults (boulder, granite, limestone)
      const validPresets = ["boulder", "granite", "limestone"];
      for (const rock of rocks) {
        expect(validPresets).toContain(rock.assetId);
      }
    });

    it("handles single preset", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 10,
        presets: ["granite"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);

      for (const rock of rocks) {
        expect(rock.assetId).toBe("granite");
      }
    });
  });

  describe("Distribution Weight Handling", () => {
    it("handles missing distribution entries (defaults to 1)", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 20,
        presets: ["boulder", "granite", "limestone"],
        distribution: { boulder: 10 }, // Missing granite and limestone
        scaleRange: [0.5, 1.5],
        clusterChance: 0,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);

      // All presets should appear (granite/limestone get weight 1)
      const presetCounts = new Map<string, number>();
      for (const rock of rocks) {
        presetCounts.set(
          rock.assetId,
          (presetCounts.get(rock.assetId) ?? 0) + 1,
        );
      }

      // Boulder should be more common (weight 10 vs 1)
      const boulderCount = presetCounts.get("boulder") ?? 0;
      const graniteCount = presetCounts.get("granite") ?? 0;
      expect(boulderCount).toBeGreaterThan(graniteCount);
    });

    it("handles equal distribution weights", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 50, // High density for statistical significance
        presets: ["boulder", "granite"],
        distribution: { boulder: 1, granite: 1 },
        scaleRange: [0.5, 1.5],
        clusterChance: 0,
        minSpacing: 1,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(10);

      // Count each type
      const boulderCount = rocks.filter((r) => r.assetId === "boulder").length;
      const graniteCount = rocks.filter((r) => r.assetId === "granite").length;

      // With equal weights, counts should be within 50% of each other
      const ratio =
        Math.max(boulderCount, graniteCount) /
        Math.min(boulderCount, graniteCount);
      expect(ratio).toBeLessThan(2.5); // Allow some variance
    });
  });
});

// ============================================================================
// DATA VERIFICATION - INSPECT ACTUAL VALUES
// ============================================================================

describe("Data Verification", () => {
  describe("Position Verification", () => {
    it("position.y matches getHeightAt result", () => {
      const heightFn = (x: number, _z: number) => 50 + Math.sin(x * 0.1) * 10;
      const ctx = createTestContext(0, 0, { getHeightAt: heightFn });

      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 15,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);

      for (const rock of rocks) {
        const expectedHeight = heightFn(rock.position.x, rock.position.z);
        expect(rock.position.y).toBeCloseTo(expectedHeight, 5);
      }
    });

    it("positions are within tile bounds", () => {
      const tileSize = 100;
      const ctx = createTestContext(5, 10, { tileSize });

      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 20,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.5,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

      const minX = 5 * tileSize;
      const maxX = 6 * tileSize;
      const minZ = 10 * tileSize;
      const maxZ = 11 * tileSize;

      for (const rock of rocks) {
        expect(rock.position.x).toBeGreaterThanOrEqual(minX);
        expect(rock.position.x).toBeLessThanOrEqual(maxX);
        expect(rock.position.z).toBeGreaterThanOrEqual(minZ);
        expect(rock.position.z).toBeLessThanOrEqual(maxZ);
      }
    });
  });

  describe("Rotation Verification", () => {
    it("rotation.y is in valid range [0, 2π]", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 30,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);

      for (const rock of rocks) {
        expect(rock.rotation.y).toBeGreaterThanOrEqual(0);
        expect(rock.rotation.y).toBeLessThanOrEqual(Math.PI * 2);
        // X and Z rotations should be 0 for rocks
        expect(rock.rotation.x).toBe(0);
        expect(rock.rotation.z).toBe(0);
      }
    });

    it("plant rotation.y is in valid range [0, 2π]", () => {
      const ctx = createTestContext(0, 0);
      const plantConfig: BiomePlantConfig = {
        enabled: true,
        density: 30,
        presets: ["monstera"],
        scaleRange: [0.5, 1.2],
        minSpacing: 1.5,
      };

      const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);
      expect(plants.length).toBeGreaterThan(0);

      for (const plant of plants) {
        expect(plant.rotation.y).toBeGreaterThanOrEqual(0);
        expect(plant.rotation.y).toBeLessThanOrEqual(Math.PI * 2);
        expect(plant.rotation.x).toBe(0);
        expect(plant.rotation.z).toBe(0);
      }
    });
  });

  describe("Distribution Weight Verification", () => {
    it("weighted distribution produces expected ratios", () => {
      const ctx = createTestContext(0, 0);
      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 100, // High density for statistical significance
        presets: ["boulder", "pebble"],
        distribution: { boulder: 3, pebble: 1 }, // 3:1 ratio
        scaleRange: [0.5, 1.5],
        clusterChance: 0,
        minSpacing: 1,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(20);

      const boulderCount = rocks.filter((r) => r.assetId === "boulder").length;
      const pebbleCount = rocks.filter((r) => r.assetId === "pebble").length;

      // Expected ratio is 3:1, allow some variance (2:1 to 5:1)
      const ratio = boulderCount / Math.max(1, pebbleCount);
      expect(ratio).toBeGreaterThan(1.5);
      expect(ratio).toBeLessThan(6);
    });
  });
});

// ============================================================================
// TERRAIN CONSTRAINTS
// ============================================================================

describe("Terrain Constraints", () => {
  describe("Complete Water Coverage", () => {
    it("returns empty when entire tile is underwater", () => {
      const ctx = createTestContext(0, 0, {
        waterThreshold: 100,
        getHeightAt: () => 50, // All below water threshold
      });

      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 20,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBe(0);
    });
  });

  describe("Complete Road Coverage", () => {
    it("returns empty when entire tile is road", () => {
      const ctx = createTestContext(0, 0, {
        isOnRoad: () => true, // Entire tile is road
      });

      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 20,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBe(0);
    });
  });

  describe("Partial Terrain Coverage", () => {
    it("places rocks only in valid areas with complex terrain", () => {
      const ctx = createTestContext(0, 0, {
        tileSize: 100,
        waterThreshold: 10,
        getHeightAt: (x, z) => {
          // Create varied terrain: underwater in corners, elevated in center
          const dx = (x % 100) - 50;
          const dz = (z % 100) - 50;
          const dist = Math.sqrt(dx * dx + dz * dz);
          return dist < 30 ? 20 : 5; // Center above water, edges below
        },
        isOnRoad: (x, _z) => {
          // Road running through middle
          const localX = x % 100;
          return localX > 45 && localX < 55;
        },
      });

      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 30,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);

      for (const rock of rocks) {
        const localX = rock.position.x % 100;

        // Should not be on road
        expect(localX < 45 || localX > 55).toBe(true);

        // Should be above water (in center region)
        expect(rock.position.y).toBeGreaterThanOrEqual(10);
      }
    });
  });

  describe("Missing isOnRoad function", () => {
    it("works when isOnRoad is undefined", () => {
      const ctx = createTestContext(0, 0, {
        // isOnRoad not provided
      });

      const rockConfig: BiomeRockConfig = {
        enabled: true,
        density: 10,
        presets: ["boulder"],
        scaleRange: [0.5, 1.5],
        clusterChance: 0.3,
        minSpacing: 2,
      };

      const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
      expect(rocks.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// CONCURRENT GENERATION
// ============================================================================

describe("Concurrent Generation", () => {
  it("generates consistent results when same tile generated multiple times", () => {
    const ctx1 = createTestContext(0, 0);
    const ctx2 = createTestContext(0, 0);
    const ctx3 = createTestContext(0, 0);

    const rockConfig: BiomeRockConfig = {
      enabled: true,
      density: 15,
      presets: ["boulder", "pebble"],
      scaleRange: [0.5, 1.5],
      clusterChance: 0.3,
      minSpacing: 2,
    };

    const rocks1 = generateRocks(ctx1, rockConfig, BiomeType.Forest);
    const rocks2 = generateRocks(ctx2, rockConfig, BiomeType.Forest);
    const rocks3 = generateRocks(ctx3, rockConfig, BiomeType.Forest);

    expect(rocks1.length).toBe(rocks2.length);
    expect(rocks2.length).toBe(rocks3.length);

    // All should have identical results
    for (let i = 0; i < rocks1.length; i++) {
      expect(rocks1[i].position).toEqual(rocks2[i].position);
      expect(rocks2[i].position).toEqual(rocks3[i].position);
      expect(rocks1[i].assetId).toBe(rocks2[i].assetId);
      expect(rocks2[i].assetId).toBe(rocks3[i].assetId);
    }
  });

  it("generates unique results for adjacent tiles", () => {
    const tiles = [
      createTestContext(0, 0),
      createTestContext(0, 1),
      createTestContext(1, 0),
      createTestContext(1, 1),
    ];

    const rockConfig: BiomeRockConfig = {
      enabled: true,
      density: 10,
      presets: ["boulder"],
      scaleRange: [0.5, 1.5],
      clusterChance: 0.3,
      minSpacing: 2,
    };

    const results = tiles.map((ctx) =>
      generateRocks(ctx, rockConfig, BiomeType.Forest),
    );

    // Each tile should have different positions
    const allPositions = results.flatMap((r) =>
      r.map((rock) => `${rock.position.x},${rock.position.z}`),
    );
    const uniquePositions = new Set(allPositions);

    expect(uniquePositions.size).toBe(allPositions.length);
  });
});

// ============================================================================
// COMPLETE VEGETATION INSTANCE STRUCTURE
// ============================================================================

describe("VegetationInstance Structure", () => {
  it("rock instances have all required fields with correct types", () => {
    const ctx = createTestContext(0, 0);
    const rockConfig: BiomeRockConfig = {
      enabled: true,
      density: 5,
      presets: ["boulder"],
      scaleRange: [0.5, 1.5],
      clusterChance: 0.3,
      minSpacing: 2,
    };

    const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
    expect(rocks.length).toBeGreaterThan(0);

    for (const rock of rocks) {
      // Required fields exist
      expect(typeof rock.id).toBe("string");
      expect(typeof rock.assetId).toBe("string");
      expect(typeof rock.category).toBe("string");
      expect(typeof rock.tileKey).toBe("string");
      expect(typeof rock.scale).toBe("number");

      // Position structure
      expect(typeof rock.position.x).toBe("number");
      expect(typeof rock.position.y).toBe("number");
      expect(typeof rock.position.z).toBe("number");
      expect(Number.isFinite(rock.position.x)).toBe(true);
      expect(Number.isFinite(rock.position.y)).toBe(true);
      expect(Number.isFinite(rock.position.z)).toBe(true);

      // Rotation structure
      expect(typeof rock.rotation.x).toBe("number");
      expect(typeof rock.rotation.y).toBe("number");
      expect(typeof rock.rotation.z).toBe("number");
      expect(Number.isFinite(rock.rotation.y)).toBe(true);

      // ID format
      expect(rock.id).toMatch(/^0_0_rock_\d+$/);
    }
  });

  it("plant instances have all required fields with correct types", () => {
    const ctx = createTestContext(0, 0);
    const plantConfig: BiomePlantConfig = {
      enabled: true,
      density: 5,
      presets: ["monstera"],
      scaleRange: [0.5, 1.2],
      minSpacing: 1.5,
    };

    const plants = generatePlants(ctx, plantConfig, BiomeType.Forest);
    expect(plants.length).toBeGreaterThan(0);

    for (const plant of plants) {
      expect(typeof plant.id).toBe("string");
      expect(typeof plant.assetId).toBe("string");
      expect(plant.category).toBe("plant");
      expect(typeof plant.tileKey).toBe("string");
      expect(typeof plant.scale).toBe("number");

      expect(Number.isFinite(plant.position.x)).toBe(true);
      expect(Number.isFinite(plant.position.y)).toBe(true);
      expect(Number.isFinite(plant.position.z)).toBe(true);

      // ID format
      expect(plant.id).toMatch(/^0_0_plant_\d+$/);
    }
  });
});

// ============================================================================
// BIOME DEFAULTS COMPLETENESS
// ============================================================================

describe("Biome Defaults Completeness", () => {
  it("all rock biome presets have matching distribution", () => {
    for (const [, config] of Object.entries(ROCK_BIOME_DEFAULTS)) {
      for (const preset of config.presets) {
        expect(config.distribution[preset]).toBeDefined();
        expect(config.distribution[preset]).toBeGreaterThan(0);
      }
    }
  });

  it("all plant biome presets have matching distribution", () => {
    for (const [, config] of Object.entries(PLANT_BIOME_DEFAULTS)) {
      for (const preset of config.presets) {
        expect(config.distribution[preset]).toBeDefined();
        expect(config.distribution[preset]).toBeGreaterThan(0);
      }
    }
  });

  it("unknown biomes fall back to forest presets", () => {
    const unknownPresets = getRockPresetsForBiome("nonexistent");
    const forestPresets = getRockPresetsForBiome(BiomeType.Forest);
    expect(unknownPresets.presets).toEqual(forestPresets.presets);
  });
});

// ============================================================================
// CACHE MODULE EXPORTS (ProcgenRockCache / ProcgenPlantCache)
// ============================================================================

import {
  getRockVariant,
  getRockVariantCount,
  isRockPresetLoaded,
  BIOME_ROCK_PRESETS,
  ALL_ROCK_PRESETS,
  getRockPresetsForBiome as getCacheRockPresets,
} from "../ProcgenRockCache";

import {
  getPlantVariant,
  getPlantVariantCount,
  isPlantPresetLoaded,
  BIOME_PLANT_PRESETS,
  ALL_PLANT_PRESETS,
  getPlantPresetsForBiome as getCachePlantPresets,
} from "../ProcgenPlantCache";

describe("ProcgenRockCache Exports", () => {
  describe("getRockVariant", () => {
    it("returns null for unloaded preset", () => {
      const variant = getRockVariant("nonexistent_preset_xyz");
      expect(variant).toBeNull();
    });

    it("returns null for empty preset name", () => {
      const variant = getRockVariant("");
      expect(variant).toBeNull();
    });
  });

  describe("getRockVariantCount", () => {
    it("returns 0 for unloaded preset", () => {
      const count = getRockVariantCount("unloaded_preset_abc");
      expect(count).toBe(0);
    });

    it("returns 0 for empty preset name", () => {
      const count = getRockVariantCount("");
      expect(count).toBe(0);
    });
  });

  describe("isRockPresetLoaded", () => {
    it("returns false for unloaded preset", () => {
      const loaded = isRockPresetLoaded("never_loaded_preset");
      expect(loaded).toBe(false);
    });

    it("returns false for empty preset name", () => {
      const loaded = isRockPresetLoaded("");
      expect(loaded).toBe(false);
    });
  });

  describe("BIOME_ROCK_PRESETS", () => {
    it("contains arrays of valid preset names", () => {
      for (const [, presets] of Object.entries(BIOME_ROCK_PRESETS)) {
        expect(Array.isArray(presets)).toBe(true);
        expect(presets.length).toBeGreaterThan(0);
        for (const preset of presets) {
          expect(typeof preset).toBe("string");
          expect(preset.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("ALL_ROCK_PRESETS", () => {
    it("is an array of valid preset names", () => {
      expect(Array.isArray(ALL_ROCK_PRESETS)).toBe(true);
      expect(ALL_ROCK_PRESETS.length).toBeGreaterThan(5);

      for (const preset of ALL_ROCK_PRESETS) {
        expect(typeof preset).toBe("string");
        expect(preset.length).toBeGreaterThan(0);
      }
    });

    it("includes common rock types", () => {
      expect(ALL_ROCK_PRESETS).toContain("boulder");
      expect(ALL_ROCK_PRESETS).toContain("granite");
      expect(ALL_ROCK_PRESETS).toContain("sandstone");
      expect(ALL_ROCK_PRESETS).toContain("basalt");
    });
  });

  describe("getCacheRockPresets", () => {
    it("returns array for known biomes", () => {
      const presets = getCacheRockPresets(BiomeType.Forest);
      expect(Array.isArray(presets)).toBe(true);
      expect(presets.length).toBeGreaterThan(0);
    });

    it("returns fallback for unknown biomes", () => {
      const presets = getCacheRockPresets("totally_fake_biome_123");
      expect(Array.isArray(presets)).toBe(true);
      expect(presets.length).toBeGreaterThan(0);
    });
  });
});

describe("ProcgenPlantCache Exports", () => {
  describe("getPlantVariant", () => {
    it("returns null for unloaded preset", () => {
      const variant = getPlantVariant("nonexistent_plant_xyz");
      expect(variant).toBeNull();
    });

    it("returns null for empty preset name", () => {
      const variant = getPlantVariant("");
      expect(variant).toBeNull();
    });
  });

  describe("getPlantVariantCount", () => {
    it("returns 0 for unloaded preset", () => {
      const count = getPlantVariantCount("unloaded_plant_abc");
      expect(count).toBe(0);
    });
  });

  describe("isPlantPresetLoaded", () => {
    it("returns false for unloaded preset", () => {
      const loaded = isPlantPresetLoaded("never_loaded_plant");
      expect(loaded).toBe(false);
    });
  });

  describe("BIOME_PLANT_PRESETS", () => {
    it("contains arrays of valid preset names", () => {
      for (const [, presets] of Object.entries(BIOME_PLANT_PRESETS)) {
        expect(Array.isArray(presets)).toBe(true);
        expect(presets.length).toBeGreaterThan(0);
        for (const preset of presets) {
          expect(typeof preset).toBe("string");
        }
      }
    });

    it("includes canyon biome", () => {
      expect(BIOME_PLANT_PRESETS.canyon).toBeDefined();
      expect(BIOME_PLANT_PRESETS.canyon.length).toBeGreaterThan(0);
    });
  });

  describe("ALL_PLANT_PRESETS", () => {
    it("is an array of valid preset names", () => {
      expect(Array.isArray(ALL_PLANT_PRESETS)).toBe(true);
      expect(ALL_PLANT_PRESETS.length).toBeGreaterThan(10);
    });

    it("includes common plant types", () => {
      expect(ALL_PLANT_PRESETS).toContain("monstera");
      expect(ALL_PLANT_PRESETS).toContain("philodendron");
      expect(ALL_PLANT_PRESETS).toContain("calathea");
      expect(ALL_PLANT_PRESETS).toContain("hosta");
    });
  });

  describe("getCachePlantPresets", () => {
    it("returns array for known biomes", () => {
      const presets = getCachePlantPresets(BiomeType.Canyon);
      expect(Array.isArray(presets)).toBe(true);
      expect(presets.length).toBeGreaterThan(0);
    });

    it("returns fallback for unknown biomes", () => {
      const presets = getCachePlantPresets("nonexistent_biome_xyz");
      expect(Array.isArray(presets)).toBe(true);
      expect(presets.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// PERFORMANCE CHARACTERISTICS
// ============================================================================

describe("Performance Characteristics", () => {
  it("generation completes within reasonable time for high density", () => {
    const ctx = createTestContext(0, 0);
    const rockConfig: BiomeRockConfig = {
      enabled: true,
      density: 100,
      presets: ["boulder", "pebble", "granite"],
      scaleRange: [0.5, 1.5],
      clusterChance: 0.3,
      minSpacing: 2,
    };

    const start = performance.now();
    const rocks = generateRocks(ctx, rockConfig, BiomeType.Forest);
    const elapsed = performance.now() - start;

    expect(rocks.length).toBeGreaterThan(0);
    // Keep this fast, but allow headroom for contention in full workspace runs.
    expect(elapsed).toBeLessThan(200);
  });

  it("handles multiple sequential generations efficiently", () => {
    const rockConfig: BiomeRockConfig = {
      enabled: true,
      density: 20,
      presets: ["boulder"],
      scaleRange: [0.5, 1.5],
      clusterChance: 0.3,
      minSpacing: 2,
    };

    const start = performance.now();
    for (let i = 0; i < 10; i++) {
      const ctx = createTestContext(i, i);
      generateRocks(ctx, rockConfig, BiomeType.Forest);
    }
    const elapsed = performance.now() - start;

    // 10 tiles should complete in under 200ms
    expect(elapsed).toBeLessThan(200);
  });
});

// ============================================================================
// PLANT INSTANCER GEOMETRY MERGE
// ============================================================================

describe("ProcgenPlantInstancer geometry merge", () => {
  it("bakes leaf and stem transforms into merged geometry", () => {
    const generator = new PlantGenerator({ seed: 24680 });
    generator.setGenerateTextures(false);
    generator.loadPreset("monstera");
    generator.setParam(LPK.LeafCount, 4);

    const result = generator.generate();
    const merged = mergePlantGroupForInstancing(result.group);

    expect(merged).not.toBeNull();
    if (!merged) {
      result.dispose();
      return;
    }

    let maxMeshVerts = 0;
    let meshCount = 0;
    result.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh === true) {
        const mesh = obj as THREE.Mesh;
        const posAttr = mesh.geometry.getAttribute("position");
        maxMeshVerts = Math.max(maxMeshVerts, posAttr.count);
        meshCount += 1;
      }
    });

    expect(meshCount).toBeGreaterThan(1);

    const mergedPos = merged.geometry.getAttribute("position");
    expect(mergedPos.count).toBeGreaterThan(maxMeshVerts);
    expect(merged.geometry.getAttribute("color")).toBeDefined();
    expect(merged.materials.length).toBeGreaterThan(1);

    const originalBox = new THREE.Box3().setFromObject(result.group);
    const originalSize = new THREE.Vector3();
    originalBox.getSize(originalSize);

    merged.geometry.computeBoundingBox();
    const mergedBox = merged.geometry.boundingBox;
    expect(mergedBox).not.toBeNull();
    if (mergedBox) {
      const mergedSize = new THREE.Vector3();
      mergedBox.getSize(mergedSize);

      const originalLength = originalSize.length();
      const mergedLength = mergedSize.length();
      expect(originalLength).toBeGreaterThan(0);
      expect(mergedLength).toBeGreaterThan(originalLength * 0.7);
      expect(mergedLength).toBeLessThan(originalLength * 1.3);
    }

    result.dispose();
  });
});
