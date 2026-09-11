import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import {
  GRASS_WORKER_CODE,
  generateGrassPlacementsAsync,
  type GrassWorkerInput,
  type GrassWorkerOutput,
} from "../../../../utils/workers/GrassWorker";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import {
  GrassVisualManager,
  GRASS_CONFIG,
  STREAMING_GRASS_VISUAL_PROFILE,
  COMPACT_ISLAND_GRASS_VISUAL_PROFILE,
  type GrassVisualProfile,
} from "../GrassVisualManager";
import { TerrainQuadTree } from "../TerrainQuadTree";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import {
  assembleQuadChunkGeometry,
  generateQuadChunkDataSync,
} from "../TerrainQuadChunkGenerator";
import { createCompactTerrainColorOperations } from "../CompactTerrainPalette";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_V1_PROFILE_FIXTURE,
  SCULPTED_COMPACT_V2_PROFILE_FIXTURE,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";
import { createTerrainWorkerConfig } from "../../../../utils/workers/TerrainWorkerShared";

/** Actual production source in a native worker; only message transport is adapted. */
function workerSession() {
  const worker = new Worker(
    `const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(message,transfers)=>parentPort.postMessage(message,transfers)};
    ${GRASS_WORKER_CODE}
    parentPort.on('message',data=>self.onmessage({data}));`,
    { eval: true, env: {} },
  );
  return {
    run(input: GrassWorkerInput) {
      return new Promise<GrassWorkerOutput>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("Actual worker deadline")),
          10000,
        );
        const onError = (error: Error) => finish(error);
        const onMessage = (message: {
          result?: GrassWorkerOutput;
          error?: string;
        }) => {
          if (message.error) finish(new Error(message.error));
          else if (message.result) {
            finish();
            resolve(message.result);
          }
        };
        function finish(error?: Error) {
          clearTimeout(timer);
          worker.off("error", onError);
          worker.off("message", onMessage);
          if (error) reject(error);
        }
        worker.once("error", onError);
        worker.once("message", onMessage);
        worker.postMessage(input);
      });
    },
    close: () => worker.terminate(),
  };
}

async function fixture(
  profile: WorldTerrainProfile = SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
) {
  await DataManager.getInstance().initialize();
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const roads = world.register("roads", RoadNetworkSystem) as RoadNetworkSystem;
  terrain.getWorldTerrainProfile();
  // Isolated historical sampler selection before real init. Non-shape config is
  // identical; do not mutate DataManager or replace any generator/material method.
  terrain["activeTerrainProfile"] = profile;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  terrain["subscribeRoadNetworkEvents"]();
  await roads.init();
  await roads.start();
  const setup = terrain["buildGrassWorkerSetup"]();
  const tree = new TerrainQuadTree({
    minSize: 100,
    maxDepth: 4,
    resolution: 16,
  });
  const nodes = [
    [450, 350],
    [250, 350],
    [350, 350],
    [350, 450],
    [450, 450],
    [350, 250],
  ].map(([x, z]) => tree.createNode(null, null, 100, x, z, 4));
  const surfaces = new Map<number, RetainedTerrainSurface>();
  const geometries: THREE.BufferGeometry[] = [];
  const managers: GrassVisualManager[] = [];
  const worker = workerSession();
  function manager(profile: GrassVisualProfile) {
    const container = new THREE.Group();
    const owner = new GrassVisualManager(
      setup.terrainConfig.TERRAIN_PROFILE_IDENTITY,
      container,
      (node) => {
        let surface = surfaces.get(node.id);
        if (!surface) {
          const provider = terrain["buildChunkTerrainProvider"]();
          const { geometry } = assembleQuadChunkGeometry(
            generateQuadChunkDataSync(
              node.centerX,
              node.centerZ,
              node.size,
              node.resolution,
              provider,
            ),
            provider,
            terrain["CONFIG"].QUADTREE_SKIRT_DROP,
          );
          geometries.push(geometry);
          surface = new RetainedTerrainSurface(
            node.id,
            provider.terrainProfileIdentity,
            node.centerX,
            node.centerZ,
            node.size,
            node.resolution,
            geometry,
          );
          surfaces.set(node.id, surface);
        }
        return surface;
      },
      (x, z) => terrain["getHeightAtComputed"](x, z),
      setup.terrainConfig.WATER_THRESHOLD,
      (x, z) => terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
      (x, z) => terrain.isGrassExcludedAt(x, z),
      (x, z, eligibility) => terrain.getTerrainColorAt(x, z, true, eligibility),
      setup,
      profile,
      undefined,
      (x, z) => terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z),
    );
    owner.setPlayerPosition(385, 374);
    managers.push(owner);
    return { owner, container };
  }
  return {
    world,
    terrain,
    setup,
    tree,
    nodes,
    worker,
    manager,
    async close() {
      await worker.close();
      for (const owner of managers) owner.destroy();
      tree.dispose();
      for (const geometry of geometries) geometry.dispose();
      world.destroy();
    },
  };
}

