import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import { TerrainQuadTree } from "../TerrainQuadTree";
import {
  TerrainSystem,
  STREAMING_TERRAIN_QUADTREE_RESOLUTION,
} from "../TerrainSystem";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
} from "../WorldTerrainProfile";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";
import { RetainedTerrainSurface } from "../TerrainGridSurface";

describe("bounded preparation terrain detail", () => {
  it("uses only the two admitted preparation leaves and retains coarse ocean/ancestor geometry", async () => {
    await DataManager.getInstance().initialize();
    const regions = createCompactPreparationDetailRegions(
      SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
      DataManager.getInstance().getAllWorldAreas(),
      64,
    );
    const tree = new TerrainQuadTree({
      resolution: 16,
      rootChunkRadius: 0,
      fineDetailRegions: regions,
    });
    tree.update(350, 340);
    const detailed = tree
      .getFinalNodes()
      .filter((node) => node.resolution > 16);
    expect(detailed.map((node) => [node.centerX, node.centerZ]).sort()).toEqual(
      [
        [350, 250],
        [350, 350],
      ],
    );
    expect(
      detailed.every(
        (node) =>
          node.isMaxDepth && node.size === 100 && node.resolution === 128,
      ),
    ).toBe(true);
    expect(regions.map((region) => region.resolution)).toEqual([64, 128]);
    expect(
      tree
        .getFinalNodes()
        .filter((node) => !node.isMaxDepth)
        .every((node) => node.resolution === 16),
    ).toBe(true);
    // Freeze the admitted fixed region copy: external edits cannot invalidate a
    // retained surface's resolution halfway through a worker/grass ticket.
    expect(Object.isFrozen(tree.config.fineDetailRegions)).toBe(true);
    expect(Object.isFrozen(tree.config.fineDetailRegions![0])).toBe(true);
    expect(
      createCompactPreparationDetailRegions(
        COMPACT_WORLD_TERRAIN_PROFILE,
        {},
        64,
      ),
    ).toEqual([]);
    tree.dispose();
  });

  it("fails early on malformed, unbounded or missing detail definitions", () => {
    const region = { minX: 0, maxX: 1, minZ: 0, maxZ: 1, resolution: 64 };
    for (const invalid of [
      { ...region, minX: NaN },
      { ...region, maxX: 0 },
      { ...region, resolution: 129 },
      { ...region, resolution: 2.5 },
    ]) {
      expect(
        () => new TerrainQuadTree({ fineDetailRegions: [invalid] }),
      ).toThrow("Invalid terrain detail region");
    }
    expect(
      () => new TerrainQuadTree({ fineDetailRegions: Array(9).fill(region) }),
    ).toThrow("Too many terrain detail regions");
    expect(() =>
      createCompactPreparationDetailRegions(
        SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
        {},
        64,
      ),
    ).toThrow("Missing compact preparation area");
  });

  it("measures pond mesh error and the explicit local geometry budget at all three densities", async () => {
    await DataManager.getInstance().initialize();
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    const internals = terrain as unknown as {
      CONFIG: { QUADTREE_RESOLUTION: number; QUADTREE_SKIRT_DROP: number };
      loadFlatZonesFromManifest(): void;
      buildChunkTerrainProvider(): FullTerrainProvider;
    };
    try {
      await terrain.init();
      internals.loadFlatZonesFromManifest();
      const provider = internals.buildChunkTerrainProvider();
      const measurements = [
        STREAMING_TERRAIN_QUADTREE_RESOLUTION,
        internals.CONFIG.QUADTREE_RESOLUTION,
        128,
      ].map((resolution) => {
        const chunks = [250, 350].map((z, i) => {
          const result = assembleQuadChunkGeometry(
            generateQuadChunkDataSync(350, z, 100, resolution, provider),
            provider,
            internals.CONFIG.QUADTREE_SKIRT_DROP,
          );
          return {
            ...result,
            z,
            surface: new RetainedTerrainSurface(
              i,
              provider.terrainProfileIdentity,
              350,
              z,
              100,
              resolution,
              result.geometry,
            ),
          };
        });
        try {
          let samples = 0,
            squaredError = 0,
            maxError = 0;
          const sample = { height: 0, nx: 0, ny: 1, nz: 0, faceIndex: 0 };
          const pond = DataManager.getInstance().getWorldArea("haven_pond")!;
          for (let z = pond.bounds.minZ; z <= pond.bounds.maxZ; z += 0.25) {
            for (let x = pond.bounds.minX; x <= pond.bounds.maxX; x += 0.25) {
              const chunk = chunks[z < 300 ? 0 : 1];
              expect(chunk.surface.sample(x - 350, z - chunk.z, sample)).toBe(
                true,
              );
              const error = Math.abs(
                sample.height - terrain.getHeightAtComputed(x, z),
              );
              maxError = Math.max(maxError, error);
              squaredError += error * error;
              samples++;
            }
          }
          return {
            resolution,
            spacing: 100 / (resolution - 1),
            samples,
            maxError,
            rmsError: Math.sqrt(squaredError / samples),
            triangles: chunks.reduce(
              (sum, c) => sum + c.geometry.index!.count / 3,
              0,
            ),
            bufferBytes: chunks.reduce(
              (sum, c) =>
                sum +
                c.geometry.index!.array.byteLength +
                Object.values(c.geometry.attributes).reduce(
                  (bytes, a) => bytes + a.array.byteLength,
                  0,
                ),
              0,
            ),
          };
        } finally {
          for (const chunk of chunks) chunk.geometry.dispose();
        }
      });
      const [baseline, candidate, pondDetail] = measurements;
      expect(candidate.resolution).toBe(64);
      expect(candidate.samples).toBe(7921);
      expect(candidate.rmsError).toBeLessThan(baseline.rmsError * 0.5);
      expect(candidate.maxError).toBeLessThan(baseline.maxError * 0.5);
      expect(candidate.triangles - baseline.triangles).toBe(15744);
      expect(candidate.bufferBytes - baseline.bufferBytes).toBeLessThan(
        700_000,
      );
      expect(pondDetail.resolution).toBe(128);
      expect(pondDetail.samples).toBe(7921);
      expect(pondDetail.rmsError).toBeLessThan(0.03);
      expect(pondDetail.maxError).toBeLessThan(0.18);
      expect(pondDetail.rmsError).toBeLessThan(candidate.rmsError * 0.35);
      expect(pondDetail.triangles).toBe(66_548);
      expect(pondDetail.bufferBytes).toBe(2_690_928);
      expect(pondDetail.triangles - candidate.triangles).toBe(49_664);
      expect(pondDetail.bufferBytes - candidate.bufferBytes).toBe(2_000_896);
      process.stdout.write(
        `Compact pond geometry comparison (CPU only, not frame-time acceptance): ${JSON.stringify(measurements)}\n`,
      );
    } finally {
      world.destroy();
    }
  });
});
