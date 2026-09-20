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
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";
import { RetainedTerrainSurface } from "../TerrainGridSurface";

function selectedPondProfile() {
  return validateWorldTerrainProfile({
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
}

function selectedHeadProfile() {
  const baseline = selectedPondProfile();
  const bearing = baseline.landform!.inletBearing;
  const point = (along: number, y: number) => [
    baseline.island.centerX + along * Math.cos(bearing) - 8 * Math.sin(bearing),
    baseline.island.centerZ + along * Math.sin(bearing) + 8 * Math.cos(bearing),
    y,
  ];
  return validateWorldTerrainProfile({
    ...baseline,
    coastalApron: {
      ...baseline.coastalApron!,
      headShoulder: {
        minX: 377,
        maxX: 444,
        minZ: 457,
        maxZ: 500,
        featherX: 8,
        featherZ: 4,
        start: point(70, 25.4),
        end: point(94, 19.2),
        leftWidth: 16,
        rightWidth: 24,
        startFade: 6,
        endFade: 8,
        leftSlope: 0.32,
        rightSlope: 0.18,
        creaseWidth: 2.4,
        blendHeight: 0.35,
      },
    },
  });
}

function plannerSnapshot(tree: TerrainQuadTree) {
  // Publish ordinary leaf ownership through the real planner's readiness
  // mechanism, so obsolete split/merge parents do not inflate settled budgets.
  for (const node of tree.getFinalNodes()) {
    if (!node.splitted) {
      node.visualChunkKey = `detail-test-${node.id}`;
      node.setReady();
    }
  }
  return tree
    .getFinalNodes()
    .map((node) => ({
      x: node.centerX,
      z: node.centerZ,
      size: node.size,
      resolution: node.resolution,
    }))
    .sort((a, b) => a.x - b.x || a.z - b.z || a.size - b.size);
}

type PlannerLeaves = ReturnType<typeof plannerSnapshot>;

function regularGeometryBudget(leaves: PlannerLeaves) {
  // Verified against real generated buffers in the density test below. This
  // excludes annulus refinement, transition overlap and object/GPU overhead.
  return leaves.reduce(
    (sum, node) => {
      const r = node.resolution;
      const vertices = r * r + 4 * r;
      const triangles = 2 * (r - 1) ** 2 + 8 * (r - 1);
      return {
        draws: sum.draws + 1,
        vertices: sum.vertices + vertices,
        triangles: sum.triangles + triangles,
        bufferBytes: sum.bufferBytes + vertices * 56 + triangles * 12,
      };
    },
    { draws: 0, vertices: 0, triangles: 0, bufferBytes: 0 },
  );
}

function pondLeaves(leaves: PlannerLeaves) {
  const pond = DataManager.getInstance().getWorldArea("haven_pond")!.bounds;
  return leaves.filter(
    (node) =>
      node.x - node.size / 2 < pond.maxX &&
      node.x + node.size / 2 > pond.minX &&
      node.z - node.size / 2 < pond.maxZ &&
      node.z + node.size / 2 > pond.minZ,
  );
}

describe("bounded preparation terrain detail", () => {
  it.each([16, 64])(
    "retains only the selected head's two128 leaves through near/far planning at base resolution %s",
    async (resolution) => {
      await DataManager.getInstance().initialize();
      const areas = DataManager.getInstance().getAllWorldAreas();
      const baselineProfile = selectedPondProfile();
      const profile = selectedHeadProfile();
      const original = createCompactPreparationDetailRegions(
        baselineProfile,
        areas,
        64,
      );
      const selected = createCompactPreparationDetailRegions(
        profile,
        areas,
        64,
      );
      const head = profile.coastalApron!.headShoulder!;
      expect(selected).toEqual([
        ...original,
        {
          minX: head.minX,
          maxX: head.maxX,
          minZ: head.minZ,
          maxZ: head.maxZ,
          resolution: 128,
          keepMinSize: true,
        },
      ]);
      expect(selected.length).toBeLessThanOrEqual(8);
      const baseline = new TerrainQuadTree({
        resolution,
        rootChunkRadius: 0,
        fineDetailRegions: original,
      });
      const candidate = new TerrainQuadTree({
        resolution,
        rootChunkRadius: 0,
        fineDetailRegions: selected,
      });
      const isHeadLeaf = (node: PlannerLeaves[number]) =>
        node.size === 100 &&
        node.z === 450 &&
        (node.x === 350 || node.x === 450);
      const rows: Array<{
        focus: [number, number];
        original: ReturnType<typeof regularGeometryBudget>;
        candidate: ReturnType<typeof regularGeometryBudget>;
      }> = [];
      try {
        for (const [x, z] of [
          [368, 390.75],
          [475, 525],
          [-650, -650],
          [368, 390.75],
        ]) {
          baseline.update(x, z);
          candidate.update(x, z);
          const before = plannerSnapshot(baseline),
            after = plannerSnapshot(candidate);
          expect(before.filter(isHeadLeaf)).toEqual([
            { x: 350, z: 450, size: 100, resolution: 64 },
            { x: 450, z: 450, size: 100, resolution: 64 },
          ]);
          expect(after).toEqual(
            before.map((node) =>
              isHeadLeaf(node) ? { ...node, resolution: 128 } : node,
            ),
          );
          expect(candidate.config.resolution).toBe(resolution);
          const oldBudget = regularGeometryBudget(before),
            newBudget = regularGeometryBudget(after);
          expect(newBudget.draws - oldBudget.draws).toBe(0);
          expect(newBudget.triangles - oldBudget.triangles).toBe(49_664);
          expect(newBudget.bufferBytes - oldBudget.bufferBytes).toBe(2_000_896);
          rows.push({
            focus: [x, z],
            original: oldBudget,
            candidate: newBudget,
          });
        }
        // Local retention must not pin the island's old root after travelling
        // outside it, and must be restored from production region data on return.
        candidate.update(4800, 4800);
        expect(plannerSnapshot(candidate).filter(isHeadLeaf)).toEqual([]);
        candidate.update(368, 390.75);
        expect(plannerSnapshot(candidate).filter(isHeadLeaf)).toEqual([
          { x: 350, z: 450, size: 100, resolution: 128 },
          { x: 450, z: 450, size: 100, resolution: 128 },
        ]);
        process.stdout.write(
          "Cove-head actual planner regular-buffer budget (not native GPU cost): " +
            JSON.stringify({ resolution, rows }) +
            "\n",
        );
      } finally {
        baseline.dispose();
        candidate.dispose();
      }
    },
  );

  it("opts only the admitted meadow pond into minimum-size retention without changing default regions or resolution", async () => {
    await DataManager.getInstance().initialize();
    const areas = DataManager.getInstance().getAllWorldAreas();
    const profile = DataManager.getWorldTerrainProfile();
    const before = JSON.stringify({ areas, profile });
    const original = createCompactPreparationDetailRegions(profile, areas, 64);
    const selected = createCompactPreparationDetailRegions(
      selectedPondProfile(),
      areas,
      64,
    );
    expect(original[1]).toEqual({
      ...areas.haven_pond.bounds,
      resolution: 128,
    });
    expect(selected).toEqual(
      original.map((region, index) =>
        index === 1 ? { ...region, keepMinSize: true } : region,
      ),
    );
    expect(selected.length).toBe(original.length);
    expect(selected.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify({ areas, profile })).toBe(before);
  });

  it.each([
    { resolution: 16, rootChunkRadius: 0 },
    { resolution: 64, rootChunkRadius: 0 },
    { resolution: 16, rootChunkRadius: 1 },
    { resolution: 64, rootChunkRadius: 1 },
  ])(
    "retains both128 pond leaves with $resolution-grid/root radius$rootChunkRadius through near/far planning",
    async ({ resolution, rootChunkRadius }) => {
      await DataManager.getInstance().initialize();
      const areas = DataManager.getInstance().getAllWorldAreas();
      const originalRegions = createCompactPreparationDetailRegions(
        DataManager.getWorldTerrainProfile(),
        areas,
        64,
      );
      const selectedRegions = createCompactPreparationDetailRegions(
        selectedPondProfile(),
        areas,
        64,
      );
      const baseline = new TerrainQuadTree({
        resolution,
        rootChunkRadius,
        fineDetailRegions: originalRegions,
      });
      const selected = new TerrainQuadTree({
        resolution,
        rootChunkRadius,
        fineDetailRegions: selectedRegions,
      });
      const rows: Array<{
        focus: number[];
        baseline: PlannerLeaves;
        selected: PlannerLeaves;
      }> = [];
      try {
        for (const [x, z] of [
          [350, 340],
          [475, 525],
          [650, 650],
          [-650, -650],
          [350, 340],
        ]) {
          baseline.update(x, z);
          selected.update(x, z);
          const oldLeaves = plannerSnapshot(baseline),
            newLeaves = plannerSnapshot(selected);
          expect(pondLeaves(newLeaves)).toEqual([
            { x: 350, z: 250, size: 100, resolution: 128 },
            { x: 350, z: 350, size: 100, resolution: 128 },
          ]);
          expect(
            newLeaves.every(
              (node) => node.size === 100 || node.resolution === resolution,
            ),
          ).toBe(true);
          expect(selected.config.resolution).toBe(resolution);
          rows.push({
            focus: [x, z],
            baseline: oldLeaves,
            selected: newLeaves,
          });
        }
        expect(rows[0].selected).toEqual(rows[0].baseline);
        // Unsplit hysteresis may retain other neighbours on return; the owned
        // pond leaves themselves must be the same, independently of that path.
        expect(pondLeaves(rows[4].selected)).toEqual(
          pondLeaves(rows[0].selected),
        );
        // keepMinSize does not pin the original world root forever.
        selected.update(4800, 4800);
        expect(pondLeaves(plannerSnapshot(selected))).toEqual([]);
        selected.update(350, 340);
        expect(pondLeaves(plannerSnapshot(selected))).toEqual(
          pondLeaves(rows[0].selected),
        );
        process.stdout.write(
          "Candidate pond retained real planner leaves (not geometry or native cost): " +
            JSON.stringify({
              resolution,
              rootChunkRadius,
              rows: rows.map((row) => ({
                ...row,
                baselineBudget: regularGeometryBudget(row.baseline),
                selectedBudget: regularGeometryBudget(row.selected),
              })),
            }) +
            "\n",
        );
      } finally {
        baseline.dispose();
        selected.dispose();
      }
    },
  );

  it("does not rely on incidental neighbouring detail to retain the pond at a distant focus", async () => {
    await DataManager.getInstance().initialize();
    const areas = DataManager.getInstance().getAllWorldAreas();
    const baselineRegion = createCompactPreparationDetailRegions(
      DataManager.getWorldTerrainProfile(),
      areas,
      64,
    )[1];
    const selectedRegion = createCompactPreparationDetailRegions(
      selectedPondProfile(),
      areas,
      64,
    )[1];
    const baseline = new TerrainQuadTree({
      resolution: 16,
      rootChunkRadius: 0,
      fineDetailRegions: [baselineRegion],
    });
    const selected = new TerrainQuadTree({
      resolution: 16,
      rootChunkRadius: 0,
      fineDetailRegions: [selectedRegion],
    });
    try {
      baseline.update(-650, -650);
      selected.update(-650, -650);
      const oldLeaves = plannerSnapshot(baseline),
        newLeaves = plannerSnapshot(selected);
      expect(
        pondLeaves(oldLeaves).some(
          (node) => node.size > 100 && node.resolution === 16,
        ),
      ).toBe(true);
      expect(pondLeaves(newLeaves)).toEqual([
        { x: 350, z: 250, size: 100, resolution: 128 },
        { x: 350, z: 350, size: 100, resolution: 128 },
      ]);
      process.stdout.write(
        "Pond-only detail ownership isolation (not actual full-world delta): " +
          JSON.stringify({
            baseline: regularGeometryBudget(oldLeaves),
            selected: regularGeometryBudget(newLeaves),
          }) +
          "\n",
      );
    } finally {
      baseline.dispose();
      selected.dispose();
    }
  });

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
                sample.height - provider.getHeightAtComputed(x, z),
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
      for (const measurement of measurements) {
        const budget = regularGeometryBudget(
          [250, 350].map((z) => ({
            x: 350,
            z,
            size: 100,
            resolution: measurement.resolution,
          })),
        );
        expect(budget.triangles).toBe(measurement.triangles);
        expect(budget.bufferBytes).toBe(measurement.bufferBytes);
      }
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
