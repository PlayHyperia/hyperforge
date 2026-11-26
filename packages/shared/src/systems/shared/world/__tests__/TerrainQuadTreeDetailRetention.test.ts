import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import { TerrainSystem } from "../TerrainSystem";
import { SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE } from "../WorldTerrainProfile";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";
import { TerrainQuadTree, type TerrainDetailRegion } from "../TerrainQuadTree";

const region: TerrainDetailRegion = {
  minX: 100,
  maxX: 200,
  minZ: 100,
  maxZ: 200,
  resolution: 64,
  keepMinSize: true,
};

describe("bounded authored minimum-size terrain retention", () => {
  it("validates the optional boolean and leaves unspecified/false resolution overrides distance-driven", () => {
    for (const keepMinSize of [0, 1, "true", null, {}]) {
      expect(
        () =>
          new TerrainQuadTree({
            fineDetailRegions: [
              {
                ...region,
                keepMinSize,
              } as unknown as TerrainDetailRegion,
            ],
          }),
      ).toThrow("Invalid terrain detail region");
    }
    for (const value of [undefined, false]) {
      const tree = new TerrainQuadTree({
        rootChunkRadius: 0,
        splitRatio: 0,
        fineDetailRegions: [{ ...region, keepMinSize: value }],
      });
      try {
        tree.update(-650, -650);
        expect(tree.totalNodeCount).toBe(1);
        expect(tree.getFinalNodes()[0].size).toBe(1600);
      } finally {
        tree.dispose();
      }
    }
  });

  it("splits only strict area intersections, keeps ordinary siblings coarse and never allocates another root", () => {
    const tree = new TerrainQuadTree({
      resolution: 16,
      rootChunkRadius: 0,
      splitRatio: 0,
      fineDetailRegions: [region],
    });
    try {
      tree.update(-650, -650);
      const nodes = tree.getFinalNodes();
      expect(tree.totalNodeCount).toBe(17);
      expect(nodes).toHaveLength(13);
      expect(
        nodes
          .filter((node) => node.resolution === 64)
          .map((node) => [node.centerX, node.centerZ]),
      ).toEqual([[150, 150]]);
      const selected = nodes.find((node) => node.resolution === 64)!;
      expect(selected.size).toBe(100);
      expect(selected.isMaxDepth).toBe(true);
      const parent = selected.parent!;
      expect(parent.splitted).toBe(true);
      parent.unsplit();
      expect(parent.splitted).toBe(true);
      expect(
        [...parent.children.values()].filter((node) => node.resolution === 16),
      ).toHaveLength(3);
      expect(
        nodes.every(
          (node) =>
            node.boundingBox.xMin >= -800 &&
            node.boundingBox.xMax <= 800 &&
            node.boundingBox.zMin >= -800 &&
            node.boundingBox.zMax <= 800,
        ),
      ).toBe(true);
      // Existing leaf identities survive distant moves in the same root.
      for (const [x, z] of [
        [650, -650],
        [-650, 650],
        [650, 650],
        [-650, -650],
      ]) {
        tree.update(x, z);
        expect(
          tree.getFinalNodes().find((node) => node.resolution === 64),
        ).toBe(selected);
        expect(tree.totalNodeCount).toBe(17);
      }
      tree.update(1700, 1700);
      expect(tree.totalNodeCount).toBe(1);
      expect(tree.getFinalNodes().every((node) => node.resolution === 16)).toBe(
        true,
      );
      expect(selected.isFinal).toBe(false);
      expect(parent.children.size).toBe(0);
    } finally {
      tree.dispose();
    }
    expect(tree.totalNodeCount).toBe(0);
  });

  it("retains the historical pre-shoulder ten64 coastal leaves at distant focus, respects pond128 precedence and measures actual geometry", async () => {
    const regions = createCompactPreparationDetailRegions(
      SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      DataManager.getInstance().getAllWorldAreas(),
      64,
    );
    expect(regions.filter((row) => row.keepMinSize)).toHaveLength(2);
    const tree = new TerrainQuadTree({
      resolution: 16,
      rootChunkRadius: 0,
      splitRatio: 0,
      fineDetailRegions: regions,
    });
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    const internal = terrain as unknown as {
      loadWaterBodiesFromManifest(): void;
      loadFlatZonesFromManifest(): void;
      buildChunkTerrainProvider(): FullTerrainProvider;
    };
    try {
      // Match geometry's sampler to this historical allocation, not the latest
      // manifest's optional shoulder. The current bounded 64→128 increment is
      // checked independently by CompactHavenShoulder.integration.test.ts.
      terrain.getWorldTerrainProfile();
      terrain["activeTerrainProfile"] = SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE;
      await terrain.init();
      internal.loadWaterBodiesFromManifest();
      internal.loadFlatZonesFromManifest();
      tree.update(-650, -650);
      const nodes = tree.getFinalNodes();
      const coastal = nodes.filter((node) => node.resolution === 64);
      expect(
        coastal.map((node) => [node.centerX, node.centerZ]).sort(),
      ).toEqual([
        [150, 350],
        [150, 450],
        [250, 350],
        [250, 450],
        [350, 450],
        [350, 550],
        [450, 450],
        [450, 550],
        [550, 450],
        [550, 550],
      ]);
      expect(
        nodes
          .filter((node) => node.resolution === 128)
          .map((node) => [node.centerX, node.centerZ])
          .sort(),
      ).toEqual([
        [350, 250],
        [350, 350],
      ]);
      expect(
        nodes
          .filter((node) => node.resolution > 16)
          .every((node) => node.isMaxDepth && node.size === 100),
      ).toBe(true);
      const provider = internal.buildChunkTerrainProvider();
      let triangles = 0,
        bytes = 0;
      for (const node of coastal) {
        const result = assembleQuadChunkGeometry(
          generateQuadChunkDataSync(
            node.centerX,
            node.centerZ,
            node.size,
            node.resolution,
            provider,
          ),
          provider,
          15,
        );
        try {
          triangles += result.geometry.index!.count / 3;
          bytes +=
            result.geometry.index!.array.byteLength +
            Object.values(result.geometry.attributes).reduce(
              (sum, attribute) => sum + attribute.array.byteLength,
              0,
            );
        } finally {
          result.geometry.dispose();
        }
      }
      expect(triangles).toBe(84_420);
      expect(bytes).toBe(3_450_160);
      // Four subdivisions at most per existing node; no external region roots.
      // Record exact structural cost, independently of geometry readiness.
      expect(tree.totalNodeCount).toBeLessThanOrEqual(85);
      const ids = coastal.map((node) => node.id);
      for (const [x, z] of [
        [650, -650],
        [-650, 650],
        [650, 650],
      ]) {
        tree.update(x, z);
        expect(
          tree
            .getFinalNodes()
            .filter((node) => node.resolution === 64)
            .map((node) => node.id),
        ).toEqual(ids);
      }
      expect(Object.isFrozen(tree.config.fineDetailRegions)).toBe(true);
      expect(tree.config.fineDetailRegions!.every(Object.isFrozen)).toBe(true);
    } finally {
      tree.dispose();
      world.destroy();
    }
  });
});
