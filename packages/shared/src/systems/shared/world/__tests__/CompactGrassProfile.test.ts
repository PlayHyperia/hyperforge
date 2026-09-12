import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
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
  SCULPTED_COMPACT_V3_PROFILE_FIXTURE,
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
  it("retains coast-baseline non-color buffers in all six actual v4 leaves", async () => {
    // Measured 2026-09-11 against published b6b3af00e factory in a real worker.
    // Palette SHA256:15cf7643c8dec05ac6f480c0b03ca20aab10bc5f74207ec0f9340b5b9812f910.
    // Worker source SHA256:8e4b4c4fe4f2a5a5639e8ae214f19b6c4e66ce753b30b9f34d99538675fffdb1,
    // byte-identical before/after. One-off comparison used the original factory,
    // not reimplemented algebra, and compared every element before hashing.
    // No Git CLI/history is required to run this retained regression.
    const expected = [
      [
        450,
        350,
        271,
        "f182c957130d903f1d09ce99efe3d92d0a440560b37af7ee5fd40ad8e7daa164",
        "6414005f88a7bb2afc20c4433d3e8562882a855a54918d6257ca0a9ed06d0956",
        "781177c879353a2be1aa5089c7b5f31a3532134f26a5a5d1a80a5e0c1f747d3e",
        "50929c953a47d2831ab4bb9e03a07331068fee50e54a862cd0d7bb2decb82410",
      ],
      [
        250,
        350,
        503,
        "b874a69c16b795ed2b6a62cab29e37d3fc8aecc18617b8ff2645604441f38f45",
        "b75a842bc5bc9d6ac0d76121f0793bc345e0591ace456659139b0a274d11660a",
        "7e6740c91f7c21b361fbb73984f22afef3896b669f9e2a87d31f6e18e9a48432",
        "c91d3c58a0037f1a43aa536e6797b2585210604c7aa006f351731c3fefbffe10",
      ],
      [
        350,
        350,
        139,
        "4c3de808146aaf1e5f7f2bd63b8ca6ac20fb1beec20cfb8751fc4859a832c647",
        "f544f7e4c3d5bc4397762c29a2d27e7550c1cb1d393e5f954e68750679bcd06d",
        "0490457beeeb50176ad0e3eb207977b25d0883c2d401c3543eb6017bf728de92",
        "55c40ebad9297b397ddeb92e1617b8d26e8b59150061116efdf2ea4e0f2a2ff6",
      ],
      [
        350,
        450,
        532,
        "95fc9dac164150df8288083d6983d0bdb531b1b4b3dc61df534f15ecb129ba34",
        "b40e2116d3fa9b4216be2509e52041becfc729c651259f263e164660eabd3337",
        "2b1b920dc641c4fc04e479010122eb7e8861af9fc9ee2fe3b1e9fcdaaf44ce3b",
        "886eeedcc8a55990839487362ca1279209fc91b5927b1d58db123b6a941398c3",
      ],
      [
        450,
        450,
        493,
        "a290d43449bbfbaf0df4c52b419568ea6f325df588c18b577cdd257797232e04",
        "a00280c1860355b98de6603362f205125c465cd57080f29a29c09f5ee40bf226",
        "e06df083901ad7705f627b9bd377a232b94303edbfbc89b41fa801708314f467",
        "4f0ebfbfd7b91ffe35b255a9545ec0b201df093e4763db8c4236c5b9116d7dfa",
      ],
      [
        350,
        250,
        343,
        "4b0fda3b503bb9545c92b8a3c343700f4de8b66b5c74c0ebe34081deb293f218",
        "e62e719e8e67862b061b19db348ee13d2236f0dd6dc1b10ab0be83e7ebd4d163",
        "1dfd030cba9544202ffa3b1402e496443211a1ffafc714ebe7acb33b5f67b859",
        "c7c9709722f56bbefdd377ae17a1733a253ac9ec847749a397440e0d2c9fe90b",
      ],
    ];
    const f = await fixture(SCULPTED_COMPACT_V3_PROFILE_FIXTURE);
    try {
      const owner = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE).owner;
      const receipts = [];
      for (const node of f.nodes) {
        const input = owner["createWorkerInput"](node, `coast_${node.id}`, 1);
        const after = await f.worker.run(input);
        const hashes: string[] = [];
        for (const key of [
          "offsets",
          "rotScaleHash",
          "grassTints",
          "groundNormals",
        ] as const) {
          const data = after[key];
          hashes.push(
            createHash("sha256")
              .update(
                new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
              )
              .digest("hex"),
          );
        }
        receipts.push([node.centerX, node.centerZ, after.count, ...hashes]);
      }
      expect(receipts).toEqual(expected);
    } finally {
      await f.close();
    }
  }, 20000);

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
      fixedLod1: 337,
      leaves: [271, 503, 139, 510, 364, 343],
    },
    {
      profile: SCULPTED_COMPACT_V3_PROFILE_FIXTURE,
      total: 2281,
      fixedLod1: 337,
      leaves: [271, 503, 139, 532, 493, 343],
    },
    {
      profile: SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
      total: 2298,
      fixedLod1: 334,
      leaves: [271, 520, 139, 532, 493, 343],
    },
  ])(
    "preserves legacy density and measures actual native-worker census for $profile.id",
    async ({ profile, total: candidateTotal, fixedLod1, leaves }) => {
      const f = await fixture(profile);
      try {
        const fixed = f.manager(STREAMING_GRASS_VISUAL_PROFILE).owner;
        const candidate = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE).owner;
        const variants = [
          { owner: fixed, lod: 2, total: 12, campus: 0 },
          { owner: fixed, lod: 1, total: fixedLod1, campus: 0 },
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
          process.stdout.write(
            `Actual grass profile census: ${JSON.stringify({ profile: profile.id, eligibility: variant.owner.getProfileReceipt().eligibility, lod: variant.lod, leafCounts, total, campus })}\n`,
          );
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
            // Preserve each historical actual-worker census. The v5 terrace
            // changes sampling in the western leaf (+17 clumps), not density.
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

  it("measures both changed terrace leaves including the western leaf outside the fixed camera census", async () => {
    const results = [];
    for (const profile of [
      SCULPTED_COMPACT_V3_PROFILE_FIXTURE,
      SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
    ]) {
      const f = await fixture(profile);
      try {
        const owner = f.manager(COMPACT_ISLAND_GRASS_VISUAL_PROFILE).owner;
        const counts = [];
        for (const z of [350, 450]) {
          const node = f.tree.createNode(null, null, 100, 250, z, 4);
          const output = await f.worker.run(
            owner["createWorkerInput"](node, owner["chunkKey"](node), 1),
          );
          const sync = owner["generateInstanceData"](node, 1);
          expect(sync?.count ?? 0).toBe(output.count);
          if (sync)
            for (const name of [
              "offsets",
              "rotScaleHash",
              "groundNormals",
            ] as const) {
              expect(sync[name].length).toBe(output[name].length);
              for (let i = 0; i < sync[name].length; i++)
                expect(sync[name][i]).toBeCloseTo(output[name][i], 4);
            }
          counts.push(output.count);
        }
        results.push({ profile: profile.id, counts });
      } finally {
        await f.close();
      }
    }
    process.stdout.write(
      `Both terrace leaf grass census: ${JSON.stringify(results)}\n`,
    );
    expect(results).toEqual([
      { profile: "compact-duel-island-v4", counts: [503, 632] },
      { profile: "compact-duel-island-v5", counts: [520, 657] },
    ]);
  });

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
