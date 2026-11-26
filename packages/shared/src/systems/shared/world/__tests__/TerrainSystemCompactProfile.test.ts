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
  COMPACT_WORLD_TERRAIN_PROFILE,
  HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
  resolveWorldTerrainProfile,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";

type Internals = {
  initializeTerrainGenerator(): void;
  buildGrassWorkerSetup(): GrassWorkerSetup;
  buildChunkTerrainProvider(): FullTerrainProvider;
  getIslandMask(x: number, z: number): number;
};

const originalSeed = process.env.TERRAIN_SEED;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (originalSeed === undefined) delete process.env.TERRAIN_SEED;
  else process.env.TERRAIN_SEED = originalSeed;
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
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
  const rockSamplingDependencies =
    "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1&rockProjection=stochastic-v1&dirtProjection=stochastic-v1&terrainBlend=height-v1&pondBlend=composition-v1";

  it.each([false, true])(
    "captures exact-zero sampling and absence until a fresh terrain owner (selected=%s)",
    async (selected) => {
      await DataManager.getInstance().initialize();
      const location = new URL(
        `https://localhost/stream.html?${rockSamplingDependencies}${selected ? "&rockSampling=exact-zero-v1" : ""}`,
      );
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location },
      });
      const world = new World(),
        terrain = new TerrainSystem(world);
      const nextWorld = new World(),
        next = new TerrainSystem(nextWorld);
      const identity = DataManager.getWorldContentIdentity();
      try {
        terrain["initializeTerrainGenerator"]();
        const profile = terrain.getWorldTerrainProfile();
        const height = terrain.getHeightAt(350, 320);
        expect(terrain["getCompactRockSampling"]()).toBe(
          selected ? "exact-zero-v1" : undefined,
        );
        expect(terrain["compactRockSampling"]).toBe(
          selected ? "exact-zero-v1" : null,
        );
        location.search = `?${rockSamplingDependencies}${selected ? "" : "&rockSampling=exact-zero-v1"}`;
        expect(terrain["getCompactRockSampling"]()).toBe(
          selected ? "exact-zero-v1" : undefined,
        );
        expect(next["getCompactRockSampling"]()).toBe(
          selected ? undefined : "exact-zero-v1",
        );
        location.search += "&rockSampling=invalid";
        expect(terrain["getCompactRockSampling"]()).toBe(
          selected ? "exact-zero-v1" : undefined,
        );
        expect(next["getCompactRockSampling"]()).toBe(
          selected ? undefined : "exact-zero-v1",
        );
        expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
        expect(terrain.getWorldTerrainProfile()).toBe(profile);
        expect(terrain.getHeightAt(350, 320)).toBe(height);
        expect(DataManager.getWorldContentIdentity()).toBe(identity);
      } finally {
        next.destroy();
        nextWorld.destroy();
        terrain.destroy();
        world.destroy();
      }
    },
  );

  it.each([
    ["compactDirtProjection", "getCompactDirtProjection", "dirtProjection"],
    ["compactRockProjection", "getCompactRockProjection", "rockProjection"],
    ["compactSurfaceBlend", "getCompactSurfaceBlend", "terrainBlend"],
    ["compactPondBlend", "getCompactPondBlend", "pondBlend"],
  ] as const)(
    "refuses a newly selected sampler when %s was already captured absent",
    async (_field, getter, parameter) => {
      await DataManager.getInstance().initialize();
      const location = new URL(
        `https://localhost/stream.html?${rockSamplingDependencies}`,
      );
      location.searchParams.delete(parameter);
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location },
      });
      const world = new World(),
        terrain = new TerrainSystem(world);
      try {
        expect(terrain[getter]()).toBeUndefined();
        location.search = `?${rockSamplingDependencies}&rockSampling=exact-zero-v1`;
        expect(() => terrain["getCompactRockSampling"]()).toThrow(
          "compatible captured material selections",
        );
        expect(terrain["compactRockSampling"]).toBeUndefined();
        expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
      } finally {
        terrain.destroy();
        world.destroy();
      }
    },
  );

  it("rejects invalid sampling before material, water or grass publication", async () => {
    const location = new URL(
      `https://localhost/stream.html?${rockSamplingDependencies}&rockSampling=invalid`,
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location },
    });
    const world = new World(),
      terrain = new TerrainSystem(world);
    try {
      await expect(terrain.init()).rejects.toThrow("rock sampling candidate");
      expect(terrain["compactRockSampling"]).toBeUndefined();
      expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
      expect(terrain["waterSystem"]).toBeUndefined();
      expect(terrain["grassVisualManager"]).toBeNull();
      expect(terrain["canonicalGroundInitialized"]).toBe(false);
    } finally {
      terrain.destroy();
      world.destroy();
    }
  });

  it("rejects sampling on legacy terrain and leaves server omission unselected", async () => {
    await DataManager.getInstance().initialize();
    Reflect.deleteProperty(globalThis, "window");
    const world = new World(),
      terrain = new TerrainSystem(world);
    try {
      expect(terrain["getCompactRockSampling"]()).toBeUndefined();
      expect(terrain["compactRockSampling"]).toBeNull();
    } finally {
      terrain.destroy();
      world.destroy();
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: new URL(
          `https://localhost/stream.html?${rockSamplingDependencies}&rockSampling=exact-zero-v1`,
        ),
      },
    });
    const legacyWorld = new World(),
      legacy = new TerrainSystem(legacyWorld);
    try {
      legacy["activeTerrainProfile"] = resolveWorldTerrainProfile(
        COMPACT_WORLD_TERRAIN_PROFILE,
      );
      expect(() => legacy["getCompactRockSampling"]()).toThrow(
        "compact sculpt terrain",
      );
      expect(legacy["compactRockSampling"]).toBeUndefined();
      expect(legacy.getTerrainMaterialWithUniforms()).toBeNull();
    } finally {
      legacy.destroy();
      legacyWorld.destroy();
    }
  });

  it.each([false, true])(
    "binds composition before material creation and publishes identical registered owners to grass (exact-zero sampling=%s)",
    async (rockSampling) => {
      await DataManager.getInstance().initialize();
      if (rockSampling)
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: {
            location: new URL(
              `https://localhost/stream.html?${rockSamplingDependencies}&rockSampling=exact-zero-v1`,
            ),
          },
        });
      const area = ALL_WORLD_AREAS.haven_pond;
      const originalZones = area.flatZones;
      const original = originalZones?.find(
        (zone) => zone.id === "haven_pond_floor",
      );
      if (!original?.radialPond)
        throw new Error("Actual Haven profile required");
      const selected = {
        ...original,
        radialPond: {
          ...original.radialPond,
          bankSectors: [
            {
              bearing: -1.5,
              halfWidth: 0.7,
              innerRadius: 6.8,
              innerHeight: 28.08,
              outerRadius: 8.7,
              outerHeight: 28.24,
            },
          ],
          bankComposition: {
            schemaVersion: 1 as const,
            sectors: [{ sectorIndex: 0, surface: "sedge-shelf" as const }],
          },
        },
      };
      area.flatZones = originalZones!.map((zone) =>
        zone === original ? selected : zone,
      );
      const world = new World();
      const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
      terrain["activeTerrainProfile"] = resolveWorldTerrainProfile({
        ...DataManager.getWorldTerrainProfile(),
        southernMeadow: {
          schemaVersion: 1,
          minX: 304,
          maxX: 500,
          minZ: 345,
          maxZ: 535,
          featherX: 24,
          featherZ: 24,
          northHeight: 26.8,
          southHeight: 25.3,
          crossFall: 1,
          rollAmplitude: 0.65,
          rollWavelength: 100,
        },
      });
      terrain["compactPondBlend"] = "composition-v1";
      terrain["compactSurfaceBlend"] = "height-v1";
      terrain["compactDirtProjection"] = "stochastic-v1";
      terrain["compactRockProjection"] = "stochastic-v1";
      try {
        if (rockSampling) {
          expect(terrain["getCompactRockSampling"]()).toBe("exact-zero-v1");
          // Capture the real URL choice, then retain this fixture's server init.
          // Material construction below intentionally leaves the seven actual
          // asset owners idle; browser texture admission is a separate check.
          Reflect.deleteProperty(globalThis, "window");
        }
        await terrain.init();
        expect(terrain["runtimeIsServer"]).toBe(true);
        expect(terrain["compositionManifestLoaded"]).toBe(true);
        const field = terrain["compactPondBankField"]!;
        expect(field).toMatchObject({
          id: "composition-v1",
          zoneId: original.id,
        });
        const height = terrain.getHeightAt(343, 295);
        const ground = terrain.captureCanonicalGroundLease();
        terrain["initTerrainMaterial"]();
        const material = terrain.getTerrainMaterialWithUniforms()!;
        expect(material.compactRockSampling).toBe(
          rockSampling ? "exact-zero-v1" : undefined,
        );
        expect(
          Object.prototype.hasOwnProperty.call(material, "compactRockSampling"),
        ).toBe(rockSampling);
        expect(
          Object.getOwnPropertyDescriptor(material, "compactRockSampling"),
        ).toEqual(
          rockSampling
            ? {
                value: "exact-zero-v1",
                enumerable: true,
                writable: false,
                configurable: false,
              }
            : undefined,
        );
        expect(material.compactPondBlend).toBe("composition-v1");
        expect(material.compactPondBankField).toEqual(field);
        expect(Object.isFrozen(material.compactPondBankField)).toBe(true);
        expect(material.compactTerrainSurface!.getReceipt()).toMatchObject({
          surfaceSampleCount: rockSampling ? 35 : 33,
          status: "idle",
        });
        expect(material.compactGrassColorGrade?.id).toBe(
          rockSampling ? "fine-meadow-green-v1" : undefined,
        );
        expect(
          Object.prototype.hasOwnProperty.call(
            material.compactTerrainSurface!.getReceipt(),
            "grassSubstrate",
          ),
        ).toBe(rockSampling);
        expect(
          material.compactTerrainSurface!.getReceipt().textures,
        ).toHaveLength(7);
        expect(material.getCompactTerrainDiagnosticOutputs()).not.toBeNull();
        const setup = terrain["buildGrassWorkerSetup"]();
        expect(setup).not.toHaveProperty("compactRockSampling");
        expect(setup.compactPondBlend).toBe("composition-v1");
        expect(setup.compactPondBankField).toEqual(field);
        const remote = setup.getTerrainSurfaceForRegion(490, 490, 495, 495);
        expect(
          remote.zones.find((zone) => zone.id === original.id)?.radialPond,
        ).toEqual(selected.radialPond);
        expect(
          remote.waterBodies.find((pond) => pond.id === field.pond.id),
        ).toMatchObject(field.pond);
        expect(ground.isCurrent()).toBe(true);
        expect(terrain.getHeightAt(343, 295)).toBe(height);
      } finally {
        area.flatZones = originalZones;
        world.destroy();
      }
    },
  );

  it("fails closed before water or material publication when composition metadata is missing", async () => {
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    terrain["compactPondBlend"] = "composition-v1";
    terrain["compactSurfaceBlend"] = "height-v1";
    try {
      await expect(terrain.init()).rejects.toThrow(/composition|bank.*field/i);
      expect(terrain["compactPondBankField"]).toBeNull();
      expect(terrain["waterSystem"]).toBeUndefined();
      expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
      expect(terrain["canonicalGroundInitialized"]).toBe(false);
    } finally {
      world.destroy();
    }
  });

  it.each([false, true])(
    "captures rock preview before actual material construction despite URL mutation (initially selected=%s)",
    (selected) => {
      const fine =
        "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1&dirtProjection=stochastic-v1&terrainBlend=height-v1";
      const location = new URL(
        `https://localhost/stream.html?${fine}${selected ? "&rockProjection=stochastic-v1" : ""}`,
      );
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location },
      });
      const world = new World(),
        terrain = new TerrainSystem(world);
      const restartedWorld = new World(),
        restarted = new TerrainSystem(restartedWorld);
      const identity = DataManager.getWorldContentIdentity();
      try {
        terrain["initializeTerrainGenerator"]();
        const height = terrain.getHeightAt(350, 320);
        const profile = terrain.getWorldTerrainProfile();
        const workers = terrain["buildGrassWorkerSetup"]();
        expect(workers.compactGrassColorGrade).toBe("fine-meadow-green-v1");
        expect(terrain["getCompactRockProjection"]()).toBe(
          selected ? "stochastic-v1" : undefined,
        );
        expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
        location.search = `?${fine}${selected ? "" : "&rockProjection=stochastic-v1"}`;
        terrain["initTerrainMaterial"]();
        const material = terrain.getTerrainMaterialWithUniforms()!;
        expect(material.compactTerrainSurface!.getReceipt()).toMatchObject({
          rockProjection: selected ? "stochastic-v1" : "dual-v1",
          surfaceSampleCount: selected ? 35 : 29,
          grassSubstrate: {
            id: "frequency-v1",
            footprintMeters: 0.07,
            detailRetention: 0.35,
            additionalSurfaceSampleCount: 2,
          },
          status: "idle",
        });
        expect(
          material.compactTerrainSurface!.getReceipt().textures,
        ).toHaveLength(7);
        expect(material.terrainUniforms.surfaceDetailStrength.value).toBe(1);
        expect(terrain.getWorldTerrainProfile()).toBe(profile);
        expect(terrain.getHeightAt(350, 320)).toBe(height);
        const after = terrain["buildGrassWorkerSetup"]();
        expect(Object.keys(after).sort()).toEqual(Object.keys(workers).sort());
        for (const key of [
          "terrainConfig",
          "compactGrassColorGrade",
          "compactPlantingLobes",
          "seed",
          "biomeCenters",
          "biomes",
          "grassConfigs",
          "tileSize",
        ] as const)
          expect(after[key]).toEqual(workers[key]);
        expect("compactRockProjection" in after).toBe(false);
        expect(after.isGrassObstacleAt?.(350, 320)).toBe(
          workers.isGrassObstacleAt?.(350, 320),
        );
        restarted["initializeTerrainGenerator"]();
        restarted["initTerrainMaterial"]();
        expect(
          restarted
            .getTerrainMaterialWithUniforms()!
            .compactTerrainSurface!.getReceipt(),
        ).toMatchObject({
          rockProjection: selected ? "dual-v1" : "stochastic-v1",
          surfaceSampleCount: selected ? 29 : 35,
          grassSubstrate: {
            id: "frequency-v1",
            footprintMeters: 0.07,
            detailRetention: 0.35,
            additionalSurfaceSampleCount: 2,
          },
        });
        expect(restarted.getHeightAt(350, 320)).toBe(height);
        location.search = `?${fine}&rockProjection=invalid`;
        expect(terrain["getCompactRockProjection"]()).toBe(
          selected ? "stochastic-v1" : undefined,
        );
        expect(restarted["getCompactRockProjection"]()).toBe(
          selected ? undefined : "stochastic-v1",
        );
        expect(terrain.getTerrainMaterialWithUniforms()).toBe(material);
        expect(DataManager.getWorldContentIdentity()).toBe(identity);
      } finally {
        restarted.destroy();
        terrain.destroy();
        restartedWorld.destroy();
        world.destroy();
      }
    },
  );

  it("rejects malformed rock preview during actual init before material, water or grass owners exist", async () => {
    const location = new URL(
      "https://localhost/stream.html?streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1&rockProjection=invalid",
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location },
    });
    const world = new World(),
      terrain = new TerrainSystem(world);
    try {
      await expect(terrain.init()).rejects.toThrow("rock projection candidate");
      expect(terrain["compactRockProjection"]).toBeUndefined();
      expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
      expect(terrain["waterSystem"]).toBeUndefined();
      expect(terrain["quadTreeVisualManager"]).toBeNull();
      expect(terrain["grassVisualManager"]).toBeNull();
      expect(terrain["canonicalGroundInitialized"]).toBe(false);
    } finally {
      terrain.destroy();
      world.destroy();
    }
  });

  it("rejects rock preview on the validated legacy compact profile without changing the admitted world", () => {
    const location = new URL(
      "https://localhost/stream.html?streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1&rockProjection=stochastic-v1",
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location },
    });
    const world = new World(),
      terrain = new TerrainSystem(world);
    const identity = DataManager.getWorldContentIdentity();
    const admitted = DataManager.getWorldTerrainProfile();
    try {
      // Validated per-owner profile fixture, as in material-initialization tests;
      // no renderer/network replacement or global manifest mutation.
      terrain["activeTerrainProfile"] = resolveWorldTerrainProfile(
        COMPACT_WORLD_TERRAIN_PROFILE,
      );
      expect(() => terrain["initTerrainMaterial"]()).toThrow(
        "requires compact sculpt terrain",
      );
      expect(terrain["compactRockProjection"]).toBeUndefined();
      expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
      expect(DataManager.getWorldTerrainProfile()).toBe(admitted);
      expect(DataManager.getWorldContentIdentity()).toBe(identity);
    } finally {
      terrain.destroy();
      world.destroy();
    }
  });

  it.each([false, true])(
    "captures dirt preview before actual material construction despite URL mutation (initially selected=%s)",
    (selected) => {
      const fine =
        "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
      const location = new URL(
        `https://localhost/stream.html?${fine}${selected ? "&dirtProjection=stochastic-v1" : ""}`,
      );
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location },
      });
      const world = new World(),
        terrain = new TerrainSystem(world);
      const restartedWorld = new World(),
        restarted = new TerrainSystem(restartedWorld);
      const identity = DataManager.getWorldContentIdentity();
      try {
        terrain["initializeTerrainGenerator"]();
        const height = terrain.getHeightAt(350, 320);
        const profile = terrain.getWorldTerrainProfile();
        const workers = terrain["buildGrassWorkerSetup"]();
        expect(terrain["getCompactDirtProjection"]()).toBe(
          selected ? "stochastic-v1" : undefined,
        );
        expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
        location.search = `?${fine}${selected ? "" : "&dirtProjection=stochastic-v1"}`;
        terrain["initTerrainMaterial"]();
        const material = terrain.getTerrainMaterialWithUniforms()!;
        expect(material.compactTerrainSurface!.getReceipt()).toMatchObject({
          dirtProjection: selected ? "stochastic-v1" : "dual-v1",
          surfaceSampleCount: selected ? 22 : 20,
          status: "idle",
        });
        expect(
          material.compactTerrainSurface!.getReceipt().textures,
        ).toHaveLength(6);
        expect(material.terrainUniforms.surfaceDetailStrength.value).toBe(1);
        expect(terrain.getWorldTerrainProfile()).toBe(profile);
        expect(terrain.getHeightAt(350, 320)).toBe(height);
        const after = terrain["buildGrassWorkerSetup"]();
        expect(Object.keys(after).sort()).toEqual(Object.keys(workers).sort());
        for (const key of [
          "terrainConfig",
          "compactGrassColorGrade",
          "compactPlantingLobes",
          "seed",
          "biomeCenters",
          "biomes",
          "grassConfigs",
          "tileSize",
        ] as const)
          expect(after[key]).toEqual(workers[key]);
        expect("compactDirtProjection" in after).toBe(false);
        expect(after.isGrassObstacleAt?.(350, 320)).toBe(
          workers.isGrassObstacleAt?.(350, 320),
        );
        restarted["initializeTerrainGenerator"]();
        restarted["initTerrainMaterial"]();
        expect(
          restarted
            .getTerrainMaterialWithUniforms()!
            .compactTerrainSurface!.getReceipt(),
        ).toMatchObject({
          dirtProjection: selected ? "dual-v1" : "stochastic-v1",
          surfaceSampleCount: selected ? 20 : 22,
        });
        expect(restarted.getHeightAt(350, 320)).toBe(height);
        location.search = `?${fine}&dirtProjection=invalid`;
        expect(terrain["getCompactDirtProjection"]()).toBe(
          selected ? "stochastic-v1" : undefined,
        );
        expect(restarted["getCompactDirtProjection"]()).toBe(
          selected ? undefined : "stochastic-v1",
        );
        expect(terrain.getTerrainMaterialWithUniforms()).toBe(material);
        expect(DataManager.getWorldContentIdentity()).toBe(identity);
      } finally {
        restarted.destroy();
        terrain.destroy();
        restartedWorld.destroy();
        world.destroy();
      }
    },
  );

  it("rejects malformed dirt preview during actual init before material, water or grass owners exist", async () => {
    const location = new URL(
      "https://localhost/stream.html?streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1&dirtProjection=invalid",
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location },
    });
    const world = new World(),
      terrain = new TerrainSystem(world);
    try {
      await expect(terrain.init()).rejects.toThrow("dirt projection candidate");
      expect(terrain["compactDirtProjection"]).toBeUndefined();
      expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
      expect(terrain["waterSystem"]).toBeUndefined();
      expect(terrain["quadTreeVisualManager"]).toBeNull();
      expect(terrain["grassVisualManager"]).toBeNull();
      expect(terrain["canonicalGroundInitialized"]).toBe(false);
    } finally {
      terrain.destroy();
      world.destroy();
    }
  });

  it("rejects dirt preview on the validated legacy compact profile without changing the admitted world", () => {
    const location = new URL(
      "https://localhost/stream.html?streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1&dirtProjection=stochastic-v1",
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location },
    });
    const world = new World(),
      terrain = new TerrainSystem(world);
    const identity = DataManager.getWorldContentIdentity();
    const admitted = DataManager.getWorldTerrainProfile();
    try {
      // Validated per-owner profile fixture, as in material-initialization tests;
      // no renderer/network replacement or global manifest mutation.
      terrain["activeTerrainProfile"] = resolveWorldTerrainProfile(
        COMPACT_WORLD_TERRAIN_PROFILE,
      );
      expect(() => terrain["initTerrainMaterial"]()).toThrow(
        "requires compact sculpt terrain",
      );
      expect(terrain["compactDirtProjection"]).toBeUndefined();
      expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
      expect(DataManager.getWorldTerrainProfile()).toBe(admitted);
      expect(DataManager.getWorldContentIdentity()).toBe(identity);
    } finally {
      terrain.destroy();
      world.destroy();
    }
  });

  it.each([false, true])(
    "captures road clearance once on the real terrain owner across URL mutation (initially selected=%s)",
    (selected) => {
      // A real URL supplies only the viewport input. World, TerrainSystem,
      // manifest admission and worker-setup methods are their actual owners;
      // this CPU ownership check does not claim browser or GPU qualification.
      const fine =
        "streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1";
      const location = new URL(
        `https://localhost/stream.html?${fine}&grassCoverage=sixty-centimetre-cell-v1&grassCoverageCell=12,11${selected ? "&grassRoadClearance=per-blade-v1" : ""}`,
      );
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location },
      });
      const world = new World();
      const terrain = new TerrainSystem(world);
      const restartedWorld = new World();
      const restarted = new TerrainSystem(restartedWorld);
      try {
        terrain["initializeTerrainGenerator"]();
        const identity = worldTerrainProfileIdentity(
          terrain.getWorldTerrainProfile(),
        );
        const height = terrain.getHeightAt(350, 320);
        const before = terrain["buildGrassWorkerSetup"]();
        const captured = terrain["grassVisualSelection"]!;
        expect(Object.isFrozen(captured)).toBe(true);
        expect(Object.keys(captured).sort()).toEqual(
          [
            "appearance",
            "profile",
            "coverageTrial",
            ...(selected ? ["roadClearance"] : []),
          ].sort(),
        );
        expect(captured.roadClearance).toBe(
          selected ? "per-blade-v1" : undefined,
        );
        expect(captured.coverageTrial?.cell.indexX).toBe(12);
        expect(Object.isFrozen(captured.coverageTrial?.cell)).toBe(true);
        expect(
          Reflect.set(
            captured,
            "roadClearance",
            selected ? undefined : "per-blade-v1",
          ),
        ).toBe(false);
        location.search = `?${fine}&grassCoverage=sixty-centimetre-cell-v1&grassCoverageCell=13,11${selected ? "" : "&grassRoadClearance=per-blade-v1"}`;
        const after = terrain["buildGrassWorkerSetup"]();
        expect(terrain["grassVisualSelection"]).toBe(captured);
        expect(captured.roadClearance).toBe(
          selected ? "per-blade-v1" : undefined,
        );
        expect(captured.coverageTrial?.cell.indexX).toBe(12);
        expect(after.compactGrassColorGrade).toBe(
          before.compactGrassColorGrade,
        );
        expect(after.terrainConfig.TERRAIN_PROFILE_IDENTITY).toBe(identity);
        expect(terrain.getHeightAt(350, 320)).toBe(height);
        restarted["initializeTerrainGenerator"]();
        restarted["buildGrassWorkerSetup"]();
        expect(restarted["grassVisualSelection"]?.roadClearance).toBe(
          selected ? undefined : "per-blade-v1",
        );
        expect(
          restarted["grassVisualSelection"]?.coverageTrial?.cell.indexX,
        ).toBe(13);
        // Even a now-invalid URL must not reconfigure either established owner.
        location.search = `?${fine}&grassRoadClearance=invalid`;
        expect(() => terrain["buildGrassWorkerSetup"]()).not.toThrow();
        expect(() => restarted["buildGrassWorkerSetup"]()).not.toThrow();
        expect(terrain["grassVisualManager"]).toBeNull();
        expect(terrain["terrainMaterial"]).toBeUndefined();
      } finally {
        restarted.destroy();
        terrain.destroy();
        restartedWorld.destroy();
        world.destroy();
      }
    },
  );

  it("rejects invalid road clearance during real init before material, water or grass asset owners exist", async () => {
    const location = new URL(
      "https://localhost/stream.html?streamRenderProfile=island-fine-meadow-720p60-v1&grassAppearance=fine-meadow-v1&grassRoadClearance=invalid",
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location },
    });
    const world = new World();
    const terrain = new TerrainSystem(world);
    try {
      expect(DataManager.getInstance().isReady()).toBe(true);
      await expect(terrain.init()).rejects.toThrow("road-clearance selector");
      expect(terrain["grassVisualSelection"]).toBeUndefined();
      expect(terrain["terrainMaterial"]).toBeUndefined();
      expect(terrain["waterSystem"]).toBeUndefined();
      expect(terrain["quadTreeVisualManager"]).toBeNull();
      expect(terrain["grassVisualManager"]).toBeNull();
      expect(terrain["canonicalGroundInitialized"]).toBe(false);
    } finally {
      terrain.destroy();
      world.destroy();
    }
  });

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
    expect(terrain.getWorldTerrainProfile()).toEqual({
      ...HAVEN_SHOULDER_COMPACT_WORLD_TERRAIN_PROFILE,
      coastalApron: {
        schemaVersion: 1,
        minX: 445,
        maxX: 503,
        minZ: 436,
        maxZ: 539,
        featherX: 6,
        featherZ: 20,
        halo: 1,
        westernShoulder: {
          maxWidth: 24,
          startZ: 460,
          endZ: 539,
          featherZ: 24,
        },
        lowland: {
          minZ: 436,
          maxZ: 540,
          startX: 462,
          endX: 422,
          descentLength: 57,
          halfWidth: 12,
          westHoldX: 445,
          westMinX: 377,
          westReleaseZ: 458,
          westReleaseLength: 64,
          eastMaxX: 503,
          startBlend: 12,
          endBlend: 22,
          endHeight: 18.3,
        },
        floorHeight: 2.5,
        referencePlateau: 28.15,
        knots: [
          [-26, 2.5, 0],
          [-9, 16, 0.12],
          [3, 17.5, 0.14],
          [15, 19.25, 0.18],
          [60, 28.15, 0],
        ],
      },
    });
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
