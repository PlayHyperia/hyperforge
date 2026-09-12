import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import type { CompactResourceGrovesManifest } from "../../../../types/world/world-types";
import groveLayouts from "./fixtures/CompactResourceGroves.layouts.json";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import {
  getDuelArenaConfig,
  isPositionInsideDuelArenaZone,
} from "../../../../data/duel-manifest";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import {
  QUAD_CHUNK_WORKER_CODE,
  type QuadChunkWorkerOutput,
} from "../../../../utils/workers/QuadChunkWorker";
import { EntityManager } from "../../entities/EntityManager";
import { ResourceSystem } from "../../entities/ResourceSystem";
import { BFSPathfinder } from "../../movement/BFSPathfinder";
import {
  worldToTile,
  getCardinalAdjacentTiles,
} from "../../movement/TileSystem";
import { TerrainSystem } from "../TerrainSystem";
import { RoadNetworkSystem } from "../RoadNetworkSystem";
import { generateCenteredTrees } from "../BiomeResourceGenerator";
import { createCompactIslandPaths } from "../CompactIslandPaths";
import { createCompactPreparationDetailRegions } from "../CompactIslandDetail";
import { TerrainQuadTree } from "../TerrainQuadTree";
import {
  generateQuadChunkDataSync,
  assembleQuadChunkGeometry,
} from "../TerrainQuadChunkGenerator";
import {
  RetainedTerrainSurface,
  type TerrainGridSample,
} from "../TerrainGridSurface";
import {
  SCULPTED_COMPACT_V4_PROFILE_FIXTURE as current,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as brokenRidge,
  SCULPTED_COMPACT_V3_PROFILE_FIXTURE as previous,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";

const IDS = [
  "tree_281_513",
  "tree_281_518",
  "tree_289_508",
  "tree_311_295",
  "tree_335_266",
  "tree_367_311",
  "tree_373_313",
  "tree_375_299",
  "tree_377_288",
  "tree_379_304",
  "tree_379_311",
  "tree_502_419",
  "tree_503_432",
  "tree_288_387",
  "tree_290_432",
  "tree_293_460",
  "tree_294_422",
  "tree_297_449",
  "tree_305_410",
  "tree_310_471",
  "tree_315_492",
  "tree_318_465",
  "tree_320_501",
  "tree_328_484",
  "tree_330_500",
  "tree_333_466",
  "tree_443_383",
  "tree_459_383",
  "tree_461_396",
].sort();
class CpuWorld extends World {
  override get isServer() {
    return true;
  }
}
const worlds: World[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.destroy();
});
async function fixture(profile: WorldTerrainProfile, content: boolean) {
  const saved = {
    config: DataManager["worldConfig"],
    profile: DataManager["worldTerrainProfile"],
    identity: DataManager["worldContentIdentity"],
  };
  try {
    if (content) {
      if (!saved.config)
        throw new Error("Missing initialized world configuration");
      // This is the original terrace-before/after regression, with its exact
      // 29-resource census. The independently frozen v1 grove is intentional;
      // current grouped-grove installation is covered by its own integration.
      DataManager["worldContentIdentity"] = null;
      DataManager.setWorldConfig({
        ...structuredClone(saved.config),
        terrainProfile: current,
        compactPreparationLodge: {
          ...saved.config.compactPreparationLodge!,
          terrainProfileId: current.id,
        },
        compactResourceGroves: structuredClone(
          groveLayouts.previous,
        ) as CompactResourceGrovesManifest,
      });
    }
    const world = new CpuWorld();
    worlds.push(world);
    const manager = world.register(
      "entity-manager",
      EntityManager,
    ) as EntityManager;
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    const roads = world.register(
      "roads",
      RoadNetworkSystem,
    ) as RoadNetworkSystem;
    const resources = world.register(
      "resource",
      ResourceSystem,
    ) as ResourceSystem;
    terrain.getWorldTerrainProfile();
    // Historical sampler isolation only. DataManager/current network admission is
    // never changed; old/new descriptor pairing is tested separately.
    terrain["activeTerrainProfile"] = profile;
    await terrain.init();
    terrain["loadWaterBodiesFromManifest"]();
    terrain["loadFlatZonesFromManifest"]();
    await roads.init();
    await roads.start();
    if (content) {
      await resources.init();
      await terrain.start();
      await Promise.all([...resources["terrainResourceTails"].values()]);
      await resources["initializeWorldAreaResources"]();
      await Promise.all([...resources["terrainResourceTails"].values()]);
    }
    return {
      world,
      terrain,
      manager,
      resources,
      provider: terrain["buildChunkTerrainProvider"](),
    };
  } finally {
    if (content) {
      DataManager["worldConfig"] = saved.config;
      DataManager["worldTerrainProfile"] = saved.profile;
      DataManager["worldContentIdentity"] = saved.identity;
    }
  }
}

