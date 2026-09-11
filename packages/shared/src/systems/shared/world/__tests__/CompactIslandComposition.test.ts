import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import {
  getDuelArenaConfig,
  isPositionInsideDuelArenaZone,
} from "../../../../data/duel-manifest";
import { NoiseGenerator } from "../../../../utils/NoiseGenerator";
import { createCompactIslandLandform } from "../CompactIslandLandform";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as candidate,
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE as previous,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { createCompactIslandPaths } from "../CompactIslandPaths";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import { TerrainQuadTree } from "../TerrainQuadTree";
import {
  generateCenteredTrees,
  type TreeGenerationSource,
} from "../BiomeResourceGenerator";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
  type FullTerrainProvider,
} from "../TerrainQuadChunkGenerator";
import {
  RetainedTerrainSurface,
  type TerrainGridSample,
} from "../TerrainGridSurface";

type Internals = {
  loadWaterBodiesFromManifest(): void;
  loadFlatZonesFromManifest(): void;
  createTreeGenerationSource(x: number, z: number): TreeGenerationSource;
  buildChunkTerrainProvider(): FullTerrainProvider;
};
const worlds: World[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});
async function fixture() {
  const world = new World();
  worlds.push(world);
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  const internal = terrain as unknown as Internals;
  await terrain.init();
  internal.loadWaterBodiesFromManifest();
  internal.loadFlatZonesFromManifest();
  await roads.init();
  await roads.start();
  return { terrain, internal };
}

const landform = createCompactIslandLandform();
const noise = new NoiseGenerator(0);
function coastRadius(profile: typeof candidate, degrees: number) {
  const a = (degrees * Math.PI) / 180;
  let land = 0,
    sea = 200;
  for (let i = 0; i < 40; i++) {
    const radius = (land + sea) / 2;
    if (
      landform.height(
        350 + Math.cos(a) * radius,
        400 + Math.sin(a) * radius,
        noise,
        profile,
      ) > profile.water.threshold
    )
      land = radius;
    else sea = radius;
  }
  return land;
}

// Exact pre-edit v2 production census, sampled 2026-09-11 with actual World,
// TerrainSystem/RoadNetworkSystem + generateCenteredTrees before v3 activation.
// Retain candidate identity, actual snapped coordinate (NOT rounded ID), species,
// scale/rotation and Y. This detects changed filter/RNG consumption, not just count.
const PREVIOUS_CENSUS = [
  [
    "3_2_tree_0",
    "palm",
    334.5,
    265.5,
    26.431061431582275,
    1.082286132751565,
    5.412964240673718,
  ],
  [
    "3_2_tree_2",
    "palm",
    310.5,
    294.5,
    28.395813068882305,
    1.1728671277344382,
    3.233916693106685,
  ],
  [
    "2_5_tree_0",
    "banana",
    288.5,
    507.5,
    30.564014967770948,
    1.1543517902852856,
    1.9125510291638745,
  ],
  [
    "2_5_tree_1",
    "palm",
    280.5,
    517.5,
    21.833477379304686,
    1.0570706823973615,
    0.7793959906386061,
  ],
  [
    "2_5_tree_2",
    "banana",
    280.5,
    512.5,
    25.95063550849739,
    1.0393102768434468,
    5.8358601547816065,
  ],
  [
    "3_2_tree_1",
    "banana",
    376.5,
    287.5,
    28.419301523097687,
    1.1065835295027548,
    6.176932278226846,
  ],
  [
    "5_4_tree_0",
    "general",
    502.5,
    431.5,
    17.922226870245474,
    1.0061008904609132,
    4.143939210883453,
  ],
  [
    "5_4_tree_1",
    "banana",
    501.5,
    418.5,
    17.94707983666091,
    1.1373860959283508,
    1.2090572835132511,
  ],
];

