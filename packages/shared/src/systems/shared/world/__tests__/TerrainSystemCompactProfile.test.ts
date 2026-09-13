import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { TerrainSystem } from "../TerrainSystem";
import type { GrassWorkerSetup } from "../GrassVisualManager";
import type { FullTerrainProvider } from "../TerrainQuadChunkGenerator";
import { loadTownConfig } from "../TownSystem";
import { loadPOIConfig } from "../POISystem";
import {
  HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";

type Internals = {
  initializeTerrainGenerator(): void;
  buildGrassWorkerSetup(): GrassWorkerSetup;
  buildChunkTerrainProvider(): FullTerrainProvider;
  getIslandMask(x: number, z: number): number;
};

const originalSeed = process.env.TERRAIN_SEED;
afterEach(() => {
  if (originalSeed === undefined) delete process.env.TERRAIN_SEED;
  else process.env.TERRAIN_SEED = originalSeed;
});

function createTerrain(seed?: number) {
  const world = new World();
  if (seed !== undefined)
    Object.assign(world, { config: { terrainSeed: seed } });
  const terrain = new TerrainSystem(world);
  const internals = terrain as unknown as Internals;
  internals.initializeTerrainGenerator();
  return { terrain, internals };
}

describe("real manifest to compact TerrainSystem integration", () => {
  it("installs admitted height and biome sampling before yielding an already-ready init wave", async () => {
    expect(DataManager.getInstance().isReady()).toBe(true);
    const terrain = new TerrainSystem(new World());
    const initialization = terrain.init();
    try {
      // Deliberately sample synchronously, as another init-wave consumer can.
      // No manually initialized private generator may conceal this ordering bug.
      const beforeAwait = terrain.getHeightAt(350, 320);
      const weights = terrain.computeBiomeWeightsByPosition(350, 320);
      expect(Number.isFinite(beforeAwait)).toBe(true);
      expect(Object.keys(weights).length).toBeGreaterThan(0);
      await initialization;
      expect(terrain.getHeightAt(350, 320)).toBe(beforeAwait);
      expect(terrain.computeBiomeWeightsByPosition(350, 320)).toEqual(weights);
    } finally {
      await initialization;
      terrain.destroy();
    }
  });

  it("selects the explicit actual profile and reports its translated envelope and content hash", () => {
    const { terrain } = createTerrain();
    expect(DataManager.getInstance().isReady()).toBe(true);
    expect(terrain.getWorldTerrainProfile()).toEqual(
      HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
    );
    const profile = terrain.getWorldTerrainProfile();
    expect(terrain.getWorldTerrainProfile()).toBe(profile);
    expect(terrain.tileSize).toBe(profile.terrainTileSize);
    expect(terrain.getTerrainStats()).toMatchObject({
      terrainProfileId: profile.id,
      worldContentIdentity: DataManager.getWorldContentIdentity(),
      worldSize: "4x4",
      worldBounds: { min: { x: 150, z: 200 }, max: { x: 550, z: 600 } },
    });
    expect(DataManager.getWorldContentIdentity()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses profile-centered biome placement and matching sync and grass-worker configuration", () => {
    const { terrain, internals } = createTerrain();
    const profile = terrain.getWorldTerrainProfile();
    const worker = internals.buildGrassWorkerSetup();
    const sync = internals.buildChunkTerrainProvider();
    expect(worker.terrainConfig.TERRAIN_PROFILE).toEqual(profile);
    expect(worker.terrainConfig.TERRAIN_PROFILE_IDENTITY).toBe(
      sync.terrainProfileIdentity,
    );
    expect(sync.terrainProfileIdentity).toBe(
      worldTerrainProfileIdentity(profile),
    );
    expect(worker.seed).toBe(profile.seed);
    expect(worker.tileSize).toBe(profile.terrainTileSize);
    expect(sync.MAX_HEIGHT).toBe(profile.height.maxHeightParameter);
    expect(sync.WATER_LEVEL_NORMALIZED).toBe(
      profile.water.threshold / profile.height.maxHeightParameter,
    );
    expect(worker.biomeCenters).toHaveLength(1);
    expect(worker.biomeCenters[0].type).toBe("forest");
    for (const [x, z] of [
      [350, 320],
      [343, 302],
      [368, 419],
      [250, 400],
    ]) {
      expect(terrain.computeBiomeWeightsByPosition(x, z)).toEqual({
        forest: 1,
      });
    }
    for (const center of worker.biomeCenters) {
      expect(
        Math.hypot(
          center.x - profile.island.centerX,
          center.z - profile.island.centerZ,
        ),
      ).toBeCloseTo(profile.island.radius * 0.45, 10);
      expect(center.influence).toBe(profile.island.radius * 0.6);
    }
  });

  it("has ocean floor beyond the bounded compact coast, not the former origin-centered landmass", () => {
    const { terrain, internals } = createTerrain();
    const profile = terrain.getWorldTerrainProfile();
    expect(
      internals.getIslandMask(profile.island.centerX, profile.island.centerZ),
    ).toBe(1);
    expect(terrain.getProceduralHeightAt(0, 0)).toBe(
      profile.water.oceanFloorHeight,
    );
    const radius =
      profile.island.radius * (1 + profile.island.maxCoastVariation) + 1;
    for (let i = 0; i < 64; i++) {
      const angle = (i * Math.PI) / 32;
      const x = profile.island.centerX + Math.cos(angle) * radius;
      const z = profile.island.centerZ + Math.sin(angle) * radius;
      expect(internals.getIslandMask(x, z)).toBe(0);
      expect(terrain.getProceduralHeightAt(x, z)).toBe(
        profile.water.oceanFloorHeight,
      );
    }
  });

  it("keeps each actual area and authored interaction target inside the compact envelope", () => {
    const { bounds } = DataManager.getWorldTerrainProfile();
    expect(Object.keys(ALL_WORLD_AREAS).sort()).toEqual([
      "central_haven",
      "duel_arena",
      "haven_pond",
      "preparation_training_grounds",
    ]);
    for (const area of Object.values(ALL_WORLD_AREAS)) {
      expect(area.bounds.minX).toBeGreaterThanOrEqual(bounds.minX);
      expect(area.bounds.maxX).toBeLessThanOrEqual(bounds.maxX);
      expect(area.bounds.minZ).toBeGreaterThanOrEqual(bounds.minZ);
      expect(area.bounds.maxZ).toBeLessThanOrEqual(bounds.maxZ);
      for (const entry of [
        ...(area.npcs ?? []),
        ...(area.stations ?? []),
        ...(area.resources ?? []),
        ...(area.mobSpawns ?? []),
      ]) {
        expect(entry.position.x).toBeGreaterThanOrEqual(bounds.minX);
        expect(entry.position.x).toBeLessThanOrEqual(bounds.maxX);
        expect(entry.position.z).toBeGreaterThanOrEqual(bounds.minZ);
        expect(entry.position.z).toBeLessThanOrEqual(bounds.maxZ);
      }
    }
    expect(loadTownConfig()).toMatchObject({ townCount: 0, worldSize: 400 });
    expect(
      Object.values(loadPOIConfig().countPerCategory).every(
        (count) => count === 0,
      ),
    ).toBe(true);
  });

  it("rejects conflicting and malformed overrides instead of generating a second world", () => {
    const seed = DataManager.getWorldTerrainProfile().seed;
    delete process.env.TERRAIN_SEED;
    expect(() => createTerrain(seed + 1)).toThrow("terrainSeed conflicts");
    for (const value of [
      "0oops",
      "-1",
      "1.0",
      "NaN",
      "4294967296",
      String(seed + 1),
    ]) {
      process.env.TERRAIN_SEED = value;
      expect(() => createTerrain()).toThrow("TERRAIN_SEED conflicts");
    }
    process.env.TERRAIN_SEED = String(seed);
    expect(createTerrain(seed).terrain.getWorldTerrainProfile().seed).toBe(
      seed,
    );
  });
});