describe("actual v5 terrace terrain, functional owners and native worker", () => {
  it("retains all 29 runtime resources, 12 source-owner generation results, 11 paths and every bounded harvest route", async () => {
    const old = await fixture(previous, true),
      next = await fixture(current, true);
    const rows = (f: typeof old) =>
      f.resources
        .getAllResources()
        .filter((r) => r.type === "tree")
        .map((r) => {
          const e = f.manager.getEntity(r.id);
          if (!(e instanceof ResourceEntity))
            throw new Error("Missing real resource entity");
          return {
            id: e.id,
            x: e.position.x,
            y: e.position.y,
            z: e.position.z,
            species: e.config.resourceId,
            scale: e.config.modelScale,
            yield: e.config.harvestYield,
            respawn: e.config.respawnTime,
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    const trees = rows(next);
    expect(trees.map((r) => r.id)).toEqual(IDS);
    expect(trees).toEqual(rows(old));
    for (const f of [old, next])
      expect(
        [...f.terrain.getTiles().values()].filter((t) => t.contentGenerated),
      ).toHaveLength(9);
    let seeded = 0;
    for (let x = 2; x <= 5; x++)
      for (let z = 3; z <= 5; z++) {
        const generate = (f: typeof old) =>
          generateCenteredTrees(
            { tileX: x, tileZ: z },
            100,
            (sx, sz) => f.terrain["createTreeGenerationSource"](sx, sz),
            isPositionInsideDuelArenaZone,
          );
        const before = generate(old),
          after = generate(next);
        expect(after).toEqual(before);
        seeded += after.resources.length;
      }
    expect(seeded).toBe(8);
    const paths = (f: typeof old) =>
      createCompactIslandPaths(
        f.terrain.getWorldTerrainProfile(),
        ALL_WORLD_AREAS,
        getDuelArenaConfig(),
        (x, z) => f.terrain.getResourceGroundHeight(x, z),
      );
    expect(paths(next)).toHaveLength(11);
    expect(paths(next)).toEqual(paths(old));
    let checked = 0;
    const unchanged = (x: number, z: number) => {
      expect(next.terrain.getResourceGroundHeight(x, z)).toBe(
        old.terrain.getResourceGroundHeight(x, z),
      );
      checked++;
    };
    for (const area of Object.values(ALL_WORLD_AREAS)) {
      for (const item of [...(area.stations ?? []), ...(area.npcs ?? [])])
        unchanged(item.position.x, item.position.z);
    }
    // Exact original lobby marks and lodge footprint/door remain outside support.
    for (const [x, z] of [
      [382, 374],
      [385, 374],
      [388, 374],
      [398, 370],
      [393.5, 365.55],
      [402.5, 376.55],
      [398, 377],
    ])
      unchanged(x, z);
    const start = worldToTile(348, 322);
    for (const tree of trees) {
      for (const d of [1, 4])
        for (const [dx, dz] of [
          [0, 0],
          [d, 0],
          [-d, 0],
          [0, d],
          [0, -d],
          [d, d],
          [-d, -d],
          [d, -d],
          [-d, d],
        ])
          unchanged(tree.x + dx, tree.z + dz);
      const adjacent = getCardinalAdjacentTiles(
        worldToTile(tree.x, tree.z),
        1,
        1,
      );
      for (const p of adjacent) unchanged(p.x + 0.5, p.z + 0.5);
      const target = adjacent
        .filter((p) => next.world.collision.isWalkable(p.x, p.z))
        .sort(
          (a, b) =>
            Math.abs(a.x - start.x) +
            Math.abs(a.z - start.z) -
            Math.abs(b.x - start.x) -
            Math.abs(b.z - start.z),
        )[0];
      expect(target).toBeDefined();
      let cursor = { ...start };
      const bfs = new BFSPathfinder();
      const seen = new Set<string>();
      for (
        let i = 0;
        i < 12 && (cursor.x !== target.x || cursor.z !== target.z);
        i++
      ) {
        const segment = bfs.findPath(
          cursor,
          target,
          (p, from) =>
            p.x >= 250 &&
            p.x < 550 &&
            p.z >= 250 &&
            p.z < 550 &&
            next.world.collision.isWalkable(p.x, p.z) &&
            (!from ||
              !next.world.collision.isBlocked(from.x, from.z, p.x, p.z)),
        );
        expect(segment.length).toBeGreaterThan(0);
        for (const p of segment) {
          expect(old.world.collision.isWalkable(p.x, p.z)).toBe(true);
          expect(
            old.world.collision.isBlocked(cursor.x, cursor.z, p.x, p.z),
          ).toBe(false);
          unchanged(p.x + 0.5, p.z + 0.5);
          cursor = p;
        }
        const key = `${cursor.x},${cursor.z}`;
        if (seen.has(key)) break;
        seen.add(key);
      }
      expect(cursor, tree.id).toEqual(target);
    }
    process.stdout.write(
      `Integrated terrace functional receipt: ${JSON.stringify({ resources: trees.length, seeded, paths: 11, harvestRoutes: 29, unchangedHeightChecks: checked })}\n`,
    );
  }, 20000);

  it.each([
    { label: "original terrace", current, previous },
    { label: "broken ridge", current: brokenRidge, previous: current },
  ])(
    "$label keeps the actual 10-leaf allocation, changes exactly two retained 64 grids and agrees with production native worker heights",
    async ({ current, previous, label }) => {
      const old = await fixture(previous, false),
        next = await fixture(current, false);
      const quad = new TerrainQuadTree({
        resolution: 16,
        rootChunkRadius: 0,
        fineDetailRegions: createCompactPreparationDetailRegions(
          current,
          ALL_WORLD_AREAS,
          64,
        ),
      });
      const worker = new Worker(
        `const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(m,t)=>parentPort.postMessage(m,t)};${QUAD_CHUNK_WORKER_CODE};parentPort.on('message',data=>self.onmessage({data}));`,
        { eval: true, env: {} },
      );
      async function run(input: unknown) {
        return new Promise<QuadChunkWorkerOutput>((resolve, reject) => {
          const timeout = setTimeout(
            () => finish(new Error("Actual quad worker deadline")),
            5000,
          );
          const error = (e: Error) => finish(e),
            message = (m: { result?: QuadChunkWorkerOutput; error?: string }) =>
              finish(m.error ? new Error(m.error) : null, m.result);
          function finish(e: Error | null, out?: QuadChunkWorkerOutput) {
            clearTimeout(timeout);
            worker.off("error", error);
            worker.off("message", message);
            if (e) reject(e);
            else if (out) resolve(out);
            else reject(new Error("Missing worker result"));
          }
          worker.once("error", error);
          worker.once("message", message);
          worker.postMessage(input);
        });
      }
      try {
        quad.update(350, 340);
        const leaves = quad.getFinalNodes().filter((n) => n.resolution === 64);
        expect(leaves).toHaveLength(10);
        expect(
          createCompactPreparationDetailRegions(current, ALL_WORLD_AREAS, 64),
        ).toEqual(
          createCompactPreparationDetailRegions(previous, ALL_WORLD_AREAS, 64),
        );
        let triangles = 0,
          bytes = 0;
        const changed = [];
        for (const node of leaves) {
          expect(node.size).toBe(100);
          const before = generateQuadChunkDataSync(
              node.centerX,
              node.centerZ,
              100,
              64,
              old.provider,
            ),
            after = generateQuadChunkDataSync(
              node.centerX,
              node.centerZ,
              100,
              64,
              next.provider,
            );
          const a = assembleQuadChunkGeometry(before, old.provider, 15),
            b = assembleQuadChunkGeometry(after, next.provider, 15);
          try {
            expect(b.geometry.index!.array).toEqual(a.geometry.index!.array);
            expect(Object.keys(b.geometry.attributes)).toEqual(
              Object.keys(a.geometry.attributes),
            );
            triangles += b.geometry.index!.count / 3;
            bytes +=
              b.geometry.index!.array.byteLength +
              Object.values(b.geometry.attributes).reduce(
                (sum, attr) => sum + attr.array.byteLength,
                0,
              );
            let changedVertices = 0;
            for (let i = 0; i < after.heightData.length; i++)
              if (after.heightData[i] !== before.heightData[i])
                changedVertices++;
            if (!changedVertices) {
              expect(after.heightData).toEqual(before.heightData);
              continue;
            }
            const setup = next.terrain["buildGrassWorkerSetup"]();
            const native = await run({
              type: "generateQuadChunk",
              centerX: node.centerX,
              centerZ: node.centerZ,
              size: 100,
              resolution: 64,
              config: setup.terrainConfig,
              seed: setup.seed,
              biomeCenters: setup.biomeCenters,
              biomes: setup.biomes,
            });
            // Worker generates the ungraded height field. The production assembler
            // applies the same existing flat-zone blends to both paths.
            expect(native.terrainProfileIdentity).toBe(
              next.provider.terrainProfileIdentity,
            );
            const assembledNative = assembleQuadChunkGeometry(
              native,
              next.provider,
              15,
            );
            try {
              expect(assembledNative.heightData).toEqual(b.heightData);
              expect(
                assembledNative.geometry.getAttribute("position").array,
              ).toEqual(b.geometry.getAttribute("position").array);
              expect(
                assembledNative.geometry.getAttribute("normal").array,
              ).toEqual(b.geometry.getAttribute("normal").array);
              for (let iz = 0; iz < 64; iz++)
                for (let ix = 0; ix < 64; ix++) {
                  const x = node.centerX - 50 + (ix * 100) / 63,
                    z = node.centerZ - 50 + (iz * 100) / 63;
                  if (next.terrain["getFlatZoneHeight"](x, z) === null)
                    expect(native.heightData[iz * 64 + ix]).toBe(
                      after.heightData[iz * 64 + ix],
                    );
                }
            } finally {
              assembledNative.geometry.dispose();
            }
            const surface = new RetainedTerrainSurface(
              node.id,
              next.provider.terrainProfileIdentity,
              node.centerX,
              node.centerZ,
              100,
              64,
              b.geometry,
            );
            const sample: TerrainGridSample = {
              height: 0,
              nx: 0,
              ny: 0,
              nz: 0,
              faceIndex: 0,
            };
            let maxError = 0;
            let worst = [0, 0];
            for (let iz = 0; iz < 63; iz++)
              for (let ix = 0; ix < 63; ix++)
                for (const phase of [0.25, 0.5, 0.75]) {
                  const lx = -50 + ((ix + phase) * 100) / 63,
                    lz = -50 + ((iz + phase) * 100) / 63;
                  expect(surface.sample(lx, lz, sample)).toBe(true);
                  const x = node.centerX + lx,
                    z = node.centerZ + lz,
                    error = Math.abs(
                      sample.height -
                        next.terrain.getResourceGroundHeight(x, z),
                    );
                  if (error > maxError) {
                    maxError = error;
                    worst = [x, z];
                  }
                }
            changed.push({
              center: [node.centerX, node.centerZ],
              changedVertices,
              maxError,
              worst,
            });
          } finally {
            a.geometry.dispose();
            b.geometry.dispose();
          }
        }
        expect(changed.map((v) => v.center).sort()).toEqual([
          [250, 350],
          [250, 450],
        ]);
        expect({ triangles, bytes }).toEqual({
          triangles: 84420,
          bytes: 3450160,
        });
        // Exercise the existing 4 m gameplay slope stencil on the 10 m face.
        // This face remains traversable by that policy; it is not an impassable cliff.
        let maxGameplaySlope = 0,
          scarpSamples = 0;
        for (let z = 370; z <= 440; z += 5)
          for (let cross = 2; cross <= 12; cross++) {
            const x = 268 - 30 * Math.sin((Math.PI * (z - 335)) / 140) + cross;
            const slope = next.terrain["calculateSlope"](x, z);
            expect(Number.isFinite(slope)).toBe(true);
            expect(slope).toBeLessThanOrEqual(
              label === "original terrace" ? 1.5 : 2.5,
            );
            maxGameplaySlope = Math.max(maxGameplaySlope, slope);
            scarpSamples++;
          }
        // Measured whole-leaf retained-triangle residual, not a contact approval.
        const maxError = Math.max(...changed.map((v) => v.maxError));
        process.stdout.write(
          `Retained ridge diagnostic: ${JSON.stringify({ label, changed })}\n`,
        );
        if (label === "original terrace")
          expect(maxError).toBeCloseTo(0.3297780604, 4);
        else expect(maxError).toBeLessThan(0.35);
        process.stdout.write(
          `Integrated ${label} geometry receipt: ${JSON.stringify({ triangles, bytes, pitch: 100 / 63, changed, scarpSamples, maxGameplaySlope })}\n`,
        );
      } finally {
        quad.dispose();
        await worker.terminate();
      }
    },
    20000,
  );
});