describe("compact v3 asymmetric coastline and continuous ridge", () => {
  it("admits explicit finite authored shape data with a distinct profile/content identity", () => {
    expect(DataManager.getWorldTerrainProfile()).toEqual(candidate);
    expect(candidate.id).toBe("compact-duel-island-v3");
    expect(candidate.algorithm).toBe("compact-island-sculpt-v2");
    expect(worldTerrainProfileIdentity(candidate)).not.toBe(
      worldTerrainProfileIdentity(previous),
    );
    expect(Object.isFrozen(candidate.landform)).toBe(true);
    const { landform: omitted, ...missing } = candidate;
    expect(omitted).toBeDefined();
    expect(() => validateWorldTerrainProfile(missing)).toThrow();
    for (const patch of [
      { inletHalfWidth: NaN },
      { westHeadlandHalfWidth: 1e-12 },
      { inletBankTransition: 50 },
      { ridgeWestWidth: 0 },
      { inletTipDistance: -1 },
      { injected: 1 },
    ]) {
      expect(() =>
        validateWorldTerrainProfile({
          ...candidate,
          landform: { ...candidate.landform, ...patch },
        }),
      ).toThrow();
    }
    expect(() =>
      validateWorldTerrainProfile({
        ...previous,
        landform: candidate.landform,
      }),
    ).toThrow();
  });

  it("cuts a 40–55m inward-only southeast bay, extends the west headland and keeps the admitted envelope", () => {
    const before = coastRadius(previous, 48),
      after = coastRadius(candidate, 48);
    expect(before - after).toBeGreaterThan(40);
    expect(before - after).toBeLessThan(55);
    expect(
      coastRadius(candidate, 180) - coastRadius(previous, 180),
    ).toBeGreaterThan(20);
    for (const degrees of [0, 12, 30, 90, 270])
      expect(coastRadius(candidate, degrees)).toBe(
        coastRadius(previous, degrees),
      );
    const extent =
      candidate.island.radius * (1 + candidate.island.maxCoastVariation);
    for (let i = 0; i < 256; i++) {
      const angle = (i * Math.PI) / 128;
      const x = 350 + Math.cos(angle) * (extent + 0.01),
        z = 400 + Math.sin(angle) * (extent + 0.01);
      expect(landform.mask(x, z, noise, candidate)).toBe(0);
      expect(landform.height(x, z, noise, candidate)).toBe(
        candidate.water.oceanFloorHeight,
      );
    }
    expect(candidate.bounds).toEqual(previous.bounds);
    expect(candidate.terrainTileSize).toBe(previous.terrainTileSize);
    expect(candidate.island.radius).toBe(previous.island.radius);
    expect(landform.height(238, 410, noise, candidate)).toBeGreaterThan(45);
    expect(landform.height(238, 410, noise, candidate)).toBeLessThan(48);
    // Different cross-slope widths make a west-facing escarpment, not a dome.
    const crest = landform.height(238, 410, noise, candidate);
    expect(crest - landform.height(218, 410, noise, candidate)).toBeGreaterThan(
      crest - landform.height(258, 410, noise, candidate),
    );
  });

  it("preserves exact eight procedural identities and grounded transforms, plus all authored path surfaces", async () => {
    const { terrain, internal } = await fixture();
    const rows = [];
    for (let x = 2; x <= 5; x++)
      for (let z = 2; z <= 6; z++) {
        const batch = generateCenteredTrees(
          { tileX: x, tileZ: z },
          100,
          (a, b) => internal.createTreeGenerationSource(a, b),
          isPositionInsideDuelArenaZone,
        );
        expect(batch.sourceCellsGenerated).toBe(4);
        expect(batch.sourceCandidates).toBeLessThanOrEqual(12);
        for (const node of batch.resources)
          rows.push([
            node.id,
            node.subType,
            node.position.x + x * 100,
            node.position.z + z * 100,
            node.position.y,
            node.scale,
            node.rotation,
          ]);
      }
    expect(rows).toHaveLength(PREVIOUS_CENSUS.length);
    for (let i = 0; i < rows.length; i++) {
      // The archived receipt used Bun/JSC; Node/V8 transcendental evaluation
      // differs by up to 3e-14m. Identity/species/XZ/scale/rotation remain exact.
      expect(rows[i].filter((_, column) => column !== 4)).toEqual(
        PREVIOUS_CENSUS[i].filter((_, column) => column !== 4),
      );
      expect(rows[i][4] as number).toBeCloseTo(
        PREVIOUS_CENSUS[i][4] as number,
        12,
      );
      expect(rows[i][4]).toBe(
        terrain.getResourceGroundHeight(
          rows[i][2] as number,
          rows[i][3] as number,
        ),
      );
    }
    const paths = createCompactIslandPaths(
      candidate,
      ALL_WORLD_AREAS,
      getDuelArenaConfig(),
      terrain.getResourceGroundHeight.bind(terrain),
    );
    expect(paths).toHaveLength(6);
    for (const path of paths)
      for (const point of path.path) {
        expect(point.y).toBeGreaterThan(candidate.water.threshold + 1);
        expect(
          Math.abs(
            terrain.getResourceGroundHeight(point.x + 0.5, point.z) -
              terrain.getResourceGroundHeight(point.x - 0.5, point.z),
          ),
        ).toBeLessThan(0.5);
        expect(
          Math.abs(
            terrain.getResourceGroundHeight(point.x, point.z + 0.5) -
              terrain.getResourceGroundHeight(point.x, point.z - 0.5),
          ),
        ).toBeLessThan(0.5);
      }
  });

  it("bounds actual ten-leaf64 macro refinement and measures residual shoreline approximation against16/32", async () => {
    const { terrain, internal } = await fixture();
    const provider = internal.buildChunkTerrainProvider();
    const regions = createCompactPreparationDetailRegions(
      candidate,
      ALL_WORLD_AREAS,
      64,
    );
    const tree = new TerrainQuadTree({
      resolution: 16,
      rootChunkRadius: 0,
      fineDetailRegions: regions,
    });
    tree.update(350, 340);
    const nodes = tree.getFinalNodes().filter((node) => node.resolution === 64);
    expect(nodes.map((node) => [node.centerX, node.centerZ]).sort()).toEqual([
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
    expect(nodes.every((node) => node.isMaxDepth && node.size === 100)).toBe(
      true,
    );
    expect(
      tree.getFinalNodes().filter((node) => node.resolution === 128),
    ).toHaveLength(2);
    const sample: TerrainGridSample = {
      height: 0,
      nx: 0,
      ny: 0,
      nz: 0,
      faceIndex: 0,
    };
    const measurements = [];
    for (const resolution of [16, 32, 64]) {
      let samples = 0,
        squared = 0,
        maxError = 0,
        nearWaterError = 0,
        triangles = 0,
        geometryBytes = 0;
      let worst: { x: number; z: number } | null = null;
      let worstNearWater: { x: number; z: number } | null = null;
      for (const node of nodes) {
        const x = node.centerX,
          z = node.centerZ;
        const data = generateQuadChunkDataSync(
          x,
          z,
          node.size,
          resolution,
          provider,
        );
        const result = assembleQuadChunkGeometry(data, provider, 15);
        try {
          triangles += result.geometry.getIndex()!.count / 3;
          geometryBytes +=
            result.geometry.getIndex()!.array.byteLength +
            Object.values(result.geometry.attributes).reduce(
              (sum, attribute) => sum + attribute.array.byteLength,
              0,
            );
          const surface = new RetainedTerrainSurface(
            1,
            provider.terrainProfileIdentity,
            x,
            z,
            100,
            resolution,
            result.geometry,
          );
          for (let dx = -50; dx <= 50; dx += 1)
            for (let dz = -50; dz <= 50; dz += 1) {
              expect(surface.sample(dx, dz, sample)).toBe(true);
              expect(
                [sample.height, sample.nx, sample.ny, sample.nz].every(
                  Number.isFinite,
                ),
              ).toBe(true);
              const height = terrain.getResourceGroundHeight(x + dx, z + dz);
              const error = Math.abs(sample.height - height);
              if (error > maxError) {
                maxError = error;
                worst = { x: x + dx, z: z + dz };
              }
              if (
                Math.abs(height - candidate.water.threshold) <= 3 &&
                error > nearWaterError
              ) {
                nearWaterError = error;
                worstNearWater = { x: x + dx, z: z + dz };
              }
              squared += error * error;
              samples++;
            }
        } finally {
          result.geometry.dispose();
        }
      }
      measurements.push({
        resolution,
        samples,
        maxError,
        nearWaterError,
        rmsError: Math.sqrt(squared / samples),
        triangles,
        geometryBytes,
        worst,
        worstNearWater,
      });
    }
    tree.dispose();
    const [baseline, middle, refined] = measurements;
    process.stdout.write(
      `Compact macro geometry approximation (actual aligned leaves, CPU only; not contact/frame-time acceptance): ${JSON.stringify(measurements)}\n`,
    );
    expect(refined.samples).toBe(102010);
    // Complete ten-leaf coverage includes the bay's western bank: measured
    // peak .284563m, versus .241957m in the original eight-leaf subset. This
    // bounds the chosen visual approximation, not exact analytic contact.
    expect(refined.maxError).toBeLessThan(0.3);
    expect(refined.nearWaterError).toBeLessThan(0.18);
    expect(refined.rmsError).toBeLessThan(middle.rmsError * 0.3);
    expect(refined.maxError).toBeLessThan(baseline.maxError * 0.1);
    expect(refined.triangles).toBe(84420);
    expect(refined.geometryBytes).toBe(3450160);
    expect(refined.triangles - baseline.triangles).toBe(78720);
    expect(refined.geometryBytes - baseline.geometryBytes).toBe(3202560);
  });

  it("keeps the real embedded factory self-contained after minification and translated profiles deterministic", async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../CompactIslandLandform.ts", import.meta.url)),
      ],
      bundle: true,
      write: false,
      platform: "neutral",
      format: "iife",
      globalName: "Landform",
      keepNames: true,
      minify: true,
    });
    const source = runInNewContext(
      `${result.outputFiles[0].text}\nLandform.createCompactIslandLandform.toString()`,
    ) as string;
    const embedded = runInNewContext(`(${source})()`) as ReturnType<
      typeof createCompactIslandLandform
    >;
    const translated = validateWorldTerrainProfile({
      ...candidate,
      id: "translated-sculpt-v2-test",
      bounds: { minX: 1150, maxX: 1550, minZ: -800, maxZ: -400 },
      island: { ...candidate.island, centerX: 1350, centerZ: -600 },
    });
    for (let x = 150; x <= 550; x += 11)
      for (let z = 200; z <= 600; z += 11) {
        const expected = landform.height(x, z, noise, candidate);
        expect(embedded.height(x, z, noise, candidate)).toBe(expected);
        expect(embedded.mask(x, z, noise, candidate)).toBe(
          landform.mask(x, z, noise, candidate),
        );
        expect(
          landform.height(x + 1000, z - 1000, noise, translated),
        ).toBeCloseTo(expected, 10);
      }
  });
});
