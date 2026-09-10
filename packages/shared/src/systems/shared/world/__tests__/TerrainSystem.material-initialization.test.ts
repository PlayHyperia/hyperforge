import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { TerrainSystem } from "../TerrainSystem";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  resolveWorldTerrainProfile,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";

type MaterialLifecycle = {
  activeTerrainProfile: WorldTerrainProfile | null;
  initTerrainMaterial(): void;
};

describe("actual TerrainSystem material initialization order", () => {
  it.each([
    ["admitted sculpted profile", null, 1],
    ["legacy compact profile", COMPACT_WORLD_TERRAIN_PROFILE, 0],
  ] as const)(
    "configures %s after generator initialization",
    async (_, profile, strength) => {
      const world = new World();
      const admittedIdentity = DataManager.getWorldContentIdentity();
      const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
      const lifecycle = terrain as unknown as MaterialLifecycle;
      if (profile) {
        // A validated per-world profile fixture, not a renderer/network mock or a
        // mutation of the globally admitted running world.
        lifecycle.activeTerrainProfile = resolveWorldTerrainProfile(profile);
      }
      try {
        expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
        // Run the real init, including its generator, noise, water and lifecycle
        // setup. Node intentionally has no client role; then invoke the exact
        // client-only material initialization used by init(), after its generator.
        // The actual browser branch remains covered by the live WebGPU probe.
        await terrain.init();
        expect(terrain.getTerrainMaterialWithUniforms()).toBeNull();
        expect(Number.isFinite(terrain.getHeightAt(350, 320))).toBe(true);
        expect(
          Object.keys(terrain.computeBiomeWeightsByPosition(350, 320)).length,
        ).toBeGreaterThan(0);
        lifecycle.initTerrainMaterial();

        const material = terrain.getTerrainMaterialWithUniforms();
        expect(material).not.toBeNull();
        expect(material!.terrainUniforms.surfaceDetailStrength.value).toBe(
          strength,
        );
        expect(terrain.getTerrainMaterialWithUniforms()).toBe(material);
        const pond = ALL_WORLD_AREAS.haven_pond.waterBodies![0];
        if (strength === 1) {
          expect(material!.compactPondMaterial!.profile).toEqual(pond);
          expect(
            material!.compactPondMaterial!.parameters.value.toArray(),
          ).toEqual([pond.centerX, pond.centerZ, pond.radius, pond.surfaceY]);
        } else expect(material!.compactPondMaterial).toBeUndefined();
        expect(DataManager.getWorldTerrainProfile()).toEqual(
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
        );
        expect(DataManager.getWorldContentIdentity()).toBe(admittedIdentity);
      } finally {
        terrain.getTerrainMaterialWithUniforms()?.dispose();
        world.destroy();
      }
    },
  );

  it("applies the admitted option even when material creation precedes the generator", () => {
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    try {
      // Material ownership must not depend on the generator opportunistically
      // finding it. This also guards a future reordering of init().
      (terrain as unknown as MaterialLifecycle).initTerrainMaterial();
      expect(
        terrain.getTerrainMaterialWithUniforms()!.terrainUniforms
          .surfaceDetailStrength.value,
      ).toBe(1);
      expect(
        terrain.getTerrainMaterialWithUniforms()!.compactPondMaterial!.profile,
      ).toEqual(ALL_WORLD_AREAS.haven_pond.waterBodies![0]);
    } finally {
      terrain.getTerrainMaterialWithUniforms()?.dispose();
      world.destroy();
    }
  });
});