describe("opt-in compact grass, actual terrain and native worker (not GPU proof)", () => {
  it("matches physical layer algebra and fails closed on unknown/legacy terrain opt-ins", () => {
    const ops = createCompactTerrainColorOperations();
    const surface = {
      x: 350,
      z: 320,
      height: 28.4,
      pond: null,
      macroField: ops.macroField(SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE),
    };
    for (const noiseValue of [0, 0.2, 0.5, 0.8, 1])
      for (const slope of [0, 0.05, 0.1, 0.2, 0.5]) {
        const input = { noiseValue, distortNoise: 0.37, slope, surface };
        const weights = ops.weights({
          noiseValue,
          slope,
          distortNoise: 0.37,
          roadInfluence: 0,
          pondSurface: { soil: 0, wetness: 0 },
          macroSurface: ops.macroWeights(
            surface.x,
            surface.z,
            noiseValue,
            surface.macroField,
          ),
        });
        expect(ops.grassSupport(input)).toBe(
          (1 - weights.dirt) * (1 - weights.cliff),
        );
      }
    expect(
      ops.grassSupport({
        noiseValue: 0.5,
        distortNoise: 0.5,
        slope: 0,
        surface: {
          x: 343,
          z: 302,
          height: 27,
          pond: {
            id: "haven_pond_water",
            centerX: 343,
            centerZ: 302,
            radius: 7.5,
            surfaceY: 27.8,
          },
        },
      }),
    ).toBe(0);
    expect(ops.grassEligibility(undefined, "compact-island-sculpt-v2")).toBe(
      "legacy-biome-v1",
    );
    for (const value of [null, false, true, "compact", "legacy", {}])
      expect(() =>
        ops.grassEligibility(value, "compact-island-sculpt-v2"),
      ).toThrow();
    expect(() =>
      ops.grassEligibility("compact-pbr-v1", "compact-island-sculpt-v1"),
    ).toThrow();
  });

  it.each([
    {
      profile: SCULPTED_COMPACT_V2_PROFILE_FIXTURE,
      total: 2130,
      leaves: [271, 503, 139, 510, 364, 343],
    },
    {
      profile: SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      total: 2281,
      leaves: [271, 503, 139, 532, 493, 343],
    },
  ])(
    "preserves legacy density and measures actual native-worker census for $profile.id",
    async ({ profile, total: candidateTotal, leaves }) => {
      const f = await fixture(profile);
      try {
        const fixed = f.manager(STREAMING_GRASS_VISUAL_PROFILE).owner;
        const candidate = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE).owner;
        const variants = [
          { owner: fixed, lod: 2, total: 12, campus: 0 },
          { owner: fixed, lod: 1, total: 337, campus: 0 },
          { owner: candidate, lod: 1, total: candidateTotal, campus: 143 },
        ];
        for (const variant of variants) {
          const leafCounts = [];
          let total = 0,
            campus = 0;
          for (const node of f.nodes) {
            const input = variant.owner["createWorkerInput"](
              node,
              `grass_${node.id}`,
              variant.lod,
            );
            expect(input.grassConfigs.forest.minGrassWeight).toBe(0.6);
            const output = await f.worker.run(input);
            expect(output.grassEligibility).toBe(input.grassEligibility);
            total += output.count;
            leafCounts.push([node.centerX, node.centerZ, output.count]);
            for (let i = 0; i < output.count; i++) {
              const x = node.centerX + output.offsets[i * 3],
                z = node.centerZ + output.offsets[i * 3 + 2],
                y = output.offsets[i * 3 + 1];
              if (x >= 314 && x < 386 && z >= 284 && z < 356) campus++;
              expect(f.terrain.isGrassExcludedAt(x, z)).toBe(false);
              expect(y).toBeGreaterThanOrEqual(
                f.terrain.getWaterBodyRegistry().getWaterSurfaceAt(x, z) +
                  0.1 -
                  1e-4,
              );
              expect(
                f.terrain["calculateRoadInfluenceAtVertex"](x, z, 0, 0),
              ).toBeLessThanOrEqual(0.8);
            }
            if (variant.owner === candidate) {
              const sync = candidate["generateInstanceData"](node, 1);
              expect(sync?.count ?? 0).toBe(output.count);
              if (sync)
                for (const name of [
                  "offsets",
                  "rotScaleHash",
                  "groundColors",
                  "grassTints",
                  "groundNormals",
                ] as const) {
                  expect(sync[name].length).toBe(output[name].length);
                  for (let i = 0; i < sync[name].length; i++)
                    expect(sync[name][i]).toBeCloseTo(output[name][i], 4);
                }
            }
          }
          expect({ total, campus }).toEqual({
            total: variant.total,
            campus: variant.campus,
          });
          if (variant.owner === candidate) {
            expect(leafCounts).toEqual(
              f.nodes.map((node, index) => [
                node.centerX,
                node.centerZ,
                leaves[index],
              ]),
            );
            // Tapering the bay restores land only in two leaves: +22/+129 clumps,
            // +5,436 nominal LOD1 triangles, without changing density or eligibility.
            // Preserve the historical actual-worker census, not a relabeled fixture.
            process.stdout.write(
              `Compact grass CPU census (actual native worker, unchanged density; not GPU cost): ${JSON.stringify({ profile: profile.id, leafCounts, total, campus, nominalTriangles: total * 36 })}\n`,
            );
          }
        }
        expect(candidate["lodGeometries"][1].index!.count / 3).toBe(36);
        expect(candidate.getProfileReceipt()).toMatchObject({
          profileId: "compact-island-v1",
          eligibility: "compact-pbr-v1",
          minimumLodLevel: 1,
          clumpSpacing: 2.8,
          maxRenderDistance: 140,
          maxChunksPerFrame: 1,
          castShadow: false,
        });
        expect(fixed.getProfileReceipt()).toMatchObject({
          profileId: "fixed-arena-v1",
          eligibility: "legacy-biome-v1",
          minimumLodLevel: 2,
        });
      } finally {
        await f.close();
      }
    },
    20000,
  );

  it("tags actual results and rejects tainted modes before generation or pool availability", async () => {
    const f = await fixture();
    try {
      const candidate = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE).owner;
      const node = f.nodes[2],
        key = candidate["chunkKey"](node);
      const input = candidate["createWorkerInput"](node, key, 1);
      const legacy = await f.worker.run({
        ...input,
        grassEligibility: undefined,
      });
      const explicit = await f.worker.run({
        ...input,
        grassEligibility: "legacy-biome-v1",
      });
      expect(explicit).toEqual(legacy);
      candidate.onNodeNeedsGeometry(node);
      const ticket = candidate["createWorkerTicket"](node, key, 1, false);
      expect(() => candidate["settleWorkerResult"](ticket, legacy)).toThrow(
        /eligibility mismatch/,
      );
      const unknown = {
        ...input,
        grassEligibility: "compact",
      } as unknown as GrassWorkerInput;
      await expect(f.worker.run(unknown)).rejects.toThrow(/eligibility/);
      await expect(generateGrassPlacementsAsync(unknown)).rejects.toThrow(
        /eligibility/,
      );
      const oldProfile = SCULPTED_COMPACT_V1_PROFILE_FIXTURE;
      await expect(
        f.worker.run({
          ...input,
          config: createTerrainWorkerConfig(oldProfile, 4),
        }),
      ).rejects.toThrow(/eligibility/);
      for (const change of [
        { minimumLodLevel: 2 },
        { clumpSpacingMultiplier: 1 },
        { maxRenderDistance: 500 },
        { maxChunksPerFrame: 2 },
        { eligibility: "legacy-biome-v1" as const },
      ]) {
        expect(() =>
          f.manager({ ...COMPACT_ISLAND_GRASS_VISUAL_PROFILE, ...change }),
        ).toThrow(/profile mismatch/);
      }
    } finally {
      await f.close();
    }
  });

  it("retires old-profile inflight/settled work on destroy and preserves one-upload/horizon guards", async () => {
    const f = await fixture();
    try {
      const old = f.manager(STREAMING_GRASS_VISUAL_PROFILE);
      const next = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE);
      const node = f.nodes[2],
        key = old.owner["chunkKey"](node);
      old.owner.onNodeNeedsGeometry(node);
      const ticket = old.owner["createWorkerTicket"](node, key, 2, false);
      const output = await f.worker.run(
        old.owner["createWorkerInput"](node, key, 2),
      );
      old.owner.destroy();
      old.owner["settleWorkerResult"](ticket, output);
      old.owner["rejectWorkerResult"](ticket, new Error("late old profile"));
      expect(old.owner.getProfileReceipt()).toMatchObject({
        destroyed: true,
        inflightChunks: 0,
        settledChunks: 0,
        installedClumps: 0,
      });
      for (const n of f.nodes.slice(0, 3)) {
        next.owner.onNodeNeedsGeometry(n);
        const k = next.owner["chunkKey"](n),
          t = next.owner["createWorkerTicket"](n, k, 1, false);
        next.owner["settleWorkerResult"](
          t,
          await f.worker.run(next.owner["createWorkerInput"](n, k, 1)),
        );
      }
      expect(next.owner["processSettledWorkerResults"]()).toBe(1);
      expect(next.container.children).toHaveLength(1);
      expect(next.owner.getProfileReceipt().settledChunks).toBe(2);
      next.owner.update(1000, 1000);
      expect(next.container.children).toHaveLength(0);
      expect(next.owner.getProfileReceipt().installedClumps).toBe(0);
      expect(GRASS_CONFIG.LOD_TIERS[1].bladesPerClump).toBe(12);
    } finally {
      await f.close();
    }
  });
});
